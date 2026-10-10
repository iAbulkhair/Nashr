import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { adminSignIn, jar, json, newUser, signIn, signOut } from "./helpers/session";
import { getUser, saveUser } from "@/lib/auth";
import { db } from "@/lib/db";
import type { By } from "@/lib/actor";
import { AGENT_IDS } from "@/lib/agents";
import { instructionBlocks, loadLayers } from "@/lib/agent-instructions";
import { INSTRUCTION_PLAN, PLATFORM_CHARS } from "@/lib/instructions-safety";
import { PLATFORM, activate, editBase, getLayer, isPaused, listHistory, saveDraft, setPaused, type Draft } from "@/lib/instructions-store";
import { ADMIN_SKILL_TESTS_PER_HOUR, clientIp } from "@/lib/rate";
import { addBrand, scopeFor } from "@/lib/brands";
import { SAMPLE_BRAND } from "@/lib/sample-brand";
import { ADMIN_SECTIONS, adminHref } from "@/lib/admin-gate";
import { ADMIN_SKILL_TEST_BUCKET, ADMIN_TEST_LABEL } from "@/lib/skills-admin";
import * as route from "@/app/api/admin/skills/route";

// AdminNav reads the router; outside Next there is none.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/admin/skills",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * Rules 958 and 959: the founder's skills console (agent skills portal, spec 8.2 and 10). 958: the platform layer is
 * written only through /api/admin/skills behind the founder gate, with the customer editor's rules (the same stale check,
 * the same limits, the form follows the server), every write goes to admin:log, and a workspace is opened read-only only
 * when the server's own feed names it. 959: the pause switch blanks every workspace layer and leaves the platform's, and
 * the admin test runs on the built-in sample brand without ever charging, metered under a fixed label and rate limited
 * on a server constant.
 */

// generate is replaced by a recorder; what the route hands it is the thing under test.
const gen = vi.hoisted(() => ({ calls: [] as { type: string; brand: { name: string }; extra?: string; opts: Record<string, unknown> }[], fail: false as false | "all" | "paused", state: "on" as "on" | "paused" }));
vi.mock("@/lib/noor", async (orig) => ({
  ...(await orig<typeof import("@/lib/noor")>()),
  generate: async (type: string, brand: { name: string }, _prefs: unknown, extra?: string, opts: Record<string, unknown> = {}) => {
    gen.calls.push({ type, brand, extra, opts });
    if (gen.fail === "paused") throw new (await import("@/lib/model")).ModelPaused();
    if (gen.fail === "all") throw new Error("secret model failure: sk-test-123");
    // Only the platform text in the layers tells the two calls apart, as it does for the model.
    const plat = (opts.layers as { platform: { items: { text: string }[] } | null }).platform;
    return [{ channel: "instagram", title: "t", body: plat?.items.map((i) => i.text).join("|") ?? "" }];
  },
}));
const spies = vi.hoisted(() => ({ charge: 0, chargeOnce: 0, refund: 0 }));
vi.mock("@/lib/credits", async (orig) => {
  const m = await orig<typeof import("@/lib/credits")>();
  return {
    ...m,
    charge: async (...a: Parameters<typeof m.charge>) => { spies.charge++; return (m.charge as (...x: unknown[]) => unknown)(...a); },
    chargeOnce: async (...a: Parameters<typeof m.chargeOnce>) => { spies.chargeOnce++; return (m.chargeOnce as (...x: unknown[]) => unknown)(...a); },
    refund: async (...a: Parameters<typeof m.refund>) => { spies.refund++; return (m.refund as (...x: unknown[]) => unknown)(...a); },
  };
});
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => gen.state }));

const KEY = "skills-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
// The console's key session cookie, as the page sends it (the x-admin-key header is throttled per address).
beforeEach(async () => {
  jar().clear();
  await adminSignIn();
  gen.calls.length = 0;
  gen.fail = false;
  gen.state = "on";
  spies.charge = spies.chargeOnce = spies.refund = 0;
  await db.del(`rate:${ADMIN_SKILL_TEST_BUCKET}`);
  await db.del("admin:log");
  await setPaused(false);
  await db.del("skills:platform");
  await db.del("skillshist:platform");
  await db.del("skills:feed");
});
afterEach(() => { vi.unstubAllEnvs(); vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (res: Response) => ({ status: res.status, retry: res.headers.get("retry-after"), body: (await res.json()) as Body });
const item = (text: string, extra: Partial<Draft> = {}): Draft => ({ text, agents: "all", on: true, ...extra });
const get = (qs = "") => route.GET(json(`/api/admin/skills${qs}`, "GET")).then(call);
// The page always sends the edit counter it loaded, and the route refuses a save without one: the helper sends the current one unless a test names another.
const put = async (items: unknown, extra: Body = {}) => call(await route.PUT(json("/api/admin/skills", "PUT", { items, base: await base(), ...extra })));
const post = (body: Body) => route.POST(json("/api/admin/skills", "POST", body)).then(call);
const log = async () => (await db.lrange("admin:log", 0, -1)).map((r) => JSON.parse(r) as { actor: string; email: string; what: string; before: unknown; after: unknown; at: string });
const base = async () => editBase(await getLayer(PLATFORM));
/** Save a draft with the page's own base and activate it. */
async function live(items: Draft[]) {
  expect((await put(items, { base: await base() })).status).toBe(200);
  const r = await post({ action: "activate" });
  expect(r.status).toBe(200);
  return r;
}
const FOUNDER: By = { kind: "founder", email: "a@b.example", imp: "key" };
/** A workspace with a live set, so the founder's feed names it. Returns its scope. */
async function workspace(text: string, prefix = "skw") {
  const u = await newUser(prefix);
  await saveDraft(u.email, [item(text)], FOUNDER, { platform: false });
  const a = await activate(u.email, FOUNDER, { platform: false, limits: { ...INSTRUCTION_PLAN.agency, chars: 600 } });
  if (!a.ok) throw new Error(a.error);
  return u.email;
}
const LIMITS = { ...INSTRUCTION_PLAN.agency, chars: 600 as const };

describe("rule 958: only the founder reaches /api/admin/skills", () => {
  it("rule 958: every method is 401 without the gate, for a customer session and for a wrong key, and writes nothing", async () => {
    const attempts = async () => [
      (await call(await route.GET(json("/api/admin/skills", "GET", undefined, { "x-admin-key": "wrong" })))).status,
      (await call(await route.PUT(json("/api/admin/skills", "PUT", { items: [item("x")] }, { "x-admin-key": "wrong" })))).status,
      (await call(await route.POST(json("/api/admin/skills", "POST", { action: "pause", on: true }, { "x-admin-key": "wrong" })))).status,
      (await call(await route.POST(json("/api/admin/skills", "POST", { action: "test", agent: "noor", type: "social" }, { "x-admin-key": "wrong" })))).status,
    ];
    signOut();
    expect(await attempts()).toEqual([401, 401, 401, 401]);
    // A signed-in customer, even an agency owner, is not the founder.
    const u = await newUser("not-founder");
    await saveUser({ ...(await getUser(u.email))!, plan: "agency", credits: 100 });
    await signIn(u.email);
    expect(await attempts()).toEqual([401, 401, 401, 401]);
    expect(await getLayer(PLATFORM)).toMatchObject({ draft: null, active: { v: 0 } });
    expect(await isPaused()).toBe(false);
    expect(await log()).toEqual([]);
    expect(gen.calls).toHaveLength(0);
  });

  it("rule 958: a founder signed in as themselves is let in, and the log names them", async () => {
    const u = await newUser("founder-skills");
    vi.stubEnv("ADMIN_EMAILS", u.email);
    await signIn(u.email);
    expect((await get()).status).toBe(200);
    expect((await put([item("one")])).status).toBe(200);
    expect((await log())[0]).toMatchObject({ actor: u.email, what: "skills.save" });
  });
});

describe("rule 958: the platform layer is written like the customer's, with the platform's own targets and limit", () => {
  it("rule 958: GET answers the layer, its edit base, the newest versions as counts, the feed and the switch", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, layer: { active: { items: [], v: 0 }, draft: null }, history: [], feed: [], paused: false, base: 0, chars: PLATFORM_CHARS });
    await live([item("Be kind")]);
    const after = (await get()).body;
    expect(after.history).toHaveLength(1);
    expect(after.history[0]).toMatchObject({ v: 1, count: 1, added: 1, removed: 0, changed: 0 });
    // Counts only: a version's sets are fetched with Compare.
    expect(JSON.stringify(after.history)).not.toContain("Be kind");
    expect(after.base).toBe(await base());
  });

  it("rule 958: a draft takes the eight agents, media, reviewer, judge and the lock flag; the source is admin", async () => {
    const items = [
      item("for all", { lock: true }),
      ...[...AGENT_IDS, "media", "reviewer", "judge"].map((a) => item(`for ${a}`, { agents: [a] as never })),
    ];
    const r = await put(items);
    expect(r.status).toBe(200);
    const stored = (await getLayer(PLATFORM)).draft!.items;
    expect(stored).toHaveLength(items.length);
    expect(stored[0]).toMatchObject({ lock: true, src: "admin" });
    expect(stored.map((i) => i.agents)).toContainEqual(["reviewer"]);
    expect(stored.map((i) => i.agents)).toContainEqual(["judge"]);
    expect(stored.map((i) => i.agents)).toContainEqual(["media"]);
    expect((await put([item("x", { agents: ["nobody"] as never })])).body).toMatchObject({ ok: false, error: "bad_target", index: 0 });
  });

  it("rule 958: 2000 characters are kept, 2001 are refused with the row, and nothing is saved", async () => {
    expect((await put([item("a".repeat(PLATFORM_CHARS))])).status).toBe(200);
    const bad = await put([item("fine"), item("a".repeat(PLATFORM_CHARS + 1))]);
    expect([bad.status, bad.body.error, bad.body.index]).toEqual([400, "too_long", 1]);
    expect((await getLayer(PLATFORM)).draft!.items).toHaveLength(1);
  });

  it("rule 958: a save with an old base is 409 stale and does not overwrite; a base that is not a whole number is 400", async () => {
    const first = await put([item("one")], { base: 0 });
    expect(first.status).toBe(200);
    const stale = await put([item("two")], { base: 0 });
    expect([stale.status, stale.body.error]).toEqual([409, "stale"]);
    expect((await getLayer(PLATFORM)).draft!.items[0].text).toBe("one");
    for (const b of [-1, 1.5, "0", null]) expect((await put([item("x")], { base: b })).body.error, String(b)).toBe("bad_base");
    expect((await put("nope")).body.error).toBe("bad_items");
  });

  it("rule 958: a save with no base is 400 bad_base and writes nothing, so the stale check cannot be skipped", async () => {
    const raw = async (body: Body) => call(await route.PUT(json("/api/admin/skills", "PUT", body)));
    for (const body of [{ items: [item("x")] }, { items: [item("x")], base: undefined }]) {
      const r = await raw(body);
      expect([r.status, r.body.error]).toEqual([400, "bad_base"]);
    }
    expect(await getLayer(PLATFORM)).toMatchObject({ draft: null, active: { v: 0 } });
    expect(await log()).toEqual([]);
    // With the page's base it still saves.
    expect((await raw({ items: [item("x")], base: await base() })).status).toBe(200);
  });

  it("rule 958: a header-key caller is checked once per request (one guess counted, not two), and the log names the key", async () => {
    signOut();
    const ip = clientIp(json("/api/admin/skills", "GET"));
    const count = async () => Number((await db.get(`rate:adminhdr:${ip}`)) ?? 0);
    await db.del(`rate:adminhdr:${ip}`);
    const h = { "x-admin-key": KEY };
    expect((await call(await route.GET(json("/api/admin/skills", "GET", undefined, h)))).status).toBe(200);
    expect(await count()).toBe(1);
    expect((await call(await route.PUT(json("/api/admin/skills", "PUT", { items: [item("k")], base: 0 }, h)))).status).toBe(200);
    expect(await count()).toBe(2);
    expect((await call(await route.POST(json("/api/admin/skills", "POST", { action: "pause", on: true }, h)))).status).toBe(200);
    expect(await count()).toBe(3);
    expect((await log()).map((e) => e.actor)).toEqual(["key", "key"]);
  });

  it("rule 958: activate makes the draft the next version, logs { actor, what, before, after, at } and answers the new layer and its history row", async () => {
    await put([item("Be kind", { lock: true })]);
    const r = await post({ action: "activate" });
    expect(r.status).toBe(200);
    expect(r.body.layer.active).toMatchObject({ v: 1 });
    expect(r.body.layer.draft).toBeNull();
    expect(r.body.revision).toMatchObject({ v: 1, count: 1, added: 1 });
    const l = (await log()).find((x) => x.what === "skills.activate")!;
    expect(l).toMatchObject({ actor: "key", what: "skills.activate", before: { v: 0 }, after: { v: 1, on: 1 } });
    expect(Date.parse(l.at)).not.toBeNaN();
    // Small on purpose: versions and counts, never an instruction's text.
    expect(JSON.stringify(l)).not.toContain("Be kind");
    expect((await post({ action: "activate" })).body.error).toBe("no_draft");
  });

  it("rule 958: discard, restore (with the history list and a stale-proof layer) and compare, each logged", async () => {
    await live([item("v1 text")]);
    await live([item("v2 text")]);
    const hist = await listHistory(PLATFORM);
    expect(hist).toHaveLength(2);
    const first = hist.find((h) => h.v === 1)!;

    await put([item("draft only")], { base: await base() });
    expect((await post({ action: "discard" })).body.layer.draft).toBeNull();

    const cmp = await get(`?compare=${first.id}`);
    expect(cmp.status).toBe(200);
    expect(cmp.body.diff.changed.length + cmp.body.diff.added.length + cmp.body.diff.removed.length).toBeGreaterThan(0);
    expect((await get("?compare=not-a-revision")).status).toBe(404);

    const rest = await post({ action: "restore", revisionId: first.id });
    expect(rest.status).toBe(200);
    expect(rest.body.layer.active.v).toBe(3);
    expect(rest.body.layer.active.items[0].text).toBe("v1 text");
    expect(rest.body.revision.v).toBe(3);
    expect((await post({ action: "restore", revisionId: "abcdef012345" })).status).toBe(404);
    expect((await post({ action: "restore" })).status).toBe(404);

    const whats = (await log()).map((l) => l.what);
    for (const w of ["skills.save", "skills.activate", "skills.discard", "skills.restore"]) expect(whats, w).toContain(w);
  });

  it("rule 958: an unknown action is 400 and a body that is not an object is 400, with nothing logged", async () => {
    expect((await post({ action: "delete-everything" })).body).toMatchObject({ ok: false, error: "unknown_action" });
    expect((await route.POST(json("/api/admin/skills", "POST", [1])).then(call)).status).toBe(400);
    expect((await route.POST(new Request("https://nashr.test/api/admin/skills", { method: "POST", body: "{" })).then(call)).status).toBe(400);
    expect(await log()).toEqual([]);
  });
});

describe("rule 958: the feed, and a workspace opened read-only", () => {
  it("rule 958: the feed lists who, when, which brand, the action, the version and the count, never a text", async () => {
    const scope = await workspace("secret customer wording");
    const r = await get();
    expect(r.body.feed).toHaveLength(1);
    expect(r.body.feed[0]).toMatchObject({ scope, email: scope, action: "activate", v: 1, count: 1, brand: "" });
    expect(JSON.stringify(r.body)).not.toContain("secret customer wording");
  });

  it("rule 958: the feed shows the brand's name where the account has one, the id when it is gone, and reads each account's brands once", async () => {
    const u = await newUser("skw-brands");
    const user = (await getUser(u.email))!;
    const b = await addBrand(user, "Second Roastery");
    if ("error" in b) throw new Error(b.error);
    const gone = scopeFor(u.email, "ghost1");
    for (const scope of [scopeFor(u.email, b.id), gone, u.email]) {
      await saveDraft(scope, [item(`w ${scope}`)], FOUNDER, { platform: false });
      const a = await activate(scope, FOUNDER, { platform: false, limits: LIMITS });
      if (!a.ok) throw new Error(a.error);
    }
    const spy = vi.spyOn(db, "get");
    const r = await get();
    const mine = (r.body.feed as { scope: string; brand: string }[]).filter((f) => f.scope.startsWith(u.email));
    expect(Object.fromEntries(mine.map((f) => [f.scope, f.brand]))).toEqual({ [scopeFor(u.email, b.id)]: "Second Roastery", [gone]: "ghost1", [u.email]: "" });
    // One read of `brands:{email}` for the account, not one per row.
    expect(spy.mock.calls.filter(([k]) => k === `brands:${u.email}`)).toHaveLength(1);
    spy.mockRestore();
  });

  it("rule 958: ?workspace= with a scope the feed does not name is 404, whatever the key holds", async () => {
    // A real workspace that never changed anything (so it has no feed row) is not readable either.
    const quiet = (await newUser("quiet")).email;
    await db.set(`skills:${quiet}`, { active: { items: [{ id: "abcdef012345", text: "hidden", agents: "all", on: true, src: "owner", at: new Date().toISOString() }], v: 1 }, draft: null, at: new Date().toISOString(), by: null });
    for (const s of ["", "platform", "nobody@test.example", quiet, "../etc", "a#b", "skills:platform"]) {
      const r = await get(`?workspace=${encodeURIComponent(s)}`);
      expect(r.status, s).toBe(404);
      expect(JSON.stringify(r.body), s).not.toContain("hidden");
    }
  });

  it("rule 958: ?workspace= with a feed scope answers that scope's live set only: no draft, no by.imp", async () => {
    const scope = await workspace("live wording");
    await saveDraft(scope, [item("unsent draft wording")], FOUNDER, { platform: false });
    const r = await get(`?workspace=${encodeURIComponent(scope)}`);
    expect(r.status).toBe(200);
    expect(r.body.workspace).toBe(scope);
    expect(r.body.layer.active.items.map((i: { text: string }) => i.text)).toEqual(["live wording"]);
    expect(r.body.layer.draft).toBeNull();
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("unsent draft wording");
    expect(text).not.toContain('"imp"');
    // A read writes nothing.
    expect(await log()).toEqual([]);
  });

  it("rule 958: the scope the key is built from is the feed row's, so a look-alike is never read", async () => {
    const scope = await workspace("one");
    // Same text with different case or padding is a different string: not in the feed.
    for (const s of [scope.toUpperCase(), ` ${scope}`, `${scope} `]) expect((await get(`?workspace=${encodeURIComponent(s)}`)).status, s).toBe(404);
  });
});

describe("rule 959: the pause switch", () => {
  it("rule 959: on blanks every workspace block and leaves the platform block; off brings them back; both are logged", async () => {
    await live([item("Platform standard")]);
    const scope = await workspace("Workspace wording");
    const blocks = async () => instructionBlocks(await loadLayers(scope, LIMITS, "active", ["noor"]), "noor");
    const before = await blocks();
    expect(before.workspace).toContain("Workspace wording");
    expect(before.platform).toContain("Platform standard");

    const on = await post({ action: "pause", on: true });
    expect(on.body).toMatchObject({ ok: true, paused: true });
    expect(await isPaused()).toBe(true);
    const paused = await blocks();
    expect(paused.workspace).toBe("");
    expect(paused.platform).toBe(before.platform);
    expect((await get()).body.paused).toBe(true);

    expect((await post({ action: "pause", on: false })).body.paused).toBe(false);
    expect((await blocks()).workspace).toContain("Workspace wording");

    const logged = (await log()).filter((l) => l.what === "skills.pause");
    expect(logged.map((l) => [l.before, l.after])).toEqual([[{ paused: true }, { paused: false }], [{ paused: false }, { paused: true }]]);
    expect(logged[0].actor).toBe("key");
  });

  it("rule 959: on must be a boolean; anything else is 400 and changes nothing", async () => {
    for (const on of [undefined, "true", 1, null]) expect((await post({ action: "pause", on })).body.error, String(on)).toBe("bad_request");
    expect(await isPaused()).toBe(false);
    expect(await log()).toEqual([]);
  });
});

describe("rule 959: the admin test runs on the sample brand, free, metered, and rate limited", () => {
  const test = (extra: Body = {}) => post({ action: "test", agent: "noor", type: "social", brief: "", ...extra });

  it("rule 959: the sample brand is a clearly fictional cafe with no number, link or customer in it", () => {
    expect(SAMPLE_BRAND.name).toBe("Sample Café");
    const { updatedAt, ...rest } = SAMPLE_BRAND;
    expect(Date.parse(updatedAt)).not.toBeNaN();
    for (const [k, v] of Object.entries(rest)) {
      const s = JSON.stringify(v);
      expect(s, k).not.toMatch(/\d/); // no price, percentage, year or count that could pass for a result
      expect(s, k).not.toMatch(/https?:|www\./i);
    }
    expect(SAMPLE_BRAND.website).toBe("");
    expect(SAMPLE_BRAND.offers).toBe("");
  });

  it("rule 959: with no draft it is 400 no_draft and nothing runs", async () => {
    await live([item("live")]);
    const r = await test();
    expect([r.status, r.body.error]).toEqual([400, "no_draft"]);
    expect(gen.calls).toHaveLength(0);
  });

  it("rule 959: it writes twice on the sample brand, once with the live platform set and once with the draft, and never charges", async () => {
    const owner = await newUser("bystander");
    await saveUser({ ...(await getUser(owner.email))!, plan: "agency", credits: 100 });
    await live([item("LIVE standard")]);
    await put([item("DRAFT standard")], { base: await base() });
    const r = await test({ brief: "a short note" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, spent: 0, sample: "Sample Café" });
    expect(r.body.before.body).toBe("LIVE standard");
    expect(r.body.after.body).toBe("DRAFT standard");
    expect(gen.calls).toHaveLength(2);
    for (const c of gen.calls) {
      expect(c.brand).toEqual(SAMPLE_BRAND);
      expect(c.extra).toBe("a short note");
      expect(c.opts).toMatchObject({ count: 1, crossReview: false, meter: ADMIN_TEST_LABEL });
      // The platform alone: the sample brand has no workspace layer.
      expect((c.opts.layers as { workspace: unknown }).workspace).toBeNull();
    }
    // No credit was taken from anyone, and no charging function was even called.
    expect([spies.charge, spies.chargeOnce, spies.refund]).toEqual([0, 0, 0]);
    expect((await getUser(owner.email))!.credits).toBe(100);
    // Logged: who ran it, what, small.
    const l = (await log()).find((x) => x.what === "skills.test")!;
    expect(l).toMatchObject({ actor: "key", what: "skills.test", after: { agent: "noor", type: "social" } });
    expect(JSON.stringify(l)).not.toContain("DRAFT standard");
  });

  it("rule 959: the metering label is a fixed internal one, never an account's email", () => {
    expect(ADMIN_TEST_LABEL).toMatch(/^[a-z0-9-]+@nashr\.internal$/);
  });

  it("rule 959: the type must belong to the agent and be one chat can draft; the brief is at most 500 characters", async () => {
    await put([item("x")]);
    for (const b of [{ agent: "razan", type: "social" }, { agent: "reem", type: "social" }, { agent: "nobody", type: "social" }, { agent: "noor", type: "constructor" }, { agent: "noor", type: ["social"] }, { agent: "noor", type: "pricing_review" }]) {
      const r = await test(b);
      expect([r.status, r.body.error], JSON.stringify(b)).toEqual([400, "bad_type"]);
    }
    expect((await test({ brief: "a".repeat(501) })).body.error).toBe("brief_too_long");
    expect((await test({ brief: 5 })).body.error).toBe("bad_body");
    expect(gen.calls).toHaveLength(0);
  });

  it("rule 959: a request that is refused for its body, its draft or its model takes no slot of the hourly allowance", async () => {
    const used = async () => Number((await db.get(`rate:${ADMIN_SKILL_TEST_BUCKET}`)) ?? 0);
    // No draft yet.
    expect((await test()).body.error).toBe("no_draft");
    await put([item("x")]);
    expect((await test({ agent: "razan", type: "social" })).body.error).toBe("bad_type");
    expect((await test({ brief: "a".repeat(501) })).body.error).toBe("brief_too_long");
    expect((await test({ brief: 5 })).body.error).toBe("bad_body");
    gen.state = "paused";
    expect((await test()).body.error).toBe("model_paused");
    gen.state = "on";
    expect(await used()).toBe(0);
    // A real test takes exactly one.
    expect((await test()).status).toBe(200);
    expect(await used()).toBe(1);
  });

  it("rule 959: the 31st test in an hour is 429 with Retry-After, whoever asks (the key is a server constant)", async () => {
    await put([item("x")]);
    expect(ADMIN_SKILL_TESTS_PER_HOUR).toBe(30);
    for (let i = 0; i < ADMIN_SKILL_TESTS_PER_HOUR; i++) expect((await test()).status, `test ${i + 1}`).toBe(200);
    const slow = await test();
    expect([slow.status, slow.body.error]).toEqual([429, "slow_down"]);
    expect(Number(slow.retry)).toBeGreaterThan(0);
    expect(gen.calls).toHaveLength(ADMIN_SKILL_TESTS_PER_HOUR * 2);
    // Another founder identity shares the same bucket.
    const u = await newUser("founder-two");
    vi.stubEnv("ADMIN_EMAILS", u.email);
    await signIn(u.email);
    expect((await test()).status).toBe(429);
  });

  it("rule 959: a paused model is 503 and a failed generation is 502 with the model's error text never sent; neither charges", async () => {
    await put([item("x")]);
    gen.state = "paused";
    expect([(await test()).status, (await test()).body.error]).toEqual([503, "model_paused"]);
    expect(gen.calls).toHaveLength(0);
    gen.state = "on";
    gen.fail = "all";
    const r = await test();
    expect([r.status, r.body.error]).toEqual([502, "generation_failed"]);
    expect(JSON.stringify(r.body)).not.toContain("sk-test");
    gen.fail = "paused";
    expect((await test()).status).toBe(503);
    expect([spies.charge, spies.chargeOnce, spies.refund]).toEqual([0, 0, 0]);
  });
});

describe("rule 958: the console section, its link and its page", () => {
  it("rule 958: ADMIN_SECTIONS holds skills, its link is /{lang}/admin/skills and the nav labels it in both languages", async () => {
    expect(ADMIN_SECTIONS).toContain("skills");
    expect(adminHref("en", "skills")).toBe("/en/admin/skills");
    const { ADMIN_LABEL } = await import("@/components/admin/AdminNav");
    expect(ADMIN_LABEL.en.skills).toBe("Agent skills");
    expect(ADMIN_LABEL.ar.skills).toMatch(/\S/);
    const AdminNav = (await import("@/components/admin/AdminNav")).default;
    const html = renderToStaticMarkup(createElement(AdminNav, { lang: "en", keySession: true, founder: false }));
    expect(html).toContain('href="/en/admin/skills"');
    expect(html).toContain("Agent skills");
  });

  it("rule 958: the page is a 404 without the gate and renders the panel with a key session", async () => {
    const Page = (await import("@/app/[lang]/admin/skills/page")).default as (p: { params: Promise<{ lang: string }> }) => Promise<React.ReactElement>;
    signOut();
    await expect(Page({ params: Promise.resolve({ lang: "en" }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    await adminSignIn();
    await expect(Page({ params: Promise.resolve({ lang: "xx" }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    const el = await Page({ params: Promise.resolve({ lang: "en" }) });
    const html = renderToStaticMarkup(el);
    expect(html).toContain("Agent skills");
    expect(html).toContain("Pause customer instructions");
  });

  it("rule 958: the page's props come from the server's own reads, never the request, and carry no workspace text", async () => {
    await workspace("customer wording on the feed");
    await live([item("platform wording")]);
    const Page = (await import("@/app/[lang]/admin/skills/page")).default as (p: { params: Promise<{ lang: string }> }) => Promise<React.ReactElement>;
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ lang: "en" }) }));
    expect(html).toContain("platform wording");
    expect(html).not.toContain("customer wording on the feed");
  });
});

describe("rule 958: the panel follows the customer page's rules", () => {
  const panel = readFileSync("src/components/admin/SkillsAdminPanel.tsx", "utf8");

  it("rule 958: it uses the shared editor with the lock and 2000 characters, and fetches only its own endpoint through adminFetch", () => {
    expect(panel).toContain("<InstructionEditor");
    expect(panel).toMatch(/allowLock/);
    expect(panel).toContain("PLATFORM_CHARS");
    expect(panel).toContain("adminFetch(");
    expect(panel).not.toMatch(/\bfetch\(/);
    const urls = [...panel.matchAll(/["'`](\/api\/[^"'`?]*)/g)].map((m) => m[1]);
    expect(new Set(urls)).toEqual(new Set(["/api/admin/skills"]));
    expect(panel).toMatch(/useAdminEnded\(\)/);
  });

  it("rule 958: the form follows the server after every write, and restore waits while the form has edits", () => {
    expect(panel).toContain("formAfterWrite(");
    expect(panel).toContain("restoreBlocked(dirty)");
    expect(panel).toContain("base");
    expect(panel).toMatch(/stale/);
  });

  it("rule 958: the feed has a Refresh that reads the console state again without touching the form", () => {
    expect(panel).toMatch(/refreshFeed/);
    expect(panel).toMatch(/A\.refresh\b/);
    expect(panel).toMatch(/setFeed\(/);
    const body = panel.slice(panel.indexOf("async function refreshFeed"), panel.indexOf("async function openWorkspace"));
    expect(body).not.toMatch(/adopt\(|setRows\(|setBase\(|setLayer\(/);
  });

  it("rule 959: the pause switch and a test ask through the app's own dialog, never the browser's confirm", () => {
    expect(panel).not.toMatch(/(?<![\w$])(?:window\.)?confirm\(/);
    expect(panel).toContain("useConfirm");
    expect(panel).toMatch(/action: "pause"/);
    expect(panel).toMatch(/\{confirmDialog\}/);
  });

  it("rule 958: model and customer text is plain React text or the safe renderer, never raw HTML", () => {
    const raw = [...panel.matchAll(/dangerouslySetInnerHTML/g)].length;
    expect(raw).toBeLessThanOrEqual(1);
    if (raw) expect(panel).toMatch(/__html: render\(/);
  });
});
