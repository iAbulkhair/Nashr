import { beforeEach, describe, expect, it, vi } from "vitest";
import { json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { currentUser, getUser, saveUser, sc, type User } from "@/lib/auth";
import { agentSpendFor, monthKey } from "@/lib/credits";
import { listActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { listTasks, type Brand } from "@/lib/brand";
import { saveGov } from "@/lib/governance";
import { writeFile } from "@/lib/files";
import { countCost } from "@/lib/generate-batch";
import { creditsFor } from "@/lib/models/credits";
import { generateRouteFor } from "@/lib/models/overrides";
import { INSTRUCTION_TESTS_PER_DAY, INSTRUCTION_TESTS_PER_HOUR } from "@/lib/rate";
import { TASK_COST, type TaskType } from "@/lib/tasks";
import type { GenOptions } from "@/lib/noor";
import * as layerRoute from "@/app/api/instructions/route";
import * as activateRoute from "@/app/api/instructions/activate/route";
import * as testRoute from "@/app/api/instructions/test/route";

/**
 * Rule 952: "Test this instruction" (agent skills portal, spec 11) writes one item with the live instructions and one with
 * the draft, side by side, and is the only way these routes spend credits. Spending takes an explicit `confirm: true`
 * and a nonce the page makes per click; the claim on the nonce comes before the charge, so a double click, a replay or
 * two requests at once charge once. The two generations are metered and never reach the inbox, the judge or learning.
 * `generate` is replaced here by a recorder: what the route hands it is the thing under test.
 */
const gen = vi.hoisted(() => ({ calls: [] as { type: string; extra?: string; opts: Record<string, unknown> }[], fail: false as false | "all" | "second" | "paused", state: "on" as "on" | "paused" }));
vi.mock("@/lib/noor", async (orig) => ({
  ...(await orig<typeof import("@/lib/noor")>()),
  generate: async (type: string, _brand: unknown, _prefs: unknown, extra?: string, opts: Record<string, unknown> = {}) => {
    gen.calls.push({ type, extra, opts });
    if (gen.fail === "paused") throw new (await import("@/lib/model")).ModelPaused();
    if (gen.fail === "all" || (gen.fail === "second" && gen.calls.length === 2)) throw new Error("secret model failure: sk-test-123");
    // Only the instruction text in the layers tells the two calls apart, as it does for the model.
    const ws = (opts.layers as { workspace: { items: { text: string }[] } | null }).workspace;
    return [{ channel: "instagram", title: "t", body: ws?.items.map((i) => i.text).join("|") ?? "" }];
  },
}));
// charge and refund are wrapped, never replaced: `onCharge` sees the world at the moment of the charge, `refundFails` makes the give-back throw.
const probe = vi.hoisted(() => ({ onCharge: null as null | (() => Promise<void>), refundFails: false }));
vi.mock("@/lib/credits", async (orig) => {
  const m = await orig<typeof import("@/lib/credits")>();
  return {
    ...m,
    charge: async (...a: Parameters<typeof m.charge>) => { await probe.onCharge?.(); return (m.charge as (...x: unknown[]) => unknown)(...a); },
    refund: async (...a: Parameters<typeof m.refund>) => { if (probe.refundFails) throw new Error("ledger down for hejazy@gmail.com"); return m.refund(...a); },
  };
});
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => gen.state }));

const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "" } as unknown as Brand;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (res: Response) => ({ status: res.status, retry: res.headers.get("retry-after"), body: (await res.json()) as Body });
let nonceN = 0;
const nonce = () => `nonce-${++nonceN}-${Math.random().toString(36).slice(2, 10)}`;
const run = (body: Body = {}) => testRoute.POST(json("/api/instructions/test", "POST", { agent: "noor", type: "social", brief: "", confirm: true, nonce: nonce(), ...body })).then(call);
const item = (text: string, extra: Body = {}) => ({ text, agents: "all", on: true, ...extra });
const put = (items: unknown[]) => layerRoute.PUT(json("/api/instructions", "PUT", { items })).then(call);
const activate = () => (activateRoute.POST as unknown as (r: Request) => Promise<Response>)(json("/api/instructions/activate", "POST", {})).then(call);
const credits = async (email: string) => (await getUser(email))!.credits;

/** An agency owner with a brand file, 100 credits, a live set ("LIVE") and a draft ("DRAFT"). */
async function owner(prefix = "itest", withDraft = true): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...u, plan: "agency", credits: 100 });
  await db.set(`brand:${u.email}`, brand);
  await signIn(u.email);
  expect((await put([item("LIVE")])).status).toBe(200);
  expect((await activate()).status).toBe(200);
  if (withDraft) expect((await put([item("DRAFT")])).status).toBe(200);
  return (await getUser(u.email))!;
}
/** The price the spec names: two items of the type, at the brand's model. */
const priceOf = async (u: User, type: TaskType = "social") => {
  const m = generateRouteFor(u, brand, type).model;
  return 2 * creditsFor(countCost(type, 1), m, "generate", type);
};

beforeEach(() => {
  gen.calls.length = 0;
  gen.fail = false;
  gen.state = "on";
  probe.onCharge = null;
  probe.refundFails = false;
});

describe("rule 952: who may test, and the order of the checks", () => {
  it("rule 952: 401 without a session, 403 for a plain member, and nothing is charged or generated", async () => {
    const u = await owner();
    signOut();
    expect((await run()).status).toBe(401);
    const m = await newMember(u, "member");
    await signIn(m.email);
    const r = await run();
    expect(r.status).toBe(403);
    expect(gen.calls).toHaveLength(0);
    expect(await credits(u.email)).toBe(100);
  });

  it("rule 952: an admin member may test, and is charged to the account", async () => {
    const u = await owner();
    const a = await newMember(u, "admin");
    await signIn(a.email);
    const r = await run();
    expect(r.status).toBe(200);
    expect(await credits(u.email)).toBe(100 - r.body.spent);
  });

  it("rule 952: without confirm: true (absent, false, the string \"true\", 1) it is 400 confirm_required, nothing is charged, nothing is generated", async () => {
    const u = await owner();
    for (const confirm of [undefined, false, "true", 1, null]) {
      const r = await run({ confirm });
      expect([r.status, r.body.error]).toEqual([400, "confirm_required"]);
    }
    expect(await credits(u.email)).toBe(100);
    expect(gen.calls).toHaveLength(0);
  });

  it("rule 952: a type the agent does not own, Reem, an unknown agent or type, a type with no 'draft items' path is 400 bad_type", async () => {
    const u = await owner();
    const bad: Body[] = [
      { agent: "razan", type: "social" }, // Noor's type, another agent's name
      { agent: "dana", type: "ads" },
      { agent: "reem", type: "social" },
      { agent: "reem", type: "reem" },
      { agent: "nobody", type: "social" },
      { agent: "constructor", type: "social" },
      { agent: "noor", type: "constructor" },
      { agent: "noor", type: "pricing_review" }, // not a draft_items type
      { agent: "noor", type: ["social"] },
      { agent: 5, type: "social" },
    ];
    for (const b of bad) {
      const r = await run(b);
      expect([r.status, r.body.error, JSON.stringify(b)]).toEqual([400, "bad_type", JSON.stringify(b)]);
    }
    expect(await credits(u.email)).toBe(100);
    expect(gen.calls).toHaveLength(0);
  });

  it("rule 952: every type chat's draft_items may draft works, with the agent that owns it (all four are Noor's today; the route takes the owner from agentForTask)", async () => {
    await owner();
    const { agentForTask } = await import("@/lib/agents");
    for (const type of ["social", "whatsapp", "ads", "gbp"] as const) {
      const r = await run({ agent: agentForTask(type).id, type });
      expect([type, r.status]).toEqual([type, 200]);
    }
  });

  it("rule 952: a brief of 501 characters is 400 brief_too_long, one of 500 passes; a non-string brief is refused", async () => {
    const u = await owner();
    expect((await run({ brief: "x".repeat(501) })).body).toMatchObject({ ok: false, error: "brief_too_long" });
    expect((await run({ brief: "ا".repeat(501) })).status).toBe(400);
    expect((await run({ brief: { a: 1 } })).status).toBe(400);
    expect(await credits(u.email)).toBe(100);
    expect((await run({ brief: "x".repeat(500) })).status).toBe(200);
  });

  it("rule 952: the nonce must match ^[A-Za-z0-9_-]{8,64}$ (400 bad_nonce, nothing claimed)", async () => {
    const u = await owner();
    for (const n of [undefined, "", "short", "x".repeat(65), "has space 123", "bad:colon:1234", "slash/slash1234", 12345678, ["abcdefgh"]]) {
      const r = await run({ nonce: n });
      expect([r.status, r.body.error]).toEqual([400, "bad_nonce"]);
    }
    expect(await credits(u.email)).toBe(100);
    expect((await run({ nonce: "A_b-c_d-" + "9".repeat(56) })).status).toBe(200);
  });

  it("rule 952: with no draft the answer is 400 no_draft and nothing is charged", async () => {
    const u = await owner("itest-nd", false);
    const r = await run();
    expect([r.status, r.body.error]).toEqual([400, "no_draft"]);
    expect(await credits(u.email)).toBe(100);
    expect(gen.calls).toHaveLength(0);
  });

  it("rule 952: a body that is not an object is 400 and the workspace is always the caller's (a scope, email or brandId in the body is ignored)", async () => {
    const u = await owner();
    const other = await owner("itest-other");
    await signIn(u.email);
    const r = await run({ scope: other.email, email: other.email, brandId: "x" });
    expect(r.status).toBe(200);
    expect(await credits(other.email)).toBe(100);
    expect(await credits(u.email)).toBe(100 - r.body.spent);
    const raw = await testRoute.POST(new Request("https://nashr.test/api/instructions/test", { method: "POST", body: "not json" })).then(call);
    expect(raw.status).toBe(400);
  });

  it("rule 952: while the model is paused it is 503 model_paused before any claim or charge", async () => {
    const u = await owner();
    gen.state = "paused";
    const n = nonce();
    const r = await run({ nonce: n });
    expect([r.status, r.body.error]).toEqual([503, "model_paused"]);
    expect(await credits(u.email)).toBe(100);
    gen.state = "on";
    expect((await run({ nonce: n })).status).toBe(200);
  });
});

describe("rule 952: the price and the charge", () => {
  it("rule 952: the price is 2 x creditsFor(countCost(type, 1)) and the balance drops by exactly that; spent says so", async () => {
    const u = await owner();
    const want = await priceOf(u);
    expect(want).toBeGreaterThanOrEqual(2);
    expect(want).toBeLessThan(2 * TASK_COST.social);
    const r = await run();
    expect(r.status).toBe(200);
    expect(r.body.spent).toBe(want);
    expect(await credits(u.email)).toBe(100 - want);
    // The agent's monthly counter (the owner's cap) moves with it.
    expect(agentSpendFor((await getUser(u.email))!, sc(u)).noor).toBe(want);
  });

  it("rule 952: the answer is { ok, before, after, spent } with the live set's item before and the draft's after", async () => {
    await owner();
    const r = await run();
    expect(r.body).toMatchObject({ ok: true, before: { channel: "instagram", body: "LIVE" }, after: { channel: "instagram", body: "DRAFT" } });
    expect(Object.keys(r.body).sort()).toEqual(["after", "before", "ok", "spent"]);
  });

  it("rule 952: not enough credits is 402 no_credits, nothing generated, the balance untouched, and the same nonce may be used again after a top-up", async () => {
    const u = await owner();
    const want = await priceOf(u);
    await saveUser({ ...(await getUser(u.email))!, credits: want - 1 });
    const n = nonce();
    const r = await run({ nonce: n });
    expect([r.status, r.body.error]).toEqual([402, "no_credits"]);
    expect(gen.calls).toHaveLength(0);
    expect(await credits(u.email)).toBe(want - 1);
    await saveUser({ ...(await getUser(u.email))!, credits: want });
    const again = await run({ nonce: n });
    expect(again.status).toBe(200);
    expect(await credits(u.email)).toBe(0);
  });

  it("rule 952: the agent's monthly cap the owner set is honoured: at the cap it is 402 agent_cap and nothing is charged", async () => {
    const u = await owner();
    await saveGov(sc(u), { agentCaps: { noor: 1 } });
    const r = await run();
    expect([r.status, r.body.error]).toEqual([402, "agent_cap"]);
    expect(gen.calls).toHaveLength(0);
    expect(await credits(u.email)).toBe(100);
  });
});

describe("rule 952: one charge per click", () => {
  it("rule 952: the same nonce twice in sequence is one 200 and one 409 duplicate, and one charge", async () => {
    const u = await owner();
    const n = nonce();
    const first = await run({ nonce: n });
    const second = await run({ nonce: n });
    expect([first.status, second.status, second.body.error]).toEqual([200, 409, "duplicate"]);
    expect(await credits(u.email)).toBe(100 - first.body.spent);
    expect(gen.calls).toHaveLength(2);
  });

  it("rule 952: the same nonce twice at once (Promise.all) is one 200 and one 409, one charge, two generations", async () => {
    const u = await owner();
    const n = nonce();
    const rs = await Promise.all([run({ nonce: n }), run({ nonce: n })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error).toBe("duplicate");
    const ok = rs.find((r) => r.status === 200)!;
    expect(await credits(u.email)).toBe(100 - ok.body.spent);
    expect(gen.calls).toHaveLength(2);
  });

  it("rule 952: five clicks at once with the same nonce charge once; different nonces charge each", async () => {
    const u = await owner();
    const n = nonce();
    const same = await Promise.all([1, 2, 3, 4, 5].map(() => run({ nonce: n })));
    expect(same.filter((r) => r.status === 200)).toHaveLength(1);
    expect(same.filter((r) => r.status === 409)).toHaveLength(4);
    const spent = same.find((r) => r.status === 200)!.body.spent;
    expect(await credits(u.email)).toBe(100 - spent);
    const two = await Promise.all([run(), run()]);
    expect(two.map((r) => r.status)).toEqual([200, 200]);
    expect(await credits(u.email)).toBe(100 - 3 * spent);
  });

  it("rule 952: a nonce is claimed per workspace: the same string from another workspace is not a duplicate", async () => {
    const a = await owner("itest-a");
    const n = nonce();
    expect((await run({ nonce: n })).status).toBe(200);
    const b = await owner("itest-b");
    await signIn(b.email);
    expect((await run({ nonce: n })).status).toBe(200);
    expect(await credits(a.email)).toBeLessThan(100);
  });

  it("rule 952: the claim key is skilltest:{scope}:{nonce} (the caller's scope) and expires after 600 seconds", async () => {
    const u = await owner();
    const n = nonce();
    const seen: { key: string; ttl: number }[] = [];
    const spy = vi.spyOn(db, "setNx").mockImplementation(async (key: string, _v: unknown, ttl: number) => { seen.push({ key, ttl }); return true; });
    try {
      expect((await run({ nonce: n })).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([{ key: `skilltest:${sc((await currentUser())!)}:${n}`, ttl: 600 }]);
    expect(u.email).toBe(sc((await currentUser())!));
  });
});

describe("rule 952: what the two generations are", () => {
  it("rule 952: both get count 1, cross-review off, the reviewer as the governance sets it, the account's meter, and the owner's layers (live for before, draft for after)", async () => {
    const u = await owner();
    const r = await run({ brief: "Ramadan offer, short" });
    expect(r.status).toBe(200);
    expect(gen.calls).toHaveLength(2);
    const by = (text: string) => gen.calls.find((c) => (c.opts as GenOptions).layers?.workspace?.items[0].text === text)!;
    for (const c of gen.calls) {
      expect(c.type).toBe("social");
      expect(c.opts).toMatchObject({ count: 1, crossReview: false, reviewer: true, meter: u.email });
      // The brief is data for the owner's-notes slot, never part of a system text.
      expect(c.extra).toBe("Ramadan offer, short");
    }
    expect(by("LIVE")).toBeDefined();
    expect(by("DRAFT")).toBeDefined();
    expect(by("LIVE")).not.toBe(by("DRAFT"));
  });

  it("rule 952: the reviewer follows gov.reviewer, off included", async () => {
    const u = await owner();
    await saveGov(sc(u), { reviewer: false });
    await run();
    expect(gen.calls.map((c) => c.opts.reviewer)).toEqual([false, false]);
  });

  it("rule 952: an empty brief passes no notes; the model is the one the brand's routing gives, the same for both", async () => {
    const u = await owner();
    await run({ brief: "   " });
    expect(gen.calls.map((c) => c.extra)).toEqual([undefined, undefined]);
    const model = generateRouteFor(u, brand, "social").model;
    expect(gen.calls.map((c) => c.opts.model)).toEqual([model, model]);
  });

  it("rule 952: the reference files of the items load for both sets (the owning agent is named to loadLayers)", async () => {
    const u = await owner("itest-refs", false);
    await writeFile(u.email, "tone.md", "Warm, never pushy.", "user");
    expect((await put([item("LIVE", { refs: ["tone.md"] })])).status).toBe(200);
    expect((await activate()).status).toBe(200);
    expect((await put([item("DRAFT", { refs: ["tone.md"] })])).status).toBe(200);
    await run();
    for (const c of gen.calls) expect((c.opts as GenOptions).layers?.refs).toEqual({ "tone.md": "Warm, never pushy." });
  });

  it("rule 952: nothing reaches the inbox, on success or on failure", async () => {
    const u = await owner();
    const before = await listTasks(sc(u));
    expect((await run()).status).toBe(200);
    gen.fail = "all";
    expect((await run()).status).toBe(502);
    expect(await listTasks(sc(u))).toEqual(before);
  });
});

describe("rule 952: a failure after the charge gives it back exactly", () => {
  it("rule 952: a generation that throws refunds the balance and the agent's monthly counter, and says nothing of the model's error", async () => {
    const u = await owner();
    gen.fail = "all";
    const n = nonce();
    const r = await run({ nonce: n });
    expect([r.status, r.body.ok, r.body.error]).toEqual([502, false, "generation_failed"]);
    expect(JSON.stringify(r.body)).not.toMatch(/secret|sk-test|model failure/);
    const after = (await getUser(u.email))!;
    expect(after.credits).toBe(100);
    expect(agentSpendFor(after, sc(u)).noor ?? 0).toBe(0);
    // The claim stays after a refunded failure: a retry is a new click with a new nonce.
    gen.fail = false;
    expect((await run({ nonce: n })).status).toBe(409);
    expect((await run()).status).toBe(200);
  });

  it("rule 952: when only one of the two generations throws the whole charge still comes back", async () => {
    const u = await owner();
    gen.fail = "second";
    const r = await run();
    expect(r.status).toBe(502);
    expect(gen.calls).toHaveLength(2);
    expect(await credits(u.email)).toBe(100);
  });

  it("rule 952: the paused-model throw from generate refunds too (503 model_paused)", async () => {
    const u = await owner();
    gen.fail = "paused";
    const r = await run();
    expect([r.status, r.body.error]).toEqual([503, "model_paused"]);
    expect(await credits(u.email)).toBe(100);
  });
});

describe("rule 952: rate limits", () => {
  it("rule 952: the 11th test in an hour is 429 with Retry-After 3600, counted per workspace and before the body is read", async () => {
    const u = await owner();
    await saveUser({ ...(await getUser(u.email))!, credits: 100000 });
    for (let i = 0; i < INSTRUCTION_TESTS_PER_HOUR; i++) expect((await run()).status).toBe(200);
    const r = await run();
    expect([r.status, r.retry, r.body.error]).toEqual([429, "3600", "slow_down"]);
    // Refused before any claim or charge: the balance moved only for the ten.
    expect(gen.calls).toHaveLength(2 * INSTRUCTION_TESTS_PER_HOUR);
    // Another workspace has its own allowance.
    const other = await owner("itest-rate2");
    await signIn(other.email);
    expect((await run()).status).toBe(200);
  });

  it("rule 952: the day allowance (30) holds too, with Retry-After 86400", async () => {
    const u = await owner();
    await saveUser({ ...(await getUser(u.email))!, credits: 100000 });
    await db.set(`rate:instr:t:h:${sc(u)}`, 0, 3600);
    await db.set(`rate:instr:t:d:${sc(u)}`, INSTRUCTION_TESTS_PER_DAY, 86400);
    const r = await run();
    expect([r.status, r.retry]).toEqual([429, "86400"]);
    expect(gen.calls).toHaveLength(0);
  });

  it("rule 952: a caller refused by the role is not counted against the allowance", async () => {
    const u = await owner();
    const m = await newMember(u, "member");
    await signIn(m.email);
    for (let i = 0; i < INSTRUCTION_TESTS_PER_HOUR + 2; i++) expect((await run()).status).toBe(403);
    await signIn(u.email);
    expect((await run()).status).toBe(200);
  });
});

describe("rule 952: the order claim, charge; the activity log; the model pick", () => {
  it("rule 952: the claim exists when charge is called (claim before charge), and a lost claim never reaches charge", async () => {
    const u = await owner();
    const n = nonce();
    const key = `skilltest:${sc(u)}:${n}`;
    const seen: unknown[] = [];
    probe.onCharge = async () => { seen.push(await db.get(key)); };
    expect((await run({ nonce: n })).status).toBe(200);
    expect(seen).toEqual(["1"]);
    // The duplicate answers 409 without reaching the ledger.
    expect((await run({ nonce: n })).status).toBe(409);
    expect(seen).toHaveLength(1);
  });

  it("rule 952: the spend is one row of the owner's activity log (instructions_tested, credits taken, the agent, who), and a refunded failure leaves none", async () => {
    const u = await owner();
    const r = await run();
    const rows = (await listActivity(sc(u))).rows.filter((x) => x.kind === "instructions_tested");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "instructions_tested", agent: "noor", type: "social", via: "app", count: 2, credits: r.body.spent, note: "instruction test", by: { kind: "owner" } });
    gen.fail = "all";
    expect((await run()).status).toBe(502);
    expect((await listActivity(sc(u))).rows.filter((x) => x.kind === "instructions_tested")).toHaveLength(1);
  });

  it("rule 952: a refusal at the charge is a no_credits / cap_reached row with what the test would have cost, as generateBatch writes it", async () => {
    const u = await owner();
    const want = await priceOf(u);
    await saveUser({ ...(await getUser(u.email))!, credits: 0 });
    expect((await run()).status).toBe(402);
    const noCredits = (await listActivity(sc(u))).rows.filter((x) => x.kind === "no_credits");
    expect(noCredits).toHaveLength(1);
    expect(noCredits[0]).toMatchObject({ agent: "noor", type: "social", via: "app", credits: want, note: "instruction test" });
    await saveUser({ ...(await getUser(u.email))!, credits: 100 });
    await saveGov(sc(u), { agentCaps: { noor: 1 } });
    expect((await run()).body.error).toBe("agent_cap");
    const capped = (await listActivity(sc(u))).rows.filter((x) => x.kind === "cap_reached");
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({ agent: "noor", credits: want, outcome: "0/1" });
    expect((await listActivity(sc(u))).rows.some((x) => x.kind === "instructions_tested")).toBe(false);
  });

  it("rule 952: the type's stats are passed as generateBatch passes them (empty for a draft type: no read is made)", async () => {
    await owner();
    await run();
    for (const c of gen.calls) expect(c.opts).toHaveProperty("stats", "");
  });

  it("rule 952: a brand's pick of another tier is priced at that tier, and both generations run on it", async () => {
    const u = await owner();
    // WhatsApp on Opus costs more than on the automatic writer (the prices are small: the rounding shows it on this type).
    const auto = await priceOf(u, "whatsapp");
    await db.set(`brand:${u.email}`, { ...brand, model: "claude-opus-5-5" });
    expect(generateRouteFor(u, { model: "claude-opus-5-5" } as Brand, "whatsapp")).toMatchObject({ model: "claude-opus-5-5", overridden: true });
    const want = 2 * creditsFor(countCost("whatsapp", 1), "claude-opus-5-5", "generate", "whatsapp");
    expect(want).toBeGreaterThan(auto);
    const r = await run({ type: "whatsapp" });
    expect(r.body.spent).toBe(want);
    expect(await credits(u.email)).toBe(100 - want);
    expect(gen.calls.map((c) => c.opts.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
  });

  it("rule 952: a pick the router refuses falls back to Automatic at Automatic's price and is counted for the console", async () => {
    const u = await owner();
    const auto = await priceOf(u);
    await db.set(`brand:${u.email}`, { ...brand, model: "claude-haiku-5-5" }); // not offered as a pick
    const key = `usage:_all:${monthKey()}:pickreject:generate:not_pickable`;
    const before = Number((await db.get(key)) ?? 0);
    const r = await run();
    expect(r.body.spent).toBe(auto);
    expect(gen.calls[0].opts.model).toBe(generateRouteFor(u, brand, "social").model);
    expect(Number((await db.get(key)) ?? 0)).toBe(before + 1);
  });

  it("rule 952: when the give-back itself fails the answer is 500 refund_failed and the log carries the amount, never the email or the error text", async () => {
    const u = await owner();
    gen.fail = "all";
    probe.refundFails = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run();
    } finally {
      probe.refundFails = false;
    }
    const logged = JSON.stringify(spy.mock.calls);
    spy.mockRestore();
    expect([r.status, r.body.error]).toEqual([500, "refund_failed"]);
    expect(logged).toContain(String(await priceOf(u)));
    expect(logged).not.toContain(u.email);
    expect(logged).not.toContain("hejazy@gmail.com");
    expect(logged).not.toContain("sk-test");
  });
});
