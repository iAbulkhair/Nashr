import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rules 794 and 795 (agent scope, Part B, spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md
 * section 4.2): the input gate in a chat turn and the ceiling of enforced refusals.
 *
 * - 794: `chat()` asks `scopeCheck("input", …)` after the brand reads and before the first model call. Off: no call. Shadow:
 *   the check runs beside the turn, is logged, and the turn is answered and counted like any other. Enforce: a refusal makes
 *   no main model call, the owner's message and the refusal are saved to the thread, and the message is given back to the
 *   chat allowance (the turn's `usd` is 0).
 * - 795: 20 enforced refusals an hour and 60 a day per brand scope (`sc(u)`), read by `agentScopePreflight` before the chat
 *   allowance is touched and before any classifier call. Past it: 429 `slow_down` with `Retry-After` (MCP: a tool error).
 *   Only enforced input refusals count; shadow never does.
 *
 * The classifier is mocked (`@/lib/agent-scope-classify`), so a test sets the verdict. The SDK counts the main model's
 * stream calls.
 */
const sdk = vi.hoisted(() => ({ streams: 0 }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    static BadRequestError = class extends Error {};
    messages = {
      stream: (p: { model: string }) => ({
        finalMessage: async () => {
          sdk.streams++;
          return { model: p.model, stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: "text", text: "أهلاً" }] };
        },
      }),
    };
  },
}));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));
type Seen = { input: { kind: string; text: string; agent: string; brand: { name: string; industry: string }; otherBrands: string[]; lang: string }; o: { deadline?: number } };
const cls = vi.hoisted(() => ({ verdict: "in" as string, calls: [] as Seen[] }));
vi.mock("@/lib/agent-scope-classify", async (orig) => {
  const m = await orig<typeof import("@/lib/agent-scope-classify")>();
  return {
    ...m,
    classify: async (input: Seen["input"], o: Seen["o"] = {}) => {
      cls.calls.push({ input, o });
      return { ok: true, verdict: cls.verdict };
    },
  };
});

import { getUser, saveUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { chat, history } from "@/lib/chat";
import { chatStatus } from "@/lib/chat-allowance";
import { route } from "@/lib/models/route";
import { createMcpToken } from "@/lib/mcp";
import { saveBrands, setActiveBrand } from "@/lib/brands";
import { AGENT_SCOPE_REFUSALS_PER_DAY, AGENT_SCOPE_REFUSALS_PER_HOUR, agentScopeCeiling, countAgentScopeRefusal } from "@/lib/rate";
import { AGENT_SCOPE_KEYS, agentScopePreflight, agentScopeRefusalText, agentScopeSlowText, scopeCheck, type AgentScopeLogEntry, type AgentScopeMode } from "@/lib/agent-scope";
import { json, newUser, signIn } from "./helpers/session";
import * as chatRoute from "@/app/api/chat/route";
import * as mcpRoute from "@/app/api/mcp/route";

const setModes = (input: AgentScopeMode) => db.set(AGENT_SCOPE_KEYS.modes, { prompt: "on", input, role: "off", output: "off" });
const hourKey = (scope: string) => `rate:agent-scope:h:${scope}`;
const dayKey = (scope: string) => `rate:agent-scope:d:${scope}`;
const day = () => new Date().toISOString().slice(0, 10);
/** This account's lines in today's log (the log is global; other accounts' lines are left out). */
const logOf = async (email: string) => (await db.lrange(AGENT_SCOPE_KEYS.log(day()), 0, -1)).map((r) => JSON.parse(r) as AgentScopeLogEntry).filter((e) => e.email === email);
const counter = async (key: string) => Number((await db.get<number | string>(key)) ?? 0);

/** A paid owner (the month's counter), signed in, as the routes read it (`scope` set). */
async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...u, plan: "starter", credits: 300 });
  await signIn(u.email);
  const back = (await getUser(u.email))!;
  back.scope = back.email;
  return back;
}
const used = async (u: User) => (await chatStatus(u, route("chat").model)).counted;
const post = (text: string, extra: Record<string, unknown> = {}) => chatRoute.POST(json("/api/chat", "POST", { text, ...extra }));
type Body = { ok: boolean; error?: string; retry?: string; message: { role: string; content: string; agent?: string }; charged?: number; chat?: { counted: number } };
const askNoor = async (email: string, message: string) => {
  const token = await createMcpToken(email);
  const res = await mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_noor", arguments: { message } } }) }));
  return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
};

beforeEach(() => {
  sdk.streams = 0;
  cls.verdict = "in";
  cls.calls = [];
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.del(AGENT_SCOPE_KEYS.modes);
});

describe("rule 795: the refusal ceiling in rate.ts", () => {
  it("the numbers", () => {
    expect(AGENT_SCOPE_REFUSALS_PER_HOUR).toBe(20);
    expect(AGENT_SCOPE_REFUSALS_PER_DAY).toBe(60);
  });

  it("refuses at or above a limit, the hour first, and names the day when the day is spent too", async () => {
    const s = `ceil-${Date.now()}@test.example`;
    const u = { email: s };
    expect(await agentScopeCeiling(u)).toBeNull();
    await db.set(hourKey(s), 19);
    await db.set(dayKey(s), 59);
    expect(await agentScopeCeiling(u)).toBeNull();
    await db.set(hourKey(s), 20);
    expect(await agentScopeCeiling(u)).toBe("hour");
    await db.set(hourKey(s), 3);
    await db.set(dayKey(s), 60);
    expect(await agentScopeCeiling(u)).toBe("day");
    // Both spent: the longer wait, so an owner told "in an hour" does not meet "tomorrow" next (as chatRefusal, rule 331).
    await db.set(hourKey(s), 25);
    expect(await agentScopeCeiling(u)).toBe("day");
    // A string count, as Upstash may return it, reads as a number.
    await db.set(dayKey(s), "1");
    await db.set(hourKey(s), "20");
    expect(await agentScopeCeiling(u)).toBe("hour");
  });

  it("reads and counts under the brand scope, never the account email when a brand is active", async () => {
    const email = `ceil-b-${Date.now()}@test.example`;
    const u = { email, scope: `${email}#b2` };
    await countAgentScopeRefusal(u);
    await countAgentScopeRefusal(u);
    expect(await counter(hourKey(`${email}#b2`))).toBe(2);
    expect(await counter(dayKey(`${email}#b2`))).toBe(2);
    expect(await db.get(hourKey(email))).toBeNull();
    await db.set(hourKey(`${email}#b2`), 20);
    expect(await agentScopeCeiling(u)).toBe("hour");
    expect(await agentScopeCeiling({ email })).toBeNull();
  });

  it("the reader makes one round of two reads, and the counter starts each window's expiry", async () => {
    const email = `ceil-r-${Date.now()}@test.example`;
    const get = vi.spyOn(db, "get");
    await agentScopeCeiling({ email });
    expect(get.mock.calls.map((c) => c[0]).sort()).toEqual([dayKey(email), hourKey(email)]);
    const exp = vi.spyOn(db, "expireNx");
    await countAgentScopeRefusal({ email });
    expect(exp.mock.calls.map((c) => [c[0], c[1]]).sort()).toEqual([[dayKey(email), 86400], [hourKey(email), 3600]]);
  });

  it("preflight: slow only in enforce; the modes come back for the turn", async () => {
    const u = await owner("asc-pre");
    await db.set(hourKey(sc(u)), 20);
    await setModes("shadow");
    expect(await agentScopePreflight(u)).toEqual({ modes: { prompt: "on", input: "shadow", role: "off", output: "off" }, slow: null });
    await setModes("off");
    expect((await agentScopePreflight(u)).slow).toBeNull();
    await setModes("enforce");
    expect(await agentScopePreflight(u)).toEqual({ modes: { prompt: "on", input: "enforce", role: "off", output: "off" }, slow: "hour" });
  });

  it("preflight: a counter that cannot be read lets the turn through (input fails open)", async () => {
    const u = await owner("asc-pre-err");
    await setModes("enforce");
    const real = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation(((k: string) => (k.startsWith("rate:agent-scope:") ? Promise.reject(new Error("down")) : real(k))) as typeof db.get);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await agentScopePreflight(u)).slow).toBeNull();
    expect(err.mock.calls.flat().join(" ")).not.toContain(u.email);
  });

  it("scopeCheck counts an enforced input refusal only: never shadow, never `in`, never an output check", async () => {
    const u = await owner("asc-count");
    const ctx = { user: u, agent: "noor" as const, where: "chat" as const, lang: "en" as const, brand: { name: "Cafe", industry: "coffee" }, otherBrands: [] };
    cls.verdict = "personal";
    await scopeCheck("input", "shadow", "my dentist", ctx);
    expect(await db.get(hourKey(sc(u))), "shadow is not counted").toBeNull();
    await scopeCheck("output", "enforce", "a poem about my dentist", ctx);
    expect(await db.get(hourKey(sc(u))), "an output refusal is not the owner's message").toBeNull();
    cls.verdict = "in";
    await scopeCheck("input", "enforce", "a post for Ramadan", ctx);
    expect(await db.get(hourKey(sc(u)))).toBeNull();
    cls.verdict = "off_topic";
    expect((await scopeCheck("input", "enforce", "a python script", ctx)).block).toBe(true);
    expect(await counter(hourKey(sc(u)))).toBe(1);
    expect(await counter(dayKey(sc(u)))).toBe(1);
  });
});

describe("rule 794: the input gate in a chat turn", () => {
  it("input off: no classify call, turn runs", async () => {
    const u = await owner("asc-off");
    await setModes("off");
    const res = await post("اكتب منشوراً عن القهوة");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).message.content).toBe("أهلاً");
    expect(cls.calls).toHaveLength(0);
    expect(sdk.streams).toBe(1);
    expect(await logOf(u.email)).toEqual([]);
    expect(await used(u)).toBe(1);
  });

  it("input shadow + refusal: turn runs, one log entry, message counted", async () => {
    const u = await owner("asc-shadow");
    await setModes("shadow");
    cls.verdict = "personal";
    const before = await used(u);
    const res = await post("ذكرني بموعد الطبيب");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.message.content).toBe("أهلاً");
    expect(sdk.streams).toBe(1);
    expect(cls.calls).toHaveLength(1);
    expect(cls.calls[0].input).toMatchObject({ kind: "input", text: "ذكرني بموعد الطبيب", agent: "noor", lang: "ar" });
    // The turn's own deadline bounds the check.
    expect(typeof cls.calls[0].o.deadline).toBe("number");
    const log = await logOf(u.email);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ layer: "input", mode: "shadow", verdict: "personal", where: "chat", agent: "noor", brandId: "default" });
    expect(await used(u), "the turn is charged").toBe(before + 1);
    expect(await db.get(hourKey(sc(u))), "shadow never counts toward the ceiling").toBeNull();
  });

  it("input enforce + refusal: no main model call, refusal saved, not counted", async () => {
    const u = await owner("asc-enf");
    await setModes("enforce");
    cls.verdict = "personal";
    const before = await used(u);
    const res = await post("ذكرني بموعد الطبيب");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    const refusal = agentScopeRefusalText("personal", "ar", { brand: "", otherBrands: [] });
    expect(body.message).toMatchObject({ role: "assistant", content: refusal, agent: "noor" });
    expect(body.charged).toBe(0);
    expect(sdk.streams).toBe(0);
    const thread = await history(sc(u));
    expect(thread.slice(-2).map((m) => [m.role, m.content])).toEqual([["user", "ذكرني بموعد الطبيب"], ["assistant", refusal]]);
    expect(await used(u), "the message is given back").toBe(before);
    expect(body.chat?.counted).toBe(before);
    expect(await db.get(hourKey(sc(u)))).toBe(1);
    expect(await db.get(dayKey(sc(u)))).toBe(1);
    expect(await logOf(u.email)).toEqual([expect.objectContaining({ layer: "input", mode: "enforce", verdict: "personal", where: "chat" })]);
  });

  it("input enforce + refusal on the stream path too", async () => {
    const u = await owner("asc-enf-s");
    await setModes("enforce");
    cls.verdict = "pro_advice";
    const res = await post("is this contract legal?", { stream: true });
    const events = (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { type: string; message?: { content: string }; charged?: number });
    const last = events[events.length - 1];
    expect(last.type).toBe("message");
    expect(last.message?.content).toBe(agentScopeRefusalText("pro_advice", "ar", { brand: "", otherBrands: [] }));
    expect(last.charged).toBe(0);
    expect(sdk.streams).toBe(0);
    expect(await used(u)).toBe(0);
  });

  it("input enforce + in: turn runs", async () => {
    const u = await owner("asc-enf-in");
    await setModes("enforce");
    const get = vi.spyOn(db, "get");
    const res = await post("اكتب منشوراً عن القهوة");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).message.content).toBe("أهلاً");
    expect(cls.calls).toHaveLength(1);
    expect(sdk.streams).toBe(1);
    expect(await used(u)).toBe(1);
    expect(await logOf(u.email)).toEqual([]);
    expect(await db.get(hourKey(sc(u)))).toBeNull();
    // The route read the modes once and handed them to chat(), which does not read them again.
    expect(get.mock.calls.filter((c) => c[0] === AGENT_SCOPE_KEYS.modes)).toHaveLength(1);
  });

  it("the gate reads the active brand, its sector and the owner's other brands", async () => {
    const u = await owner("asc-ctx");
    await saveBrands(u.email, [
      { id: "default", name: "", createdAt: new Date().toISOString(), status: "active" },
      { id: "b2", name: "Bakery Two", createdAt: new Date().toISOString(), status: "active" },
    ]);
    await setModes("enforce");
    await post("hello");
    expect(cls.calls).toHaveLength(1);
    expect(cls.calls[0].input.otherBrands).toEqual(["Bakery Two"]);
    expect(cls.calls[0].input.brand).toEqual({ name: "", industry: "" });
  });

  it("a store error reading the other brands does not break the turn", async () => {
    const u = await owner("asc-brands-err");
    await setModes("enforce");
    const real = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation(((k: string) => (k === `brands:${u.email}` ? Promise.reject(new Error("down")) : real(k))) as typeof db.get);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("اكتب منشوراً");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).message.content).toBe("أهلاً");
    expect(cls.calls[0].input.otherBrands).toEqual([]);
    expect(err.mock.calls.flat().join(" ")).not.toContain(u.email);
  });

  it("chat() called without modes reads them itself", async () => {
    const u = await owner("asc-fn");
    await setModes("enforce");
    cls.verdict = "off_topic";
    const m = await chat(u, "write me a python script", undefined, "noor", { lang: "en" });
    expect(m.content).toBe(agentScopeRefusalText("off_topic", "en", { brand: "", otherBrands: [] }));
    expect(m.usd ?? 0).toBe(0);
    expect(sdk.streams).toBe(0);
  });

  it("ceiling: the 21st refusal in an hour is 429 slow_down with Retry-After 3600 and no classify call", async () => {
    const u = await owner("asc-ceil");
    await setModes("enforce");
    await db.set(hourKey(sc(u)), 20);
    const res = await post("ذكرني بموعد الطبيب");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    const body = (await res.json()) as Body;
    expect(body).toMatchObject({ ok: false, error: "slow_down", retry: "hour", message: { role: "assistant", content: agentScopeSlowText("ar"), agent: "noor" } });
    expect(cls.calls).toHaveLength(0);
    expect(sdk.streams).toBe(0);
    expect(await history(sc(u)), "nothing is saved").toEqual([]);
    expect(await used(u), "no message is reserved").toBe(0);
  });

  it("ceiling: a spent day is 429 with Retry-After 86400", async () => {
    const u = await owner("asc-ceil-d");
    await setModes("enforce");
    await db.set(dayKey(sc(u)), 60);
    const res = await post("hi", {});
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("86400");
    expect(((await res.json()) as Body).retry).toBe("day");
    expect(cls.calls).toHaveLength(0);
  });

  it("ceiling is per brand scope", async () => {
    const u = await owner("asc-ceil-b");
    await setModes("enforce");
    await db.set(hourKey(u.email), 20);
    await saveBrands(u.email, [
      { id: "default", name: "", createdAt: new Date().toISOString(), status: "active" },
      { id: "b2", name: "Second", createdAt: new Date().toISOString(), status: "active" },
    ]);
    await setActiveBrand(u.email, "b2");
    cls.verdict = "personal";
    const res = await post("ذكرني بموعد الطبيب");
    expect(res.status, "the default brand's ceiling does not refuse brand b2").toBe(200);
    expect(cls.calls).toHaveLength(1);
    expect(await counter(hourKey(`${u.email}#b2`)), "b2's refusal counts on b2").toBe(1);
    expect(await counter(hourKey(u.email)), "the default brand's count is unchanged").toBe(20);
  });

  it("ceiling is ignored outside enforce", async () => {
    const u = await owner("asc-ceil-sh");
    await setModes("shadow");
    await db.set(hourKey(sc(u)), 20);
    await db.set(dayKey(sc(u)), 60);
    const res = await post("اكتب منشوراً");
    expect(res.status).toBe(200);
    expect(sdk.streams).toBe(1);
    expect(cls.calls).toHaveLength(1);
  });
});

describe("rules 794-795: MCP ask_noor", () => {
  it("MCP ask_noor: enforce refusal comes back as the refusal text; ceiling returns isError", async () => {
    const u = await owner("asc-mcp");
    await setModes("enforce");
    cls.verdict = "other_business";
    const r = await askNoor(u.email, "write ads for my cousin's shop");
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.startsWith(agentScopeRefusalText("other_business", "ar", { brand: "", otherBrands: [] }))).toBe(true);
    expect(sdk.streams).toBe(0);
    expect(await used(u), "not counted").toBe(0);
    expect(await counter(hourKey(sc(u)))).toBe(1);
    expect(await logOf(u.email)).toEqual([expect.objectContaining({ layer: "input", mode: "enforce", where: "mcp_chat" })]);

    await db.set(hourKey(sc(u)), 20);
    cls.calls = [];
    const slow = await askNoor(u.email, "write ads for my cousin's shop");
    expect(slow.isError).toBe(true);
    expect(slow.content[0].text).toBe(agentScopeSlowText("ar"));
    expect(cls.calls).toHaveLength(0);
    expect(sdk.streams).toBe(0);
  });

  it("MCP ask_noor in enforce with an `in` verdict runs the turn", async () => {
    const u = await owner("asc-mcp-in");
    await setModes("enforce");
    const r = await askNoor(u.email, "اكتب منشوراً");
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.startsWith("أهلاً")).toBe(true);
    expect(sdk.streams).toBe(1);
    expect(await used(u)).toBe(1);
  });
});

describe("rules 794-795: where the routes put the gate", () => {
  const src = (f: string) => readFileSync(f, "utf8");
  it("the chat route reads the preflight with the burst ceiling, refuses on it first, and both before the allowance", () => {
    const s = src("src/app/api/chat/route.ts");
    expect(s).toMatch(/await Promise\.all\(\[chatRefusal\(u\), [^\n]*agentScopePreflight\(u\)\]\)/);
    expect(s.indexOf("if (pre.slow)")).toBeGreaterThan(-1);
    expect(s.indexOf("if (pre.slow)")).toBeLessThan(s.indexOf("if (slow)"));
    expect(s.indexOf("if (slow)")).toBeLessThan(s.indexOf("reserveChatTurn("));
    const calls = s.split("\n").filter((l) => /=> chat\(/.test(l));
    expect(calls).toHaveLength(2);
    for (const l of calls) expect(l).toMatch(/model: gate\.model, agentScope: pre\.modes/);
  });

  it("MCP ask_noor does the same after the entitlement and trial checks", () => {
    const s = src("src/app/api/mcp/route.ts");
    const ask = s.slice(s.indexOf('case "ask_noor"'), s.indexOf('case "generate_content"'));
    expect(ask).toMatch(/await Promise\.all\(\[chatRefusal\(user\), agentScopePreflight\(user\)\]\)/);
    expect(ask.indexOf("trialOver(user)")).toBeLessThan(ask.indexOf("agentScopePreflight("));
    expect(ask.indexOf("entitlements(user)")).toBeLessThan(ask.indexOf("agentScopePreflight("));
    expect(ask.indexOf("if (pre.slow)")).toBeLessThan(ask.indexOf("if (slow)"));
    expect(ask.indexOf("if (slow)")).toBeLessThan(ask.indexOf("reserveChatTurn("));
    expect(ask).toMatch(/=> chat\(user, [^\n]*agentScope: pre\.modes/);
  });
});
