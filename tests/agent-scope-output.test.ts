import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rules 800-802 (agent scope, Part B, spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md section 6):
 * the output check, Layer 4, on what an agent wrote.
 *
 * - 800: the chat reply. `chat()` checks the final model answer (`scopeCheck("output", …)`) before it is saved. Enforce: a
 *   refusal replaces the text, the cards stay and the turn keeps its `usd` (the main model was called). Shadow: started beside
 *   the save and awaited before the turn returns. A reply cut at its cap is model text and is checked the same way (enforce:
 *   the refusal without the cut note). Thakeen's fixed replies and the paused reply are never checked. Every
 *   exit after the input gate awaits the shadow checks (try/finally), and the shadow input check never delays the first call.
 * - 801: the items of a generation batch, checked between generation and saving through `pmap` (5 at a time). Enforce: an item
 *   refused is not saved; after the commit `Math.ceil(cost * held / items)` is refunded with the charge's receipt and
 *   `BatchDone.held` says how many, `refunded` what landed (0 when the refund failed, and then no answer says "refunded"). All refused, or any refused in a `once` batch: `AgentScopeRefused` inside the refunding try,
 *   so the whole batch is refunded. Shadow saves every item and logs the refusals with their `itemId`.
 * - 802: MCP `save_draft`. After the hourly and daily draft rate (both counted), before the save: enforce refuses with an `isError` text and saves nothing.
 *
 * The classifier is mocked (`@/lib/agent-scope-classify`) per call: `cls.decide` reads the text and answers the verdict.
 */
const sdk = vi.hoisted(() => {
  const msg = (model: string, content: unknown[], stop = "end_turn") => ({ model, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 100 }, content });
  const items = [
    { channel: "instagram", title: "بند 1", body: "نص تجريبي للعنصر الأول يكفي للمراجعة" },
    { channel: "instagram", title: "بند 2", body: "نص تجريبي للعنصر الثاني يكفي للمراجعة" },
    { channel: "instagram", title: "بند 3", body: "نص تجريبي للعنصر الثالث يكفي للمراجعة" },
  ];
  // A full social batch (TASK_COUNT.social items): a batch of fewer is a short one, charged per item delivered (rule 2276).
  const full = Array.from({ length: 10 }, (_, i) => ({ channel: "instagram", title: `بند ${i + 1}`, body: `نص تجريبي للعنصر رقم ${i + 1} يكفي للمراجعة` }));
  return { msg, items: items as typeof items, all: items, full, gens: 0, streams: 0, chat: [] as unknown[][], stops: [] as string[], onStream: null as null | (() => void), noUsage: false };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    static BadRequestError = class extends Error {};
    beta = { messages: { stream: () => ({ finalMessage: async () => { sdk.gens++; return sdk.msg("claude-opus-5", [{ type: "text", text: JSON.stringify(sdk.items) }]); } }) } };
    messages = {
      // Since rule 980 (2026-10-10) the reviewer and the judge stream too: a call without tools is answered as `create` is.
      stream: (p: { model: string; tools?: unknown[]; system: string | { text: string }[] }) => ({
        finalMessage: async () => {
          if (!p.tools) return this.messages.create(p);
          sdk.streams++;
          sdk.onStream?.();
          const next = sdk.chat.shift() ?? [{ type: "text", text: "أهلاً" }];
          const tool = next.some((b) => (b as { type: string }).type === "tool_use");
          const m = sdk.msg(p.model, next, sdk.stops.shift() ?? (tool ? "tool_use" : "end_turn"));
          return sdk.noUsage ? { ...m, usage: undefined } : m;
        },
      }),
      create: async (p: { system: string | { text: string }[] }) => {
        const sys = typeof p.system === "string" ? p.system : p.system[0].text;
        const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };
        return sdk.msg("claude-opus-5", [{ type: "text", text: sys.startsWith("You are the quality judge") ? JSON.stringify([verdict]) : JSON.stringify([{ ok: true }]) }]);
      },
    };
  },
}));
// A partial refund that cannot be written (rule 801, fix round 1): only `refund` is wrapped, and only while `fail.refund` is set.
const fail = vi.hoisted(() => ({ refund: false }));
vi.mock("@/lib/credits", async (orig) => {
  const m = await orig<typeof import("@/lib/credits")>();
  return { ...m, refund: (...a: Parameters<typeof m.refund>) => (fail.refund ? Promise.reject(Object.assign(new Error("store down"), { name: "RefundStoreError" })) : m.refund(...a)) };
});
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));
type Seen = { kind: string; text: string; agent: string; brand: { name: string; industry: string }; otherBrands: string[]; lang: string };
const cls = vi.hoisted(() => ({
  decide: ((() => "in") as (i: { text: string }) => string),
  error: null as null | string,
  calls: [] as { kind: string; text: string; agent: string; brand: { name: string; industry: string }; otherBrands: string[]; lang: string }[],
  before: null as null | ((i: { kind: string; text: string }) => Promise<void>),
  usage: null as null | { input_tokens: number; output_tokens: number },
}));
vi.mock("@/lib/agent-scope-classify", async (orig) => {
  const m = await orig<typeof import("@/lib/agent-scope-classify")>();
  const { meter } = await import("@/lib/usage");
  return {
    ...m,
    classify: async (input: Seen) => {
      cls.calls.push(input);
      await cls.before?.(input);
      // As the real classifier does: its cost goes to the global meter only (R4), never to an account.
      if (cls.usage) await meter(undefined, m.agentScopeModel(), "agent_scope", cls.usage, input.agent as never);
      return cls.error ? { ok: false, error: cls.error } : { ok: true, verdict: cls.decide(input) };
    },
  };
});

import { getUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { listTasks, type Brand } from "@/lib/brand";
import { createMcpToken } from "@/lib/mcp";
import { TASK_COST } from "@/lib/tasks";
import { agentSpendFor } from "@/lib/credits";
import { listActivity } from "@/lib/activity";
import { costUsd } from "@/lib/usage";
import { coverageRow } from "./helpers/coverage";
import { generateBatch } from "@/lib/generate-batch";
import { chat, history, runTool, system, OUT_OF_TIME_REPLY } from "@/lib/chat";
import { AGENT_SCOPE_KEYS, AgentScopeRefused, agentScopeRefusalText, type AgentScopeLogEntry, type AgentScopeModes } from "@/lib/agent-scope";
import { json, newUser, settle, signIn } from "./helpers/session";
import * as generateRoute from "@/app/api/generate/route";
import * as mcpRoute from "@/app/api/mcp/route";

const BRAND: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "رخيص", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const modes = (output: AgentScopeModes["output"], input: AgentScopeModes["input"] = "off"): AgentScopeModes => ({ prompt: "on", input, role: "off", output });
const setModes = (m: AgentScopeModes) => db.set(AGENT_SCOPE_KEYS.modes, m);
const day = () => new Date().toISOString().slice(0, 10);
const logOf = async (email: string) => (await db.lrange(AGENT_SCOPE_KEYS.log(day()), 0, -1)).map((r) => JSON.parse(r) as AgentScopeLogEntry).filter((e) => e.email === email);
const credits = async (email: string) => (await getUser(email))!.credits;
const OFF = agentScopeRefusalText("off_topic", "ar", { brand: BRAND.name, otherBrands: [] });
/** Refuse the item whose title is `title`. */
const refuseTitle = (title: string) => (i: { text: string }) => (i.text.startsWith(`${title}\n`) ? "off_topic" : "in");

async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await db.set(`brand:${u.email}`, BRAND);
  await signIn(u.email);
  const back = (await getUser(u.email))!;
  back.scope = back.email;
  return back;
}
const batch = (u: User, m: AgentScopeModes, extra: Record<string, unknown> = {}) => generateBatch(u, sc(u), { type: "social", source: "manual", via: "app", agentScope: m, ...extra });
type Mcp = { isError?: boolean; content: { text: string }[] };
const tool = async (email: string, name: string, args: Record<string, unknown>): Promise<Mcp> => {
  const token = await createMcpToken(email);
  const res = await mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  return ((await res.json()) as { result: Mcp }).result;
};

beforeEach(() => {
  sdk.gens = 0;
  sdk.streams = 0;
  sdk.chat = [];
  sdk.stops = [];
  fail.refund = false;
  sdk.items = sdk.all;
  sdk.onStream = null;
  sdk.noUsage = false;
  cls.decide = () => "in";
  cls.error = null;
  cls.calls = [];
  cls.before = null;
  cls.usage = null;
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
});
afterEach(async () => {
  await settle();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.del(AGENT_SCOPE_KEYS.modes);
});

describe("rule 800: the chat reply", () => {
  it("chat reply refused in enforce: text replaced, cards kept, usd > 0", async () => {
    const u = await owner("aso-reply");
    await setModes(modes("enforce"));
    sdk.items = [sdk.all[0]];
    sdk.chat = [[{ type: "tool_use", id: "t1", name: "draft_items", input: { type: "social", count: 1, brief: "عرض القهوة" } }], [{ type: "text", text: "REPLY-OFF قصيدة عن البحر" }]];
    cls.decide = (i) => (i.text.includes("REPLY-OFF") ? "off_topic" : "in");
    const m = await chat(u, "اكتب منشوراً", undefined, "noor");
    expect(m.content).toBe(OFF);
    expect(m.items, "the item made by the tool is still on the card").toHaveLength(1);
    expect(m.usd).toBeGreaterThan(0);
    const saved = (await history(sc(u))).at(-1)!;
    expect(saved.content).toBe(OFF);
    expect(saved.items).toHaveLength(1);
    // The item and the reply were both checked, as output, by Noor.
    expect(cls.calls.map((c) => c.kind)).toEqual(["output", "output"]);
    expect(cls.calls[1].text).toBe("REPLY-OFF قصيدة عن البحر");
    const log = await logOf(u.email);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ layer: "output", where: "chat", mode: "enforce", verdict: "off_topic", agent: "noor" });
  });

  it("chat reply: shadow keeps the text and logs; in passes", async () => {
    const u = await owner("aso-reply-shadow");
    await setModes(modes("shadow"));
    sdk.chat = [[{ type: "text", text: "REPLY-OFF" }]];
    cls.decide = () => "off_topic";
    const m = await chat(u, "مرحبا", undefined, "noor");
    expect(m.content).toBe("REPLY-OFF");
    expect((await logOf(u.email)).map((e) => [e.layer, e.mode, e.where])).toEqual([["output", "shadow", "chat"]]);
  });

  it("chat reply: fixed replies are not checked", async () => {
    const u = await owner("aso-fixed");
    await setModes(modes("enforce"));
    const m = await chat(u, "مرحبا", undefined, "noor", { deadline: Date.now() + 1000 });
    expect(m.content).toBe(OUT_OF_TIME_REPLY.ar);
    expect(sdk.streams).toBe(0);
    expect(cls.calls).toHaveLength(0);
  });

  it("chat reply: a fixed reply after a model call (the model refused) is not checked", async () => {
    const u = await owner("aso-fixed-refused");
    await setModes(modes("enforce"));
    sdk.chat = [[{ type: "text", text: "لا" }]];
    sdk.stops = ["refusal"];
    cls.decide = () => "off_topic";
    const m = await chat(u, "مرحبا", undefined, "noor");
    expect(sdk.streams).toBe(1);
    expect(m.content).not.toBe(OFF);
    expect(cls.calls).toHaveLength(0);
  });

  it("chat reply: a reply cut at its cap is model text, so it is checked; enforce shows the refusal without the cut note", async () => {
    const u = await owner("aso-cut");
    await setModes(modes("enforce"));
    sdk.chat = [[{ type: "text", text: "CUT-OFF مقال طويل عن كرة القدم" }]];
    sdk.stops = ["max_tokens"];
    cls.decide = (i) => (i.text.includes("CUT-OFF") ? "off_topic" : "in");
    const m = await chat(u, "اكتب مقالاً", undefined, "noor");
    expect(m.content).toBe(OFF);
    expect((await history(sc(u))).at(-1)!.content).toBe(OFF);
    expect(cls.calls.map((c) => [c.kind, c.text])).toEqual([["output", "CUT-OFF مقال طويل عن كرة القدم"]]);
    expect((await logOf(u.email)).map((e) => [e.layer, e.where, e.mode, e.verdict])).toEqual([["output", "chat", "enforce", "off_topic"]]);
  });

  it("chat reply: a cut reply in shadow keeps the text and the cut note and logs once; an empty cut asks nothing", async () => {
    const u = await owner("aso-cut-shadow");
    await setModes(modes("shadow"));
    sdk.chat = [[{ type: "text", text: "CUT-OFF نص" }]];
    sdk.stops = ["max_tokens"];
    cls.decide = () => "off_topic";
    const m = await chat(u, "اكتب", undefined, "noor");
    expect(m.content.startsWith("CUT-OFF نص\n\n")).toBe(true);
    expect(m.content).toContain("انقطع الرد");
    expect((await logOf(u.email)).map((e) => [e.layer, e.mode])).toEqual([["output", "shadow"]]);
    cls.calls = [];
    await setModes(modes("enforce"));
    sdk.chat = [[]];
    sdk.stops = ["max_tokens"];
    const e = await chat(u, "اكتب", undefined, "noor");
    expect(e.content).not.toBe(OFF);
    expect(cls.calls).toHaveLength(0);
  });

  it("chat reply: classifier error shows the reply and logs error", async () => {
    const u = await owner("aso-error");
    await setModes(modes("enforce"));
    sdk.chat = [[{ type: "text", text: "رد عادي" }]];
    cls.error = "api";
    const m = await chat(u, "مرحبا", undefined, "noor");
    expect(m.content).toBe("رد عادي");
    const log = await logOf(u.email);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ layer: "output", where: "chat", verdict: "error", error: "api", mode: "enforce" });
  });

  it("R2: the shadow input check does not delay the first model call, and its log line exists when the turn returns", async () => {
    const u = await owner("aso-r2");
    await setModes(modes("off", "shadow"));
    let streamed!: () => void;
    const first = new Promise<void>((r) => (streamed = r));
    sdk.onStream = () => streamed();
    // Resolves only after the first stream call. Were the shadow check awaited before that call, the turn would wait on
    // itself: the guard gives up after 2 s and the verdict becomes an error, which the assertion below would read.
    cls.before = () => Promise.race([first, new Promise<void>((_, no) => setTimeout(() => no(new Error("never streamed")), 2000))]);
    cls.decide = () => "off_topic";
    const m = await chat(u, "قصيدة عن البحر", undefined, "noor");
    expect(m.content).toBe("أهلاً");
    expect(sdk.streams).toBe(1);
    const log = await logOf(u.email);
    expect(log.map((e) => [e.layer, e.mode, e.verdict])).toEqual([["input", "shadow", "off_topic"]]);
  });

  it("R2: the shadow reply check runs after the reply is saved, and is awaited before the turn returns", async () => {
    const u = await owner("aso-r2-out");
    await setModes(modes("shadow"));
    sdk.chat = [[{ type: "text", text: "REPLY-OFF" }]];
    let savedFirst = false;
    cls.before = async () => {
      await new Promise((r) => setTimeout(r, 30));
      savedFirst = (await history(sc(u))).at(-1)?.content === "REPLY-OFF";
    };
    cls.decide = () => "off_topic";
    await chat(u, "مرحبا", undefined, "noor");
    expect(savedFirst, "the reply was saved while the shadow check was still running").toBe(true);
    expect(await logOf(u.email)).toHaveLength(1);
  });

  it("a throw after the first call still awaits the shadow input check (try/finally)", async () => {
    const u = await owner("aso-throw");
    await setModes(modes("off", "shadow"));
    cls.before = () => new Promise((r) => setTimeout(r, 30));
    cls.decide = () => "off_topic";
    // A response without usage: pricing it throws after the first call, outside the stream's own catch.
    sdk.noUsage = true;
    await expect(chat(u, "قصيدة", undefined, "noor")).rejects.toThrow(TypeError);
    expect(await logOf(u.email)).toHaveLength(1);
  });

  it("rule 794 pin: the classifier's cost never enters ChatTurn.usd", async () => {
    const u = await owner("aso-usd");
    await setModes(modes("shadow", "shadow"));
    cls.usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const m = await chat(u, "مرحبا", undefined, "noor");
    expect(cls.calls).toHaveLength(2);
    const { route } = await import("@/lib/models/route");
    expect(m.usd).toBe(costUsd(route("chat").model, { input_tokens: 100, output_tokens: 100 }));
  });

  it("the sector line reads an empty sector for a stored brand with no industry key", async () => {
    const u = await owner("aso-sector");
    const { industry: _gone, ...noIndustry } = BRAND;
    void _gone;
    expect(() => system(noIndustry as Brand, u, [], "", [], [], "noor")).not.toThrow();
    expect(system(noIndustry as Brand, u, [], "", [], [], "noor")[2].text).not.toContain("SECTOR:");
  });
});

describe("rule 801: the items of a batch", () => {
  it("items: 1 of a full batch of 10 refused in enforce: 9 saved, ceil(cost/10) refunded, held 1", async () => {
    const u = await owner("aso-items");
    const start = await credits(u.email);
    sdk.items = sdk.full;
    cls.decide = refuseTitle("بند 2");
    const r = await batch(u, modes("enforce"));
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    const cost = TASK_COST.social;
    const back = Math.ceil(cost / 10);
    const kept = sdk.full.map((i) => i.title).filter((t) => t !== "بند 2");
    expect(r.held).toBe(1);
    expect(r.short, "a full batch is not a short one").toBeUndefined();
    expect(r.refunded, "the refund that landed").toBe(back);
    expect(r.tasks.map((t) => t.title)).toEqual(kept);
    expect((await listTasks(sc(u))).map((t) => t.title).sort()).toEqual([...kept].sort());
    expect(await credits(u.email)).toBe(start - cost + back);
    expect(r.credits).toBe(start - cost + back);
    expect(r.cost, "what the balance lost").toBe(cost - back);
    // The receipt's refund brings the agent's monthly counter down with the balance.
    expect(agentSpendFor((await getUser(u.email))!, sc(u)).noor).toBe(cost - back);
    const row = (await listActivity(sc(u))).rows.find((a) => a.kind === "generated")!;
    expect(row.credits).toBe(cost - back);
    expect(row.count).toBe(9);
    const log = await logOf(u.email);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ layer: "output", where: "items", mode: "enforce", verdict: "off_topic", agent: "noor" });
    expect(log[0].itemId).toMatch(/^[0-9a-f]{16}$/);
    expect(cls.calls).toHaveLength(10);
    expect(cls.calls[0]).toMatchObject({ kind: "output", agent: "noor", lang: "ar", brand: { name: BRAND.name, industry: BRAND.industry } });
  });

  it("items: a partial refund that fails is never claimed: held reported, refunded 0, no 'refunded' sentence", async () => {
    const u = await owner("aso-refund-fail");
    const start = await credits(u.email);
    const cost = TASK_COST.social;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fail.refund = true;
    cls.decide = refuseTitle("بند 2");
    const r = await batch(u, modes("enforce"));
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    expect(r.held).toBe(1);
    expect(r.refunded).toBe(0);
    expect(r.cost, "the balance lost the whole price").toBe(cost);
    expect(await credits(u.email)).toBe(start - cost);
    const line = err.mock.calls.find((c) => c[0] === "agent scope partial refund failed")!;
    expect(line).toBeDefined();
    expect(line[1]).toMatchObject({ error: "RefundStoreError" });
    expect(JSON.stringify(line), "no owner email in the log").not.toContain(u.email);
    // The owner-facing sentences: the chat tool, MCP and the web route.
    const out = await runTool(u, "generate_content", { type: "social", notes: "" }, [], [], undefined, { agent: "noor", modes: modes("enforce") });
    expect(out).toContain(" 1 item(s) were withheld as outside the team's work.");
    expect(out).not.toContain("refunded");
    await setModes(modes("enforce"));
    const mcp = await tool(u.email, "generate_content", { type: "social" });
    expect(mcp.content[0].text).toContain("1 item(s) were withheld as outside the team's work.");
    expect(mcp.content[0].text).not.toContain("refunded");
    const res = await generateRoute.POST(json("/api/generate", "POST", { type: "social" }));
    expect(await res.json()).toMatchObject({ ok: true, held: 1, refunded: 0 });
  });

  it("items: all refused: nothing saved, whole cost refunded, AgentScopeRefused", async () => {
    const u = await owner("aso-all");
    const start = await credits(u.email);
    cls.decide = () => "off_topic";
    const r = await batch(u, modes("enforce"));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "failed") throw new Error("expected failed");
    expect(r.error).toBeInstanceOf(AgentScopeRefused);
    expect((r.error as AgentScopeRefused).reply).toBe(OFF);
    expect(r.credits).toBe(start);
    expect(await credits(u.email)).toBe(start);
    expect(await listTasks(sc(u))).toEqual([]);
    expect(agentSpendFor((await getUser(u.email))!, sc(u)).noor ?? 0).toBe(0);
  });

  it("items: one refused in a once batch: the whole claim is refunded", async () => {
    const u = await owner("aso-once");
    const start = await credits(u.email);
    cls.decide = refuseTitle("بند 3");
    const r = await batch(u, modes("enforce"), { once: `weekly:${sc(u)}:test` });
    if (r.ok || r.reason !== "failed") throw new Error("expected failed");
    expect(r.error).toBeInstanceOf(AgentScopeRefused);
    expect(await credits(u.email)).toBe(start);
    expect((await getUser(u.email))!.paidOnce?.[`weekly:${sc(u)}:test`]).toBeUndefined();
    expect(await listTasks(sc(u))).toEqual([]);
  });

  it("items: shadow saves all and logs the refusals with itemId", async () => {
    const u = await owner("aso-shadow");
    const start = await credits(u.email);
    sdk.items = sdk.full;
    cls.decide = refuseTitle("بند 2");
    const r = await batch(u, modes("shadow"));
    if (!r.ok) throw new Error("refused");
    expect(r.tasks).toHaveLength(10);
    expect(r.held).toBeUndefined();
    expect(await credits(u.email)).toBe(start - TASK_COST.social);
    const log = await logOf(u.email);
    expect(log).toHaveLength(1);
    const two = r.tasks.find((t) => t.title === "بند 2")!;
    expect(log[0]).toMatchObject({ layer: "output", where: "items", mode: "shadow", verdict: "off_topic", itemId: two.id });
  });

  it("items: output off makes no classify call", async () => {
    const u = await owner("aso-off");
    const r = await batch(u, modes("off"));
    expect(r.ok).toBe(true);
    expect(cls.calls).toHaveLength(0);
  });

  it("items: a classifier error saves the item and logs error", async () => {
    const u = await owner("aso-items-err");
    cls.error = "timeout";
    const r = await batch(u, modes("enforce"));
    if (!r.ok) throw new Error("refused");
    expect(r.tasks).toHaveLength(3);
    expect((await logOf(u.email)).map((e) => e.verdict)).toEqual(["error", "error", "error"]);
  });

  it("items: classify runs through pmap, never one await per item", () => {
    const src = readFileSync("src/lib/generate-batch.ts", "utf8");
    expect(src).toContain("pmap(tasks");
  });

  it("chat tools: a partly held batch says so, and an all-refused batch is mapped", async () => {
    const u = await owner("aso-chat-tool");
    cls.decide = refuseTitle("بند 2");
    const actions: string[] = [];
    const out = await runTool(u, "generate_content", { type: "social", notes: "" }, actions, [], undefined, { agent: "noor", modes: modes("enforce") });
    expect(out).toContain("Created 2 social item(s)");
    expect(out).toContain(" 1 item(s) were withheld as outside the team's work, and their credits refunded.");
    sdk.items = [sdk.all[0]];
    cls.decide = () => "off_topic";
    const no = await runTool(u, "draft_items", { type: "social", count: 1, brief: "x" }, [], [], undefined, { agent: "noor", modes: modes("enforce") });
    expect(no).toBe(`Not done: ${OFF} Nothing was saved and the credits were refunded.`);
  });

  it("web route: all refused is 422 agent_scope with the reply and the balance; MCP is an isError text", async () => {
    const u = await owner("aso-web");
    await setModes(modes("enforce"));
    const start = await credits(u.email);
    cls.decide = () => "off_topic";
    const res = await generateRoute.POST(json("/api/generate", "POST", { type: "social" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "agent_scope", message: OFF, credits: start });
    const mcp = await tool(u.email, "generate_content", { type: "social" });
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toBe(OFF);
    expect(await credits(u.email)).toBe(start);
  });
});

describe("rule 802: MCP save_draft", () => {
  it("save_draft refused in enforce: not saved, isError, no credits, counted in the hourly draft rate", async () => {
    const u = await owner("aso-draft");
    await setModes(modes("enforce"));
    cls.decide = () => "other_business";
    const r = await tool(u.email, "save_draft", { type: "social", body: "إعلان لمطعم آخر في جدة" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(agentScopeRefusalText("other_business", "ar", { brand: BRAND.name, otherBrands: [] }));
    expect(await listTasks(sc(u))).toEqual([]);
    expect((await listActivity(sc(u))).rows.filter((a) => a.kind === "external_draft")).toEqual([]);
    expect(await credits(u.email), "no credits either way").toBe(50);
    // The order (ruling): the hourly draft rate is counted before the classifier, which it bounds, so a refused draft is
    // counted there, in both the hourly and the daily draft bucket (accepted: it bounds the classifier's spend).
    expect(Number(await db.get(`rate:draft:h:${u.email}`))).toBe(1);
    expect(Number(await db.get(`rate:draft:d:${u.email}`))).toBe(1);
    expect(cls.calls[0]).toMatchObject({ kind: "output", agent: "noor", text: "إعلان لمطعم آخر في جدة\n\nإعلان لمطعم آخر في جدة" });
    expect((await logOf(u.email))[0]).toMatchObject({ layer: "output", where: "save_draft", mode: "enforce", verdict: "other_business" });
  });

  it("save_draft classifier error: saved, logged", async () => {
    const u = await owner("aso-draft-err");
    await setModes(modes("enforce"));
    cls.error = "api";
    const r = await tool(u.email, "save_draft", { type: "social", title: "عرض", body: "قهوة اليوم بخصم" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ saved: true });
    expect(await listTasks(sc(u))).toHaveLength(1);
    expect((await logOf(u.email))[0]).toMatchObject({ layer: "output", where: "save_draft", verdict: "error", error: "api" });
  });

  it("save_draft over the hourly rate makes no classifier call", async () => {
    const u = await owner("aso-draft-rate");
    await setModes(modes("enforce"));
    await db.set(`rate:draft:h:${u.email}`, 1000);
    const r = await tool(u.email, "save_draft", { type: "social", body: "قهوة" });
    expect(r.isError).toBe(true);
    expect(cls.calls).toHaveLength(0);
  });
});

describe("rules 800-802 are listed in the coverage map", () => {
  it("each rule has a row in docs/system/tests/0790-agent-scope.md, and no range row reserves them", () => {
    for (const n of [800, 801, 802]) expect(coverageRow(n), String(n)).toMatch(new RegExp(`^\\| ${n} \\|`));
    // Task 9 removed the range row (803-808 went unused: the later rules are 1410-1415); a range row that comes back must start above 802.
    const start = readFileSync("docs/system/tests/0790-agent-scope.md", "utf8").match(/^\| (\d+)-\d+ \| Reserved for agent scope/m);
    if (start) expect(Number(start[1])).toBeGreaterThan(802);
  });
});
