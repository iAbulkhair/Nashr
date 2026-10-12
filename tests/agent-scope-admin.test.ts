import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rules 1412-1413 (agent scope, Part B, Task 8; plan "Labelled set, eval, modes route and founder panel", spec section 11).
 *
 * - 1412: the hand-written set (`src/lib/agent-scope-set.json`) has the composition the plan sets; `scoreAgentScope` passes at
 *   95% refusals caught and 2% wrong refusals and not one case past either edge; `POST /api/admin/agent-scope/modes` is the
 *   founder's only writer of the modes and lets `input` or `output` go to `enforce` only after a passed eval on the
 *   classifier's current model; `POST /api/admin/agent-scope/eval` is founder only, 503 when the model is not on, stores the
 *   result. The classifier is mocked: no test here calls the paid model.
 * - 1413: `GET /api/admin/agent-scope` (founder only) answers the modes, the last eval, the day's log and the month's
 *   classifier counters; a bad `day` reads today. The Quality section renders the panel.
 */
const st = vi.hoisted(() => ({ state: "on" as "on" | "paused" | "mock", calls: 0, answer: null as null | ((text: string) => string) }));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => st.state }));
vi.mock("@/lib/agent-scope-classify", async (orig) => ({
  ...(await orig<typeof import("@/lib/agent-scope-classify")>()),
  classify: async (input: { text: string }) => {
    st.calls++;
    return st.answer ? { ok: true, verdict: st.answer(input.text) } : { ok: false, error: "api" };
  },
}));

import { adminSignIn, jar, json, newUser, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { monthKey } from "@/lib/credits";
import { AGENT_IDS } from "@/lib/agents";
import { AGENT_SCOPE_DEFAULT_MODES, AGENT_SCOPE_KEYS, VERDICTS, readAgentScopeModes, type AgentScopeLogEntry, type Verdict } from "@/lib/agent-scope";
import { agentScopeModel, type Classified } from "@/lib/agent-scope-classify";
import { AGENT_SCOPE_MAX_WRONG, AGENT_SCOPE_MIN_RECALL, AGENT_SCOPE_SET, scoreAgentScope, type AgentScopeCase, type AgentScopeEval } from "@/lib/agent-scope-eval";
import * as overview from "@/app/api/admin/agent-scope/route";
import * as modesRoute from "@/app/api/admin/agent-scope/modes/route";
import * as evalRoute from "@/app/api/admin/agent-scope/eval/route";

const KEY = "agent-scope-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
beforeEach(async () => {
  st.state = "on";
  st.calls = 0;
  st.answer = null;
  jar().clear();
  await Promise.all([db.del(AGENT_SCOPE_KEYS.modes), db.del(AGENT_SCOPE_KEYS.evalLast), db.del(AGENT_SCOPE_KEYS.evalLock)]);
});

const setModes = (body: unknown) => modesRoute.POST(json("/api/admin/agent-scope/modes", "POST", body));
const runEval = () => evalRoute.POST(json("/api/admin/agent-scope/eval", "POST", {}));
const getPanel = (q = "") => overview.GET(json(`/api/admin/agent-scope${q}`, "GET"));
const passed = (model = agentScopeModel()): AgentScopeEval => ({ at: new Date().toISOString(), model, total: 200, errors: 0, recall: 0.97, wrongRefusals: 0.01, passed: true, byVerdict: Object.fromEntries(VERDICTS.map((v) => [v, { n: 1, caught: 1, exact: 1 }])) as AgentScopeEval["byVerdict"] });

describe("rule 1412: the labelled set", () => {
  const set = AGENT_SCOPE_SET;
  const by = (f: (c: AgentScopeCase) => boolean) => set.filter(f).length;
  it("at least 200 cases, every verdict, every agent, both languages, ids unique, at least 15 greeting/help cases labelled in", () => {
    expect(set.length).toBeGreaterThanOrEqual(200);
    expect(new Set(set.map((c) => c.id)).size).toBe(set.length);
    const min: Record<Verdict, number> = { in: 100, off_topic: 25, pro_advice: 20, other_business: 20, personal: 20, other_brand: 15 };
    for (const v of VERDICTS) expect(by((c) => c.expected === v), v).toBeGreaterThanOrEqual(min[v]);
    for (const a of AGENT_IDS) expect(by((c) => c.agent === a), a).toBeGreaterThanOrEqual(10);
    for (const l of ["ar", "en"] as const) expect(by((c) => c.lang === l) / set.length, l).toBeGreaterThan(0.4);
    expect(by((c) => (c.edge === "greeting" || c.edge === "help") && c.expected === "in")).toBeGreaterThanOrEqual(15);
    expect(by((c) => (c.edge === "greeting" || c.edge === "help") && c.expected !== "in")).toBe(0);
    expect(by((c) => c.edge === "code" && c.expected === "off_topic")).toBeGreaterThanOrEqual(5);
    expect(set.some((c) => c.expected === "off_topic" && /HTML/.test(c.text) && /landing page/i.test(c.text))).toBe(true);
    expect(by((c) => c.edge === "injection" && c.expected !== "in")).toBeGreaterThanOrEqual(10);
    expect(by((c) => c.kind === "output")).toBeGreaterThanOrEqual(15);
    expect(set.some((c) => c.agent === "reem" && c.expected === "personal" && /doctor/i.test(c.text))).toBe(true);
  });
  it("every case is well formed; other_brand cases name the other brands", () => {
    for (const c of set) {
      expect(VERDICTS as readonly string[], c.id).toContain(c.expected);
      expect(AGENT_IDS, c.id).toContain(c.agent);
      expect(["input", "output"], c.id).toContain(c.kind);
      expect(c.text.trim().length, c.id).toBeGreaterThan(0);
      expect(c.brand.name.trim().length, c.id).toBeGreaterThan(0);
      if (c.expected === "other_brand") expect(c.otherBrands.length, c.id).toBeGreaterThan(0);
    }
  });
});

describe("rule 1412: scoreAgentScope", () => {
  const cases = (refusals: number, ins: number): AgentScopeCase[] => [
    ...Array.from({ length: refusals }, (_, i): AgentScopeCase => ({ id: `r${i}`, lang: "en", agent: "noor", kind: "input", text: "x", brand: { name: "B", industry: "" }, otherBrands: [], expected: "off_topic" })),
    ...Array.from({ length: ins }, (_, i): AgentScopeCase => ({ id: `i${i}`, lang: "en", agent: "noor", kind: "input", text: "x", brand: { name: "B", industry: "" }, otherBrands: [], expected: "in" })),
  ];
  const answers = (caught: number, wrong: number, errors = 0): Classified[] => [
    ...Array.from({ length: 100 }, (_, i): Classified => (i < errors ? { ok: false, error: "api" } : i < caught + errors ? { ok: true, verdict: "pro_advice" } : { ok: true, verdict: "in" })),
    ...Array.from({ length: 100 }, (_, i): Classified => (i < wrong ? { ok: true, verdict: "personal" } : { ok: true, verdict: "in" })),
  ];
  it("thresholds at the edges", () => {
    expect([AGENT_SCOPE_MIN_RECALL, AGENT_SCOPE_MAX_WRONG]).toEqual([0.95, 0.02]);
    const c = cases(100, 100);
    expect(scoreAgentScope(c, answers(95, 0), "m").passed).toBe(true);
    expect(scoreAgentScope(c, answers(94, 0), "m").passed).toBe(false);
    expect(scoreAgentScope(c, answers(100, 2), "m").passed).toBe(true);
    expect(scoreAgentScope(c, answers(100, 3), "m").passed).toBe(false);
    const r = scoreAgentScope(c, answers(95, 2), "m", "2026-10-12T00:00:00.000Z");
    expect(r).toMatchObject({ at: "2026-10-12T00:00:00.000Z", model: "m", total: 200, errors: 0, recall: 0.95, wrongRefusals: 0.02, passed: true });
    // Any refusal verdict counts as caught; only the label itself counts as exact.
    expect(r.byVerdict.off_topic).toEqual({ n: 100, caught: 95, exact: 0 });
    expect(r.byVerdict.in).toEqual({ n: 100, caught: 98, exact: 98 });
  });
  it("errors count as misses, never as refusals", () => {
    const c = cases(100, 100);
    const r = scoreAgentScope(c, answers(95, 0, 1), "m");
    expect(r).toMatchObject({ errors: 1, recall: 0.95, passed: true });
    expect(scoreAgentScope(c, answers(94, 0, 1), "m")).toMatchObject({ errors: 1, recall: 0.94, passed: false });
    // An error on an in case is not a wrong refusal, and not a case let through either.
    const e = scoreAgentScope(cases(1, 1), [{ ok: true, verdict: "off_topic" }, { ok: false, error: "timeout" }], "m");
    expect(e).toMatchObject({ errors: 1, wrongRefusals: 0 });
    expect(e.byVerdict.in.caught).toBe(0);
  });
});

describe("rule 1412: modes route", () => {
  it("founder only; bad value is 400; enforce without a passed eval is 409; on another model 409; on this model 200 and admin:log written", async () => {
    const u = await newUser("asm-owner");
    expect((await setModes({ role: "enforce" })).status).toBe(401);
    await signIn(u.email);
    expect((await setModes({ role: "enforce" })).status).toBe(401);
    jar().clear();
    await adminSignIn();
    for (const bad of [{}, { input: "on" }, { prompt: "shadow" }, { output: 1 }, { role: "enforce", input: "loud" }]) expect((await setModes(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(await readAgentScopeModes()).toEqual(AGENT_SCOPE_DEFAULT_MODES);
    let r = await setModes({ input: "enforce" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, error: "eval_not_passed" });
    await db.set(AGENT_SCOPE_KEYS.evalLast, { ...passed(), passed: false });
    expect((await setModes({ output: "enforce" })).status).toBe(409);
    await db.set(AGENT_SCOPE_KEYS.evalLast, passed("claude-some-other-model"));
    expect((await setModes({ output: "enforce" })).status).toBe(409);
    expect(await readAgentScopeModes()).toEqual(AGENT_SCOPE_DEFAULT_MODES);
    await db.set(AGENT_SCOPE_KEYS.evalLast, passed());
    r = await setModes({ input: "enforce", output: "enforce" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, modes: { prompt: "on", input: "enforce", role: "shadow", output: "enforce" } });
    expect(await readAgentScopeModes()).toEqual({ prompt: "on", input: "enforce", role: "shadow", output: "enforce" });
    const row = JSON.parse((await db.lrange("admin:log", 0, 0))[0]);
    expect(row).toMatchObject({ actor: "key", what: "agent_scope_modes", before: AGENT_SCOPE_DEFAULT_MODES, after: { input: "enforce", output: "enforce" } });
  });
  it("role may go to enforce, and any layer back to shadow or off, without an eval", async () => {
    await adminSignIn();
    expect((await setModes({ role: "enforce" })).status).toBe(200);
    expect((await setModes({ prompt: "off", input: "off", output: "shadow" })).status).toBe(200);
    expect(await readAgentScopeModes()).toEqual({ prompt: "off", input: "off", role: "enforce", output: "shadow" });
  });
});

describe("rule 1412: eval route", () => {
  it("founder only; paused is 503 with no call; a run is stored, logged and scored; one run at a time", async () => {
    const u = await newUser("ase-owner");
    expect((await runEval()).status).toBe(401);
    await signIn(u.email);
    expect((await runEval()).status).toBe(401);
    jar().clear();
    await adminSignIn();
    st.state = "paused";
    const p = await runEval();
    expect(p.status).toBe(503);
    expect(await p.json()).toEqual({ ok: false, error: "model_paused" });
    expect(st.calls).toBe(0);
    st.state = "on";
    // A perfect classifier, answering each case's label.
    const label = new Map(AGENT_SCOPE_SET.map((c) => [c.text, c.expected]));
    st.answer = (text) => label.get(text) ?? "in";
    const r = await runEval();
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: true; eval: AgentScopeEval };
    expect(st.calls).toBe(AGENT_SCOPE_SET.length);
    expect(j.eval).toMatchObject({ model: agentScopeModel(), total: AGENT_SCOPE_SET.length, errors: 0, recall: 1, wrongRefusals: 0, passed: true });
    expect(await db.get(AGENT_SCOPE_KEYS.evalLast)).toEqual(j.eval);
    expect(JSON.parse((await db.lrange("admin:log", 0, 0))[0])).toMatchObject({ actor: "key", what: "agent_scope_eval", after: { passed: true, total: AGENT_SCOPE_SET.length } });
    expect(await db.get(AGENT_SCOPE_KEYS.evalLock)).toBeNull();
    // A run already going: 409 and no call.
    await db.lock(AGENT_SCOPE_KEYS.evalLock, 300);
    st.calls = 0;
    expect((await runEval()).status).toBe(409);
    expect(st.calls).toBe(0);
  });
  it("a classifier that never answers stores a failed eval", async () => {
    await adminSignIn();
    const j = (await (await runEval()).json()) as { eval: AgentScopeEval };
    expect(j.eval).toMatchObject({ errors: AGENT_SCOPE_SET.length, recall: 0, passed: false });
  });
});

describe("rule 1413: GET and the panel", () => {
  it("founder only; a bad day reads today; returns modes, eval, log, cost", async () => {
    const u = await newUser("asg-owner");
    await signIn(u.email);
    expect((await getPanel()).status).toBe(401);
    jar().clear();
    await adminSignIn();
    const today = new Date().toISOString().slice(0, 10);
    const line: AgentScopeLogEntry = { at: new Date().toISOString(), email: u.email, brandId: "default", agent: "noor", layer: "output", where: "publish", verdict: "off_topic", mode: "shadow", text: "t", itemId: "i1" };
    await Promise.all([
      db.lpush(AGENT_SCOPE_KEYS.log(today), JSON.stringify(line)),
      db.lpush(AGENT_SCOPE_KEYS.log("2026-01-02"), JSON.stringify({ ...line, itemId: "old" })),
      db.set(AGENT_SCOPE_KEYS.evalLast, passed()),
      db.set(`usage:_all:${monthKey()}:kind:agent_scope`, 7),
      db.set(`usage:_all:${monthKey()}:kind:agent_scope:usd_micro`, 1500),
    ]);
    for (const q of ["", "?day=bad", "?day=2026-1-2", "?day=../x"]) {
      const j = await (await getPanel(q)).json();
      expect(j.day, q).toBe(today);
      expect(j.log.some((e: AgentScopeLogEntry) => e.itemId === "i1"), q).toBe(true);
    }
    const j = await (await getPanel()).json();
    expect(j).toMatchObject({ ok: true, modes: AGENT_SCOPE_DEFAULT_MODES, eval: { passed: true }, cost: { month: monthKey(), calls: 7, usd: 0.0015 } });
    const old = await (await getPanel("?day=2026-01-02")).json();
    expect(old.day).toBe("2026-01-02");
    expect(old.log.map((e: AgentScopeLogEntry) => e.itemId)).toEqual(["old"]);
  });
  it("the Quality section renders AgentScopePanel under the golden set, and the panel imports only types from server files", () => {
    const quality = readFileSync("src/components/admin/Quality.tsx", "utf8");
    expect(quality.indexOf("<AgentScopePanel lang={lang} />")).toBeGreaterThan(quality.indexOf("<GoldenPanel lang={lang} />"));
    const panel = readFileSync("src/components/admin/AgentScopePanel.tsx", "utf8");
    expect(panel).toMatch(/^"use client";/);
    for (const m of panel.matchAll(/^import (.*) from "@\/lib\/(agent-scope[^"]*)";$/gm)) expect(m[1], m[2]).toMatch(/^type /);
    for (const path of ["/api/admin/agent-scope/modes", "/api/admin/agent-scope/eval", "/api/admin/agent-scope/release"]) expect(panel).toContain(path);
    expect(panel).toContain('<bdi dir="auto">');
  });
});
