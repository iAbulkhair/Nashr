import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rule 796 (agent scope, Part B, spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md section 4.2):
 * the input gate on the owner's notes for a generation batch, on `POST /api/generate` and MCP `generate_content`.
 *
 * - The gate runs inside `generateBatch`, after its free refusals (paused, no brand, ended trial, missing data) and before the
 *   renewal and the charge, so a refusal charges nothing and saves nothing and an owner who is refused for a real reason reads that
 *   reason, with no classifier call spent on the way.
 * - Off: no classifier call. Shadow: the classifier is asked and a refusal is only logged; the batch runs and is charged, and the
 *   check is awaited before the batch returns on every path. Enforce: a refusal is 422 `agent_scope` with the copy (MCP: an
 *   `isError` text), and counts toward the brand scope's ceiling.
 * - The ceiling (rule 795) is read in `agentScopePreflight` and answers 429 `slow_down` with `Retry-After` (MCP: `isError`) with no
 *   classifier call, for a request that has notes. A request with no notes is never held by it.
 * - The classifier calls the gate makes are bounded per brand scope: 60 an hour and 200 a day, counted only when the classifier
 *   would be asked, so a client that cannot be charged (no credits, an agent at its cap) cannot loop on the paid classifier.
 * - Empty notes make no classifier call. The classifier reads the first characters of the notes the generator reads
 *   (`GENERATE_NOTES_READ`, one constant), and a notes value that is not a string is dropped, so neither can carry text past the gate.
 *
 * The classifier is mocked (`@/lib/agent-scope-classify`), so a test sets the verdict. The SDK mock answers a generation with one
 * item and counts the generation calls.
 */
const sdk = vi.hoisted(() => {
  const reply = (text: string) => ({ model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: "text", text }] });
  const item = { channel: "instagram", title: "قهوة اليوم", body: "نص تجريبي للعنصر يكفي للمراجعة" };
  const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };
  return { gens: 0, reply, item, verdict };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    static BadRequestError = class extends Error {};
    beta = { messages: { stream: () => ({ finalMessage: async () => { sdk.gens++; return sdk.reply(JSON.stringify([sdk.item])); } }) } };
    messages = {
      stream: () => ({ finalMessage: async () => sdk.reply("تمام") }),
      create: async (p: { system: string | { text: string }[] }) => {
        const sys = typeof p.system === "string" ? p.system : p.system[0].text;
        return sys.startsWith("You are the quality judge") ? sdk.reply(JSON.stringify([sdk.verdict])) : sdk.reply(JSON.stringify([{ ok: true }]));
      },
    };
  },
}));
const modelSwitch = vi.hoisted(() => ({ state: "on" as "on" | "paused" }));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => modelSwitch.state }));
type Seen = { input: { kind: string; text: string; agent: string; brand: { name: string; industry: string }; otherBrands: string[]; lang: string }; o: { deadline?: number } };
const cls = vi.hoisted(() => ({ verdict: "in" as string, error: null as null | string, calls: [] as Seen[], delayMs: 0, onCall: null as null | (() => Promise<void>) }));
vi.mock("@/lib/agent-scope-classify", async (orig) => {
  const m = await orig<typeof import("@/lib/agent-scope-classify")>();
  return {
    ...m,
    classify: async (input: Seen["input"], o: Seen["o"] = {}) => {
      cls.calls.push({ input, o });
      await cls.onCall?.();
      if (cls.delayMs) await new Promise((r) => setTimeout(r, cls.delayMs));
      return cls.error ? { ok: false, error: cls.error } : { ok: true, verdict: cls.verdict };
    },
  };
});
// What the route hands `generateBatch`, while the real pipeline runs.
const batches = vi.hoisted(() => ({ opts: [] as Record<string, unknown>[] }));
vi.mock("@/lib/generate-batch", async (orig) => {
  const real = await orig<typeof import("@/lib/generate-batch")>();
  return {
    ...real,
    generateBatch: (...a: Parameters<typeof real.generateBatch>) => {
      batches.opts.push(a[2] as unknown as Record<string, unknown>);
      return real.generateBatch(...a);
    },
  };
});

import { getUser, saveUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { listTasks, type Brand } from "@/lib/brand";
import { saveBrands } from "@/lib/brands";
import { createMcpToken } from "@/lib/mcp";
import { TASK_COST } from "@/lib/tasks";
import { AGENT_SCOPE_GEN_CHECKS_PER_DAY, AGENT_SCOPE_GEN_CHECKS_PER_HOUR } from "@/lib/rate";
import { scopeRefusalText } from "@/lib/scope-refusal";
import { NO_CART_DATA } from "@/lib/cart-recovery";
import { saveGov } from "@/lib/governance";
import { AGENT_SCOPE_KEYS, GENERATE_NOTES_READ, agentScopeRefusalText, agentScopeSlowText, type AgentScopeLogEntry, type AgentScopeMode } from "@/lib/agent-scope";
import { json, newUser, settle, signIn } from "./helpers/session";
import * as generateRoute from "@/app/api/generate/route";
import * as mcpRoute from "@/app/api/mcp/route";

const BRAND: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "رخيص", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const setModes = (input: AgentScopeMode) => db.set(AGENT_SCOPE_KEYS.modes, { prompt: "on", input, role: "off", output: "off" });
const hourKey = (scope: string) => `rate:agent-scope:h:${scope}`;
const dayKey = (scope: string) => `rate:agent-scope:d:${scope}`;
const genHourKey = (scope: string) => `rate:agent-scope-gen:h:${scope}`;
const genDayKey = (scope: string) => `rate:agent-scope-gen:d:${scope}`;
const day = () => new Date().toISOString().slice(0, 10);
/** This account's lines in today's log (the log is global; other accounts' lines are left out). */
const logOf = async (email: string) => (await db.lrange(AGENT_SCOPE_KEYS.log(day()), 0, -1)).map((r) => JSON.parse(r) as AgentScopeLogEntry).filter((e) => e.email === email);
const counter = async (key: string) => Number((await db.get<number | string>(key)) ?? 0);
const credits = async (email: string) => (await getUser(email))!.credits;
/** What a free refusal needs: an owner whose trial ended, one with no brand file, one with no credits. */
const endTrial = async (u: User) => saveUser({ ...(await getUser(u.email))!, trialEnds: new Date(Date.now() - 864e5).toISOString() });
const drain = async (u: User) => saveUser({ ...(await getUser(u.email))!, credits: 0 });
async function noBrand(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await signIn(u.email);
  const back = (await getUser(u.email))!;
  back.scope = back.email;
  return back;
}

/** An owner with a brand file, signed in, re-read so the object carries the stored balance and the scope the routes read. */
async function owner(prefix: string, lang: "ar" | "en" = "ar"): Promise<User> {
  const u = await newUser(prefix);
  await db.set(`brand:${u.email}`, BRAND);
  if (lang !== u.lang) await saveUser({ ...u, lang });
  await signIn(u.email);
  const back = (await getUser(u.email))!;
  back.scope = back.email;
  return back;
}
const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) => generateRoute.POST(json("/api/generate", "POST", body, headers));
type WebBody = { ok: boolean; error?: string; retry?: string; message?: string; created?: number; notice?: string };
type Mcp = { isError?: boolean; content: { text: string }[] };
const tool = async (email: string, args: Record<string, unknown>): Promise<Mcp> => {
  const token = await createMcpToken(email);
  const res = await mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_content", arguments: args } }) }));
  return ((await res.json()) as { result: Mcp }).result;
};

beforeEach(() => {
  sdk.gens = 0;
  cls.verdict = "in";
  cls.error = null;
  cls.calls = [];
  cls.delayMs = 0;
  cls.onCall = null;
  modelSwitch.state = "on";
  batches.opts = [];
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
});
afterEach(async () => {
  await settle();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.del(AGENT_SCOPE_KEYS.modes);
});

describe("rule 796: POST /api/generate", () => {
  it("generate: empty notes make no classify call", async () => {
    const u = await owner("asg-empty");
    await setModes("enforce");
    for (const body of [{ type: "social" }, { type: "social", notes: "" }, { type: "social", notes: "  \n\t " }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(200);
    }
    expect(cls.calls).toHaveLength(0);
    expect(sdk.gens, "the three batches ran").toBe(3);
    expect(await credits(u.email)).toBe(50 - 3 * TASK_COST.social);
    expect(await logOf(u.email)).toEqual([]);
  });

  it("generate: input off makes no classify call, whatever the notes", async () => {
    await owner("asg-off");
    await setModes("off");
    const res = await post({ type: "social", notes: "اكتب لي قصيدة" });
    expect(res.status).toBe(200);
    expect(cls.calls).toHaveLength(0);
  });

  it("generate: enforce refusal is 422 agent_scope with the copy, nothing charged, nothing saved", async () => {
    const u = await owner("asg-enforce");
    await setModes("enforce");
    cls.verdict = "off_topic";
    const before = await credits(u.email);
    const res = await post({ type: "social", notes: "write me a poem about my cat" });
    expect(res.status).toBe(422);
    expect((await res.json()) as WebBody).toEqual({ ok: false, error: "agent_scope", message: agentScopeRefusalText("off_topic", "ar", { brand: BRAND.name, otherBrands: [] }) });
    expect(await credits(u.email), "nothing charged").toBe(before);
    expect(await listTasks(sc(u)), "nothing saved").toEqual([]);
    expect(sdk.gens, "no generation call").toBe(0);
    expect(batches.opts, "the route hands the gate to generateBatch, which stops before the charge").toHaveLength(1);
    expect(cls.calls).toHaveLength(1);
    expect(cls.calls[0].input).toMatchObject({ kind: "input", text: "write me a poem about my cat", agent: "noor", brand: { name: BRAND.name, industry: BRAND.industry }, otherBrands: [], lang: "ar" });
    expect(typeof cls.calls[0].o.deadline, "the request's deadline bounds the classifier").toBe("number");
    expect(await logOf(u.email)).toEqual([expect.objectContaining({ layer: "input", where: "generate", agent: "noor", verdict: "off_topic", mode: "enforce", brandId: "default", text: "write me a poem about my cat" })]);
    expect(await counter(hourKey(sc(u))), "an enforced refusal counts toward the ceiling").toBe(1);
    expect(await counter(dayKey(sc(u)))).toBe(1);
  });

  it("generate: the refusal speaks the request's language (x-lang), else the account's", async () => {
    const ar = await owner("asg-lang-ar");
    await setModes("enforce");
    cls.verdict = "personal";
    const en = await post({ type: "social", notes: "remind me of my dentist" }, { "x-lang": "en" });
    expect(en.status).toBe(422);
    expect(((await en.json()) as WebBody).message).toBe(agentScopeRefusalText("personal", "en", { brand: BRAND.name, otherBrands: [] }));
    expect(cls.calls[0].input.lang).toBe("en");
    const own = await post({ type: "social", notes: "remind me of my dentist" });
    expect(((await own.json()) as WebBody).message).toBe(agentScopeRefusalText("personal", "ar", { brand: BRAND.name, otherBrands: [] }));
    expect(cls.calls[1].input.lang).toBe("ar");
    const u = await owner("asg-lang-en", "en");
    const acct = await post({ type: "social", notes: "remind me of my dentist" });
    expect(((await acct.json()) as WebBody).message).toBe(agentScopeRefusalText("personal", "en", { brand: BRAND.name, otherBrands: [] }));
    expect(ar.email).not.toBe(u.email);
  });

  it("generate: shadow refusal runs the batch and logs", async () => {
    const u = await owner("asg-shadow");
    await setModes("shadow");
    cls.verdict = "personal";
    const res = await post({ type: "social", notes: "remind me of my dentist" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WebBody).created).toBe(1);
    expect(sdk.gens).toBe(1);
    expect(await credits(u.email), "charged like any batch").toBe(50 - TASK_COST.social);
    expect(await listTasks(sc(u))).toHaveLength(1);
    expect(await logOf(u.email)).toEqual([expect.objectContaining({ layer: "input", where: "generate", verdict: "personal", mode: "shadow" })]);
    expect(await counter(hourKey(sc(u))), "shadow never counts").toBe(0);
  });

  it("generate: an `in` verdict runs the batch; the classifier is given the owning agent, the brands, the language and the notes", async () => {
    const u = await owner("asg-in");
    await saveBrands(u.email, [
      { id: "default", name: "", createdAt: new Date().toISOString(), status: "active" },
      { id: "b2", name: "Bakery Two", createdAt: new Date().toISOString(), status: "active" },
    ]);
    await setModes("enforce");
    const res = await post({ type: "weekly_report", notes: "ركز على مبيعات الأسبوع" }, { "x-lang": "en" });
    expect(res.status).toBe(200);
    expect(cls.calls).toHaveLength(1);
    // Dana owns the report types; the default brand's name is read from the brand file, so it is not listed as "other".
    expect(cls.calls[0].input).toMatchObject({ kind: "input", text: "ركز على مبيعات الأسبوع", agent: "dana", brand: { name: BRAND.name, industry: BRAND.industry }, otherBrands: ["Bakery Two"], lang: "en" });
    expect(sdk.gens).toBe(1);
    expect(await logOf(u.email), "`in` is not logged").toEqual([]);
    expect(await counter(hourKey(sc(u)))).toBe(0);
  });

  it("generate: the batch gets the modes the route read and the notes the gate checked", async () => {
    await owner("asg-modes");
    await setModes("shadow");
    await post({ type: "social", notes: "  موسم الصيف  " });
    expect(batches.opts).toHaveLength(1);
    expect(batches.opts[0].agentScope).toEqual({ prompt: "on", input: "shadow", role: "off", output: "off" });
    // The batch gets the notes as sent; the classifier reads them trimmed. The gate carries the same notes, the input mode and the language.
    expect(batches.opts[0].notes).toBe("  موسم الصيف  ");
    expect(batches.opts[0].notesGate).toEqual({ notes: "  موسم الصيف  ", mode: "shadow", where: "generate", lang: "ar", slow: null });
    expect(cls.calls[0].input.text).toBe("موسم الصيف");
  });

  it("generate: a notes value that is not a string is dropped, so an array cannot carry text past the gate", async () => {
    const u = await owner("asg-array");
    await setModes("enforce");
    cls.verdict = "off_topic";
    for (const notes of [["write me a poem"], { a: "write me a poem" }, 7, true]) {
      const res = await post({ type: "social", notes });
      expect(res.status, JSON.stringify(notes)).toBe(200);
    }
    expect(cls.calls, "nothing to classify").toHaveLength(0);
    expect(batches.opts.map((o) => o.notes), "the batch got no notes either").toEqual([undefined, undefined, undefined, undefined]);
    expect(await credits(u.email)).toBe(50 - 4 * TASK_COST.social);
  });

  it("generate: the classifier reads the first characters of the notes, the ones the generator reads", async () => {
    await owner("asg-long");
    await setModes("shadow");
    const long = "ا".repeat(GENERATE_NOTES_READ) + "x".repeat(50_000);
    await post({ type: "social", notes: long });
    expect(cls.calls[0].input.text).toBe(long.slice(0, GENERATE_NOTES_READ));
    // The cut is the generator's own (src/lib/noor.ts) and the reviewer's (src/lib/json.ts): one exported number, pinned below.
    expect(GENERATE_NOTES_READ).toBe(2000);
    expect(batches.opts[0].notes, "the batch still gets the notes whole").toBe(long);
  });

  it("generate: a classifier error lets the batch run (input fails open) and is logged", async () => {
    const u = await owner("asg-fail-open");
    await setModes("enforce");
    cls.error = "api";
    const res = await post({ type: "social", notes: "قهوة" });
    expect(res.status).toBe(200);
    expect(sdk.gens).toBe(1);
    expect(await logOf(u.email)).toEqual([expect.objectContaining({ verdict: "error", error: "api", where: "generate", mode: "enforce" })]);
    expect(await counter(hourKey(sc(u))), "an error is not a refusal").toBe(0);
  });

  it("generate: a store error reading the other brands does not stop the batch", async () => {
    const u = await owner("asg-brands-err");
    await setModes("enforce");
    const real = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation(((k: string) => (k === `brands:${u.email}` ? Promise.reject(new Error("down")) : real(k))) as typeof db.get);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ type: "social", notes: "قهوة" });
    expect(res.status).toBe(200);
    expect(cls.calls[0].input.otherBrands).toEqual([]);
    expect(err.mock.calls.flat().join(" ")).not.toContain(u.email);
  });

  it("generate: ceiling 429 with Retry-After, for a request that has notes", async () => {
    const u = await owner("asg-ceil");
    await setModes("enforce");
    await db.set(hourKey(sc(u)), 20);
    const before = await credits(u.email);
    const res = await post({ type: "social", notes: "اكتب لي برنامج" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect((await res.json()) as WebBody).toEqual({ ok: false, error: "slow_down", retry: "hour", message: agentScopeSlowText("ar") });
    expect(cls.calls, "no classifier call").toHaveLength(0);
    expect(sdk.gens).toBe(0);
    expect(await credits(u.email)).toBe(before);
    expect(await listTasks(sc(u))).toEqual([]);
    // The day's wait is the longer one.
    await db.set(dayKey(sc(u)), 60);
    const day429 = await post({ type: "social", notes: "اكتب لي برنامج" }, { "x-lang": "en" });
    expect(day429.status).toBe(429);
    expect(day429.headers.get("Retry-After")).toBe("86400");
    expect((await day429.json()) as WebBody).toEqual({ ok: false, error: "slow_down", retry: "day", message: agentScopeSlowText("en") });
    expect(cls.calls).toHaveLength(0);
  });

  it("generate: a spent ceiling never holds a request with no notes (absent, empty, blank)", async () => {
    const u = await owner("asg-ceil-empty");
    await setModes("enforce");
    await Promise.all([db.set(hourKey(sc(u)), 20), db.set(dayKey(sc(u)), 60)]);
    for (const body of [{ type: "social" }, { type: "social", notes: "" }, { type: "social", notes: " \n " }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(200);
    }
    expect(cls.calls).toHaveLength(0);
    expect(sdk.gens).toBe(3);
    expect(await credits(u.email)).toBe(50 - 3 * TASK_COST.social);
  });

  it("generate: the ceiling holds only in enforce", async () => {
    const u = await owner("asg-ceil-shadow");
    await db.set(hourKey(sc(u)), 20);
    for (const mode of ["shadow", "off"] as const) {
      await setModes(mode);
      expect((await post({ type: "social", notes: "قهوة" })).status, mode).toBe(200);
    }
  });

  it("generate: an unknown type is refused as before, ahead of the preflight and the gate", async () => {
    const u = await owner("asg-badtype");
    await setModes("enforce");
    await db.set(hourKey(sc(u)), 20);
    const res = await post({ type: "nonsense", notes: "اكتب لي برنامج" });
    expect(res.status).toBe(400);
    expect((await res.json()) as WebBody).toEqual({ ok: false, error: "bad_type" });
    expect(cls.calls).toHaveLength(0);
  });
});

describe("rule 796: MCP generate_content", () => {
  it("mcp generate_content: enforce refusal is an isError text", async () => {
    const u = await owner("asg-mcp-enforce");
    await setModes("enforce");
    cls.verdict = "pro_advice";
    const before = await credits(u.email);
    const r = await tool(u.email, { type: "social", notes: "is this contract legal?" });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: agentScopeRefusalText("pro_advice", "ar", { brand: BRAND.name, otherBrands: [] }) }]);
    expect(await credits(u.email), "nothing charged").toBe(before);
    expect(await listTasks(sc(u)), "nothing saved").toEqual([]);
    expect(sdk.gens).toBe(0);
    expect(batches.opts, "generateBatch stops at the gate, before the charge").toHaveLength(1);
    expect(cls.calls[0].input).toMatchObject({ kind: "input", text: "is this contract legal?", agent: "noor", brand: { name: BRAND.name, industry: BRAND.industry }, lang: "ar" });
    expect(await logOf(u.email)).toEqual([expect.objectContaining({ layer: "input", where: "mcp_generate", verdict: "pro_advice", mode: "enforce" })]);
    expect(await counter(hourKey(sc(u)))).toBe(1);
  });

  it("mcp generate_content: the refusal speaks the account's language", async () => {
    const u = await owner("asg-mcp-en", "en");
    await setModes("enforce");
    cls.verdict = "other_business";
    const r = await tool(u.email, { type: "social", notes: "ads for my cousin's shop" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(agentScopeRefusalText("other_business", "en", { brand: BRAND.name, otherBrands: [] }));
    expect(cls.calls[0].input.lang).toBe("en");
  });

  it("mcp generate_content: shadow refusal runs the batch and logs; `in` runs it too; the batch gets the modes", async () => {
    const u = await owner("asg-mcp-shadow");
    await setModes("shadow");
    cls.verdict = "personal";
    const r = await tool(u.email, { type: "social", notes: "remind me of my dentist" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^Created 1 social item\(s\)/);
    expect(await credits(u.email)).toBe(50 - TASK_COST.social);
    expect(await logOf(u.email)).toEqual([expect.objectContaining({ where: "mcp_generate", verdict: "personal", mode: "shadow" })]);
    expect(batches.opts[0].agentScope).toEqual({ prompt: "on", input: "shadow", role: "off", output: "off" });
    cls.verdict = "in";
    await setModes("enforce");
    expect((await tool(u.email, { type: "social", notes: "قهوة" })).isError).toBeUndefined();
    expect(sdk.gens).toBe(2);
  });

  it("mcp generate_content: empty notes make no classify call; an absent or non-string notes value is read as empty", async () => {
    const u = await owner("asg-mcp-empty");
    await setModes("enforce");
    for (const args of [{ type: "social" }, { type: "social", notes: "" }, { type: "social", notes: "   " }]) {
      expect((await tool(u.email, args)).isError, JSON.stringify(args)).toBeUndefined();
    }
    expect(cls.calls).toHaveLength(0);
    expect(sdk.gens).toBe(3);
  });

  it("mcp generate_content: a non-string notes value is read as its text, which the gate checks", async () => {
    const u = await owner("asg-mcp-array");
    await setModes("enforce");
    cls.verdict = "off_topic";
    // `String(["x"])` is "x": what the generator would read is what the gate reads.
    const r = await tool(u.email, { type: "social", notes: ["write me a poem"] });
    expect(r.isError).toBe(true);
    expect(cls.calls[0].input.text).toBe("write me a poem");
    expect(sdk.gens).toBe(0);
  });

  it("mcp generate_content: the classifier reads the first characters of the notes", async () => {
    const u = await owner("asg-mcp-long");
    await setModes("shadow");
    const long = "ا".repeat(GENERATE_NOTES_READ) + "x".repeat(50_000);
    await tool(u.email, { type: "social", notes: long });
    expect(cls.calls[0].input.text).toBe(long.slice(0, GENERATE_NOTES_READ));
    expect(batches.opts[0].notes).toBe(long);
  });

  it("mcp generate_content: ceiling is an isError text with no classifier call, for a request that has notes", async () => {
    const u = await owner("asg-mcp-ceil");
    await setModes("enforce");
    await db.set(hourKey(sc(u)), 20);
    const before = await credits(u.email);
    const r = await tool(u.email, { type: "social", notes: "اكتب لي برنامج" });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: agentScopeSlowText("ar") }]);
    expect(cls.calls).toHaveLength(0);
    expect(sdk.gens).toBe(0);
    expect(await credits(u.email)).toBe(before);
    // No notes: never held by the ceiling.
    expect((await tool(u.email, { type: "social" })).isError).toBeUndefined();
    expect((await tool(u.email, { type: "social", notes: "  " })).isError).toBeUndefined();
    expect(cls.calls).toHaveLength(0);
  });

  it("mcp generate_content: an unknown type is refused as before, ahead of the preflight and the gate", async () => {
    const u = await owner("asg-mcp-badtype");
    await setModes("enforce");
    await db.set(hourKey(sc(u)), 20);
    const r = await tool(u.email, { type: "nonsense", notes: "اكتب لي برنامج" });
    expect(r).toEqual({ content: [{ type: "text", text: "Unknown type." }], isError: true });
    expect(cls.calls).toHaveLength(0);
  });

  it("mcp generate_content: a classifier error lets the batch run", async () => {
    const u = await owner("asg-mcp-fail-open");
    await setModes("enforce");
    cls.error = "timeout";
    const r = await tool(u.email, { type: "social", notes: "قهوة" });
    expect(r.isError).toBeUndefined();
    expect(await logOf(u.email)).toEqual([expect.objectContaining({ verdict: "error", error: "timeout", where: "mcp_generate" })]);
  });
});

describe("rule 796: the gate sits inside generateBatch, after the free refusals", () => {
  const NOTES = "اكتب لي برنامج";
  const quiet = async (u: User) => {
    expect(cls.calls, "no classifier call").toHaveLength(0);
    expect(await logOf(u.email), "no log line").toEqual([]);
    expect(await counter(genHourKey(sc(u))), "no gate counter").toBe(0);
    expect(await counter(genDayKey(sc(u)))).toBe(0);
    expect(sdk.gens).toBe(0);
  };

  it("generate: an ended trial reads trial_over (402), in enforce and in shadow, with no classifier call", async () => {
    for (const mode of ["enforce", "shadow"] as const) {
      const u = await owner(`asg-trial-${mode}`);
      await endTrial(u);
      await setModes(mode);
      cls.verdict = "off_topic";
      const res = await post({ type: "social", notes: NOTES });
      expect(res.status, mode).toBe(402);
      expect(await res.json(), mode).toEqual({ ok: false, error: "trial_over" });
      await quiet(u);
    }
  });

  it("generate: no brand file reads no_brand (400), a missing cart store reads the missing-data answer (409), no classifier call", async () => {
    await setModes("enforce");
    cls.verdict = "off_topic";
    const bare = await noBrand("asg-nobrand");
    const nb = await post({ type: "social", notes: NOTES });
    expect(nb.status).toBe(400);
    expect(await nb.json()).toEqual({ ok: false, error: "no_brand" });
    await quiet(bare);
    const u = await owner("asg-nocart");
    const mc = await post({ type: "cart_recovery", notes: NOTES });
    expect(mc.status).toBe(409);
    expect(await mc.json()).toEqual({ ok: false, error: NO_CART_DATA });
    await quiet(u);
  });

  it("mcp generate_content: trial_over, no_brand and a paused model read their own text, with no classifier call", async () => {
    await setModes("enforce");
    cls.verdict = "off_topic";
    const t = await owner("asg-mcp-trial");
    await endTrial(t);
    expect(await tool(t.email, { type: "social", notes: NOTES })).toEqual({ content: [{ type: "text", text: "The trial has ended. Subscribe in the app to keep generating." }], isError: true });
    await quiet(t);
    const bare = await noBrand("asg-mcp-nobrand");
    expect(await tool(bare.email, { type: "social", notes: NOTES })).toEqual({ content: [{ type: "text", text: "No brand file yet. Run onboarding in the app first." }], isError: true });
    await quiet(bare);
    const p = await owner("asg-mcp-paused");
    modelSwitch.state = "paused";
    expect(await tool(p.email, { type: "social", notes: NOTES })).toEqual({ content: [{ type: "text", text: "Content generation is paused for now. No credits were used." }], isError: true });
    await quiet(p);
  });

  it("mcp generate_content: a missing cart store reads its own text, with no classifier call", async () => {
    await setModes("enforce");
    const u = await owner("asg-mcp-nocart");
    const r = await tool(u.email, { type: "cart_recovery", notes: NOTES });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^No abandoned-cart data yet/);
    await quiet(u);
  });

  it("enforce: the classifier runs before the charge, and a refusal leaves the balance as it was", async () => {
    const u = await owner("asg-before-charge");
    await setModes("enforce");
    let seen = -1;
    cls.onCall = async () => { seen = await credits(u.email); };
    expect((await post({ type: "social", notes: NOTES })).status).toBe(200);
    expect(seen, "nothing was charged when the classifier was asked").toBe(50);
    expect(await credits(u.email)).toBe(50 - TASK_COST.social);
  });

  it("shadow: the check is awaited before the answer, on a batch that runs and on one refused at the charge", async () => {
    cls.delayMs = 300;
    cls.verdict = "off_topic";
    await setModes("shadow");
    const ok = await owner("asg-await-ok");
    expect((await post({ type: "social", notes: NOTES })).status).toBe(200);
    expect(await logOf(ok.email), "logged by the time the answer is here").toHaveLength(1);
    const broke = await owner("asg-await-broke");
    await drain(broke);
    const t0 = Date.now();
    expect((await post({ type: "social", notes: NOTES })).status).toBe(402);
    expect(Date.now() - t0, "the refusal waited for the check").toBeGreaterThanOrEqual(250);
    expect(await logOf(broke.email)).toHaveLength(1);
    const m = await owner("asg-await-mcp");
    expect((await tool(m.email, { type: "social", notes: NOTES })).isError).toBeUndefined();
    expect(await logOf(m.email)).toHaveLength(1);
  });
});

describe("rule 796: the classifier calls of the gate are bounded per scope", () => {
  const NOTES = "اكتب لي برنامج";

  it("the bound is 60 an hour and 200 a day", () => {
    expect(AGENT_SCOPE_GEN_CHECKS_PER_HOUR).toBe(60);
    expect(AGENT_SCOPE_GEN_CHECKS_PER_DAY).toBe(200);
  });

  it("shadow, no credits: 60 classifier calls, and the 61st asks nothing and still reads no_credits", async () => {
    const u = await owner("asg-bound-shadow");
    await drain(u);
    await setModes("shadow");
    cls.verdict = "off_topic";
    for (let i = 0; i < AGENT_SCOPE_GEN_CHECKS_PER_HOUR; i++) {
      const res = await post({ type: "social", notes: NOTES });
      expect(res.status, `request ${i + 1}`).toBe(402);
      expect(((await res.json()) as WebBody).error).toBe("no_credits");
    }
    expect(cls.calls).toHaveLength(AGENT_SCOPE_GEN_CHECKS_PER_HOUR);
    expect(await counter(genHourKey(sc(u)))).toBe(AGENT_SCOPE_GEN_CHECKS_PER_HOUR);
    const over = await post({ type: "social", notes: NOTES });
    expect(over.status).toBe(402);
    expect(((await over.json()) as WebBody).error, "the batch path goes on to its own refusal").toBe("no_credits");
    expect(cls.calls, "the 61st asked nothing").toHaveLength(AGENT_SCOPE_GEN_CHECKS_PER_HOUR);
    expect(await logOf(u.email), "and logged nothing").toHaveLength(AGENT_SCOPE_GEN_CHECKS_PER_HOUR);
    expect(sdk.gens).toBe(0);
  });

  it("shadow, an agent at its cap: the gate is asked while the bound allows, then the cap still answers without a call", async () => {
    const u = await owner("asg-bound-cap");
    await saveGov(u.email, { agentCaps: { noor: 0 } });
    await setModes("shadow");
    const first = await post({ type: "social", notes: NOTES });
    expect(first.status).toBe(402);
    expect(((await first.json()) as WebBody).error).toBe("agent_cap");
    expect(cls.calls).toHaveLength(1);
    await db.set(genHourKey(sc(u)), AGENT_SCOPE_GEN_CHECKS_PER_HOUR);
    const over = await post({ type: "social", notes: NOTES });
    expect(((await over.json()) as WebBody).error).toBe("agent_cap");
    expect(cls.calls).toHaveLength(1);
  });

  it("enforce: over the hour it is 429 slow_down with the hour's Retry-After, over the day the day's; no classifier call", async () => {
    const u = await owner("asg-bound-enforce");
    await setModes("enforce");
    await db.set(genHourKey(sc(u)), AGENT_SCOPE_GEN_CHECKS_PER_HOUR);
    const before = await credits(u.email);
    const hour = await post({ type: "social", notes: NOTES });
    expect(hour.status).toBe(429);
    expect(hour.headers.get("Retry-After")).toBe("3600");
    expect((await hour.json()) as WebBody).toEqual({ ok: false, error: "slow_down", retry: "hour", message: agentScopeSlowText("ar") });
    expect(cls.calls).toHaveLength(0);
    // Both windows spent: the day is named, the longer wait.
    await db.set(genDayKey(sc(u)), AGENT_SCOPE_GEN_CHECKS_PER_DAY);
    const day = await post({ type: "social", notes: NOTES }, { "x-lang": "en" });
    expect(day.status).toBe(429);
    expect(day.headers.get("Retry-After")).toBe("86400");
    expect((await day.json()) as WebBody).toEqual({ ok: false, error: "slow_down", retry: "day", message: agentScopeSlowText("en") });
    expect(cls.calls).toHaveLength(0);
    expect(await credits(u.email)).toBe(before);
    expect(sdk.gens).toBe(0);
  });

  it("enforce: the bound lets 60 through and counts every asked request", async () => {
    const u = await owner("asg-bound-edge");
    await setModes("enforce");
    await db.set(genHourKey(sc(u)), AGENT_SCOPE_GEN_CHECKS_PER_HOUR - 1);
    expect((await post({ type: "social", notes: NOTES })).status, "the 60th is asked").toBe(200);
    expect(cls.calls).toHaveLength(1);
    expect((await post({ type: "social", notes: NOTES })).status, "the 61st is held").toBe(429);
    expect(cls.calls).toHaveLength(1);
  });

  it("only a request that would ask the classifier is counted: not off, not empty notes, not a free refusal", async () => {
    const u = await owner("asg-bound-count");
    await setModes("off");
    await post({ type: "social", notes: NOTES });
    await setModes("enforce");
    await post({ type: "social" });
    await post({ type: "social", notes: "  " });
    expect(await counter(genHourKey(sc(u)))).toBe(0);
    expect(await counter(genDayKey(sc(u)))).toBe(0);
    await post({ type: "social", notes: NOTES });
    expect(await counter(genHourKey(sc(u)))).toBe(1);
    expect(await counter(genDayKey(sc(u)))).toBe(1);
    expect(cls.calls).toHaveLength(1);
  });

  it("a bound counter that cannot be written lets the check run (input fails open) and prints only the error's name", async () => {
    const u = await owner("asg-bound-err");
    await setModes("enforce");
    const real = db.incrby.bind(db);
    vi.spyOn(db, "incrby").mockImplementation(((k: string, n: number) => (k.startsWith("rate:agent-scope-gen:") ? Promise.reject(new Error(`down ${u.email}`)) : real(k, n))) as typeof db.incrby);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ type: "social", notes: NOTES });
    expect(res.status).toBe(200);
    expect(cls.calls).toHaveLength(1);
    expect(err.mock.calls.flat().join(" ")).not.toContain(u.email);
  });

  it("each scope has its own count", async () => {
    const a = await owner("asg-bound-a");
    const b = await owner("asg-bound-b");
    await setModes("enforce");
    await db.set(genHourKey(sc(a)), AGENT_SCOPE_GEN_CHECKS_PER_HOUR);
    expect((await post({ type: "social", notes: NOTES })).status, "b is the signed-in owner").toBe(200);
    expect(await counter(genHourKey(sc(b)))).toBe(1);
    expect(await counter(genHourKey(sc(a)))).toBe(AGENT_SCOPE_GEN_CHECKS_PER_HOUR);
  });

  it("mcp generate_content: shadow skips the classifier over the bound and runs the batch; enforce is an isError text", async () => {
    const u = await owner("asg-bound-mcp");
    await db.set(genHourKey(sc(u)), AGENT_SCOPE_GEN_CHECKS_PER_HOUR);
    await setModes("shadow");
    cls.verdict = "off_topic";
    const ran = await tool(u.email, { type: "social", notes: NOTES });
    expect(ran.isError).toBeUndefined();
    expect(cls.calls).toHaveLength(0);
    expect(await logOf(u.email)).toEqual([]);
    await setModes("enforce");
    const held = await tool(u.email, { type: "social", notes: NOTES });
    expect(held).toEqual({ content: [{ type: "text", text: agentScopeSlowText("ar") }], isError: true });
    expect(cls.calls).toHaveLength(0);
    expect(await credits(u.email)).toBe(50 - TASK_COST.social);
  });
});

describe("rule 796: where the routes, the batch and the panels put the gate", () => {
  const src = (f: string) => readFileSync(f, "utf8");
  const order = (s: string, needles: string[]) => {
    const at = needles.map((n) => {
      const i = s.indexOf(n);
      expect(i, n).toBeGreaterThan(-1);
      return i;
    });
    expect([...at].sort((a, b) => a - b), needles.join(" < ")).toEqual(at);
  };

  it("the generate route: type check, preflight, then generateBatch with the gate; no gate call of its own", () => {
    const s = src("src/app/api/generate/route.ts");
    order(s, ["isTaskType(b.type)", "agentScopePreflight(u)", "await generateBatch("]);
    expect(s).not.toContain("checkGenerationNotes(");
    expect(s).toMatch(/notesGate: \{ notes: notes \?\? "", mode: pre\.modes\.input, where: "generate", lang, slow: pre\.slow \}/);
    expect(s).toMatch(/generateBatch\(u, sc\(u\), \{[^\n]*agentScope: pre\.modes/);
    expect(s).toMatch(/case "agent_scope": return NextResponse\.json\(\{ ok: false, error: "agent_scope", message: r\.message \}, \{ status: 422 \}\)/);
    expect(s).toMatch(/case "agent_scope_slow": return retryLater\(\{ ok: false, error: "slow_down", retry: r\.retry, message: agentScopeSlowText\(lang\) \}, WINDOW\[r\.retry\]\)/);
    expect(s).not.toContain("if (pre.slow)");
  });

  it("MCP generate_content: type check, preflight, then generateBatch with the gate; no gate call of its own", () => {
    const s = src("src/app/api/mcp/route.ts");
    const g = s.slice(s.indexOf('case "generate_content"'), s.indexOf('case "list_inbox"'));
    order(g, ["isTaskType(args.type)", "agentScopePreflight(user)", "await generateBatch("]);
    expect(g).not.toContain("checkGenerationNotes(");
    expect(g).toMatch(/notesGate: \{ notes, mode: pre\.modes\.input, where: "mcp_generate", lang, slow: pre\.slow \}/);
    expect(g).toMatch(/generateBatch\(user, [^\n]*agentScope: pre\.modes/);
    expect(g).toMatch(/case "agent_scope": return ok\(id, \{ \.\.\.text\(r\.message\), isError: true \}\)/);
    expect(g).toMatch(/case "agent_scope_slow": return ok\(id, \{ \.\.\.text\(agentScopeSlowText\(lang\)\), isError: true \}\)/);
    expect(g).not.toContain("if (pre.slow)");
  });

  it("generateBatch: the gate comes after paused, no brand, trial, missing data and before the renewal and the charge, on the batch's own brand read", () => {
    const s = src("src/lib/generate-batch.ts");
    const body = s.slice(s.indexOf("async function runBatch("));
    order(body, ['modelState() === "paused"', 'reason: "no_brand"', "trialOver(user)", "missingData(type, scope)", "checkGenerationNotes(", "renewalDue(user)", "chargeOnce(user.email"]);
    expect(s.match(/getBrand\(/g), "one brand read: the gate is given it").toHaveLength(1);
    expect(s).toMatch(/checkGenerationNotes\(user, type, gate, brand, opts\.deadline\)/);
    // The shadow check runs beside the batch and is awaited on every path.
    expect(s).toMatch(/finally \{\s*await Promise\.allSettled\(late\);/);
    expect(s).toMatch(/agentScope\?: AgentScopeModes;/);
    expect(s).toMatch(/notesGate\?: NotesGate;/);
  });

  it("one constant for the characters of the notes the generator reads: noor.ts, json.ts and the gate use it, and no literal 2000 is left at those sites", () => {
    expect(GENERATE_NOTES_READ).toBe(2000);
    const noor = src("src/lib/noor.ts");
    const json = src("src/lib/json.ts");
    expect(noor).toMatch(/extra\.slice\(0, GENERATE_NOTES_READ\)/);
    expect(json).toMatch(/g\.notes\?\.slice\(0, GENERATE_NOTES_READ\)/);
    expect(noor).not.toMatch(/slice\(0, 2000\)/);
    expect(json).not.toMatch(/slice\(0, 2000\)/);
    expect(src("src/lib/agent-scope.ts")).toMatch(/slice\(0, GENERATE_NOTES_READ\)/);
    expect(src("src/lib/notes-read.ts")).toMatch(/export const GENERATE_NOTES_READ = 2000;/);
  });

  it("scopeRefusalText reads the message of an agent_scope or slow_down answer and nothing else", () => {
    expect(scopeRefusalText({ error: "agent_scope", message: "x" })).toBe("x");
    expect(scopeRefusalText({ error: "slow_down", message: "y" })).toBe("y");
    expect(scopeRefusalText({ error: "agent_scope" })).toBeNull();
    expect(scopeRefusalText({ error: "agent_scope", message: "" })).toBeNull();
    expect(scopeRefusalText({ error: "agent_scope", message: 7 })).toBeNull();
    expect(scopeRefusalText({ error: "no_credits", message: "z" })).toBeNull();
    expect(scopeRefusalText({})).toBeNull();
    expect(src("src/lib/scope-refusal.ts"), "client-safe: imports nothing").not.toMatch(/^import /m);
  });

  it("both panels that post to /api/generate show the message as text, through the one helper", () => {
    const g = src("src/components/app/GeneratePanel.tsx");
    expect(g).toMatch(/message\?: string/);
    expect(g).toMatch(/scopeRefusalText\(j\)/);
    expect(g).not.toMatch(/dangerouslySetInnerHTML/);
    const r = src("src/components/app/ReportsPanel.tsx");
    expect(r).toMatch(/import \{ scopeRefusalText \} from "@\/lib\/scope-refusal"/);
    // The report generate button and the cart-recovery draft button: both posts.
    expect(r.match(/fetch\("\/api\/generate"/g)).toHaveLength(2);
    expect(r.match(/scopeRefusalText\(j\)/g), "one read after each post").toHaveLength(2);
    expect(r).toMatch(/message\?: string/);
  });
});
