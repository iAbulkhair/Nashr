import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pricing phase 2 (rules 308-314): the plan's chat messages, what happens when they run out, the hard per-message
 * guards, and what they cost against the margin floor. The model is scripted: every call answers what the test says
 * and records what it was sent (the messages and `max_tokens`).
 */
type Seen = { model: string; max_tokens: number; messages: { role: string; content: unknown }[] };
const h = vi.hoisted(() => ({ turns: [] as (() => unknown)[], seen: [] as Seen[] }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      // The agent-scope classifier streams since the 2026-10-12 build batch (rule 980) and forces its `verdict` tool. It gets
      // no answer here, as when it called the `create` this mock never had, so the scripted turns stay the chat's.
      stream: (args: Seen) => ((args as { tool_choice?: { name?: string } }).tool_choice?.name === "verdict" ? { finalMessage: async () => { throw new Error("no classifier in this test"); } } : {
        finalMessage: async () => {
          h.seen.push(structuredClone(args));
          const next = h.turns.shift();
          if (!next) throw new Error("no scripted model turn left");
          return next();
        },
      }),
    };
  },
}));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));

import { db } from "@/lib/db";
import { acct, currentUser, getUser, saveUser, type User } from "@/lib/auth";
import { CHAT_ALLOWANCE, CHAT_TURN_MAX_USD, MARGIN_FLOOR, MAX_CHAT_OVERRIDE, chatAllowanceOf, chatOverflowHold, cheapestCreditUsd, maxCostPerCreditUsd } from "@/lib/pricing";
import { CHAT_FIRST_MIN_OUT, CHAT_HISTORY_MAX_CHARS, CHAT_HISTORY_MAX_MSGS, CHAT_HISTORY_MSG_MAX_CHARS, CHAT_MAX_OUT, CHAT_MIN_OUT, fitFirstCall, inputEstimateUsd, nextMaxTokens, trimHistory } from "@/lib/chat-budget";
import { CHAT_MODEL, chat, history } from "@/lib/chat";
import { chatStatus, reserveChatTurn, settleChatTurn } from "@/lib/chat-allowance";
import { settleChatOverflow } from "@/lib/credits";
import { chatCredKey, chatMsgKey, chatOverKey, chatTrialKey, costUsd, hasRate, usageMonthKeys } from "@/lib/usage";
import { monthKey } from "@/lib/credits";
import { wipeAccount } from "@/lib/account";
import { createMcpToken } from "@/lib/mcp";
import { json, newMember, newUser, signIn } from "./helpers/session";
import { saveBrand, type Brand } from "@/lib/brand";
import * as chatRoute from "@/app/api/chat/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as overflowRoute from "@/app/api/billing/chat-overflow/route";
import { readFileSync } from "fs";
import { join } from "path";

let k = 0;
type Usage = { input_tokens: number; output_tokens: number };
const CHEAP: Usage = { input_tokens: 1000, output_tokens: 200 };
const reply = (text: string, usage: Usage = CHEAP) => () => ({ content: [{ type: "text", text }], stop_reason: "end_turn", model: CHAT_MODEL, usage });
const toolUse = (usage: Usage) => () => ({ content: [{ type: "tool_use", id: `tu${++k}`, name: "list_inbox", input: {} }], stop_reason: "tool_use", model: CHAT_MODEL, usage });
const micro = (u: Usage) => Math.round(costUsd(CHAT_MODEL, u) * 1e6);
const creditMicro = () => Math.round(maxCostPerCreditUsd() * 1e6);

/** A signed-in owner on `plan`, its month counter set to `used`. */
async function owner(plan: User["plan"] = "starter", used = 0, extra: Partial<User> = {}): Promise<User> {
  const u = await newUser("ca");
  await saveUser({ ...u, plan, credits: 300, ...extra });
  if (used) await db.set(plan === "trial" ? chatTrialKey(acct(u)) : chatMsgKey(acct(u)), used);
  await signIn(u.email);
  return (await currentUser())!;
}
const send = (text = "مرحبا") => chatRoute.POST(json("/api/chat", "POST", { text }));
const count = async (u: Pick<User, "id" | "email" | "plan">) => Number((await db.get<number>(u.plan === "trial" ? chatTrialKey(acct(u)) : chatMsgKey(acct(u)))) ?? 0);
const ask = async (token: string, message: unknown) =>
  (await (await mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_noor", arguments: { message } } }) }))).json()) as { result: { content: { text: string }[]; isError?: boolean } };

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  h.turns = [];
  h.seen = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the plan's chat messages (rule 308)", () => {
  it("the table is the founder's: trial 30 once, then 250 / 650 / 1,300 a month", () => {
    expect(CHAT_ALLOWANCE).toEqual({ trial: 30, starter: 250, pro: 650, business: 1300 });
  });
  it("chatAllowanceOf: the plan's; Agency is Business's; a valid founder override wins, 0 included; anything else is ignored", () => {
    expect(chatAllowanceOf({ plan: "trial" })).toBe(30);
    expect(chatAllowanceOf({ plan: "pro" })).toBe(650);
    expect(chatAllowanceOf({ plan: "agency" })).toBe(1300);
    expect(chatAllowanceOf({ plan: "agency", chatAllowance: 5000 })).toBe(5000);
    expect(chatAllowanceOf({ plan: "starter", chatAllowance: 0 })).toBe(0);
    for (const bad of [-1, 1.5, Number.NaN, MAX_CHAT_OVERRIDE + 1, "900" as unknown as number]) expect(chatAllowanceOf({ plan: "starter", chatAllowance: bad })).toBe(250);
    expect(chatAllowanceOf({ plan: "enterprise" as User["plan"] })).toBe(1300);
    expect(chatAllowanceOf({ plan: "gold" as User["plan"] })).toBe(0);
  });
});

describe("messages are counted per account, before the turn (rule 309)", () => {
  it("the last message of the month is answered; the next is refused with 402 before it is saved or sent to the model", async () => {
    const u = await owner("starter", 249);
    h.turns.push(reply("أهلاً"));
    const r = await send("الأخيرة");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.chat).toMatchObject({ used: 250, allowance: 250, left: 0, period: "month", overflow: { on: false, available: true } });
    expect(await count(u)).toBe(250);
    const refused = await send("بعد الحد");
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ ok: false, error: "chat_allowance", chat: { left: 0 } });
    expect(h.seen).toHaveLength(1);
    expect((await history(acct(u))).map((m) => m.content)).not.toContain("بعد الحد");
    expect(await count(u)).toBe(250);
  });
  it("a turn that failed, or never reached the model, is given back", async () => {
    const u = await owner("starter", 10);
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.turns.push(() => { throw new Error("overloaded"); });
    expect((await send()).status).toBe(502);
    expect(await count(u)).toBe(10);
    h.turns.push(reply("…", { input_tokens: 0, output_tokens: 0 }));
    expect((await send()).status).toBe(200);
    expect(await count(u)).toBe(10);
    h.turns.push(reply("ok"));
    expect((await send()).status).toBe(200);
    expect(await count(u)).toBe(11);
  });
  it("parallel messages never pass the allowance", async () => {
    const u = await owner("starter", 245);
    const gates = await Promise.all(Array.from({ length: 20 }, () => reserveChatTurn(u, CHAT_MODEL)));
    expect(gates.filter((g) => g.ok)).toHaveLength(5);
    expect(await count(u)).toBe(250);
  });
  it("the trial's messages are counted once for the trial, not per month", async () => {
    const u = await owner("trial", 29);
    h.turns.push(reply("ok"));
    expect((await send()).status).toBe(200);
    expect(await db.get(chatTrialKey(acct(u)))).toBe(30);
    expect(await db.get(chatMsgKey(acct(u)))).toBeNull();
    const r = await send();
    expect(r.status).toBe(402);
    expect((await r.json()).chat).toMatchObject({ period: "trial", overflow: { available: false } });
  });
  it("a member's messages count on the account's one counter", async () => {
    const u = await owner("pro", 3);
    const m = await newMember(u);
    await signIn(m.email);
    h.turns.push(reply("ok"));
    expect((await send()).status).toBe(200);
    expect(await count(u)).toBe(4);
  });
  it("MCP ask_noor counts on the same counter, is refused in plain words when it is used up, and an empty message counts nothing", async () => {
    const u = await owner("starter", 249);
    const token = await createMcpToken(acct(u));
    expect((await ask(token, "   ")).result.isError).toBe(true);
    expect(await count(u)).toBe(249);
    h.turns.push(reply("done"));
    const ok = await ask(token, "hello");
    expect(ok.result.isError).toBeUndefined();
    expect(ok.result.content[0].text).toContain("[chat: 0 of 250 messages left this month]");
    const no = await ask(token, "again");
    expect(no.result.isError).toBe(true);
    expect(no.result.content[0].text).toMatch(/^Chat paused: this account used its 250 chat messages this month/);
    expect(h.seen).toHaveLength(1);
  });
});

describe("past the allowance: paused, or continued on credits when the owner says so (rule 310)", () => {
  it("only the owner switches it, only with a real boolean, never on a trial", async () => {
    const u = await owner("starter");
    const m = await newMember(u, "admin");
    await signIn(m.email);
    expect((await overflowRoute.POST(json("/api/billing/chat-overflow", "POST", { on: true }))).status).toBe(403);
    await signIn(u.email);
    expect((await overflowRoute.POST(json("/api/billing/chat-overflow", "POST", { on: "yes" }))).status).toBe(400);
    const r = await overflowRoute.POST(json("/api/billing/chat-overflow", "POST", { on: true }));
    expect(r.status).toBe(200);
    expect((await r.json()).chat.overflow.on).toBe(true);
    expect((await getUser(acct(u)))!.chatOverflow).toBe(true);
    await overflowRoute.POST(json("/api/billing/chat-overflow", "POST", { on: false }));
    expect((await getUser(acct(u)))!.chatOverflow).toBeUndefined();
    const t = await owner("trial");
    expect((await overflowRoute.POST(json("/api/billing/chat-overflow", "POST", { on: true }))).status).toBe(409);
    expect((await getUser(acct(t)))!.chatOverflow).toBeUndefined();
  });
  it("each message is billed its metered cost at the floor rate, the remainder carried, never a credit each", async () => {
    const u = await owner("starter", 250, { chatOverflow: true });
    const usage: Usage = { input_tokens: 10_000, output_tokens: 2_000 };
    const price = creditMicro();
    let carry = 0;
    let credits = 300;
    for (let i = 0; i < 3; i++) {
      h.turns.push(reply("ok", usage));
      const j = await (await send()).json();
      carry += micro(usage);
      const charged = Math.floor(carry / price);
      carry -= charged * price;
      credits -= charged;
      expect(j).toMatchObject({ ok: true, charged, credits });
      expect(j.chat.overflow.used).toBe(i + 1);
    }
    expect((await getUser(acct(u)))!).toMatchObject({ credits, chatCarryMicro: carry });
    expect(await count(u)).toBe(250);
    expect(await db.get(chatOverKey(acct(u)))).toBe(3);
    expect(Number((await db.get(chatCredKey(acct(u)))) ?? 0)).toBe(300 - credits);
  });
  it("too few credits for the hold: 402 chat_credits, nothing charged or sent", async () => {
    const u = await owner("starter", 250, { chatOverflow: true, credits: chatOverflowHold() - 1 });
    const r = await send();
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "chat_credits", credits: chatOverflowHold() - 1 });
    expect((await getUser(acct(u)))!.credits).toBe(chatOverflowHold() - 1);
    expect(h.seen).toHaveLength(0);
  });
  it("a failed message is neither billed nor counted", async () => {
    const u = await owner("starter", 250, { chatOverflow: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.turns.push(() => { throw new Error("overloaded"); });
    expect((await send()).status).toBe(502);
    expect((await getUser(acct(u)))!.credits).toBe(300);
    expect(await db.get(chatOverKey(acct(u)))).toBe(0);
  });
  it("nothing is held before the turn, so the turn's own tools can spend the whole balance", async () => {
    const u = await owner("starter", 250, { chatOverflow: true, credits: chatOverflowHold() });
    const g = await reserveChatTurn(u, CHAT_MODEL);
    expect(g).toMatchObject({ ok: true, mode: "overflow", hold: chatOverflowHold() });
    expect((await getUser(acct(u)))!.credits).toBe(chatOverflowHold());
    if (g.ok) await settleChatTurn(u, g, null);
    expect((await getUser(acct(u)))!.credits).toBe(chatOverflowHold());
  });
  it("a message is billed at most the hold, never more than the balance left, and the carry stays under one credit", async () => {
    const u = await owner("starter");
    const hold = chatOverflowHold();
    expect(await settleChatOverflow(acct(u), hold, 50_000_000, creditMicro())).toEqual({ credits: 300 - hold, charged: hold });
    expect((await getUser(acct(u)))!.chatCarryMicro).toBeLessThan(creditMicro());
    await saveUser({ ...(await getUser(acct(u)))!, credits: 1, chatCarryMicro: 0 });
    expect(await settleChatOverflow(acct(u), hold, 3 * creditMicro(), creditMicro())).toEqual({ credits: 0, charged: 1 });
    await expect(settleChatOverflow(acct(u), -1, 1, creditMicro())).rejects.toThrow(/invalid_hold/);
    await expect(settleChatOverflow(acct(u), hold, Number.NaN, creditMicro())).rejects.toThrow(/invalid_cost/);
  });
  it("a founder allowance of 0 stops chat for the account, even with continue-on-credits on", async () => {
    const u = await owner("pro", 0, { chatOverflow: true, chatAllowance: 0 });
    const r = await send();
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "chat_allowance", chat: { allowance: 0, left: 0 } });
    expect(h.seen).toHaveLength(0);
    expect((await getUser(acct(u)))!.credits).toBe(300);
  });
  it("over MCP a message continued on credits says so, with what it was billed", async () => {
    const u = await owner("starter", 250, { chatOverflow: true });
    const token = await createMcpToken(acct(u));
    const usage: Usage = { input_tokens: 10_000, output_tokens: 2_000 };
    h.turns.push(reply("done", usage));
    const r = await ask(token, "hello");
    const billed = Math.floor(micro(usage) / creditMicro());
    expect(r.result.content[0].text).toContain(`[chat: this month's 250 messages are used; this message continued on credits and was billed ${billed} credit${billed === 1 ? "" : "s"}]`);
    expect((await getUser(acct(u)))!.credits).toBe(300 - billed);
  });
  it("the switch is rate limited per account", async () => {
    await owner("starter");
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await overflowRoute.POST(json("/api/billing/chat-overflow", "POST", { on: i % 2 === 0 }))).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });
  it("the gate refuses with the account's status when overflow is off", async () => {
    const u = await owner("business", 1300);
    const g = await reserveChatTurn(u, CHAT_MODEL);
    expect(g).toMatchObject({ ok: false, error: "chat_allowance", status: { used: 1300, allowance: 1300, left: 0, counted: 1300 } });
    expect(await chatStatus(u, CHAT_MODEL)).toMatchObject({ used: 1300, left: 0 });
    const ok = await reserveChatTurn({ ...u, chatAllowance: 1301 }, CHAT_MODEL);
    expect(ok.ok).toBe(true);
    if (ok.ok) await settleChatTurn(u, ok, null);
    expect(await count(u)).toBe(1300);
  });
});

describe("the hard per-message ceiling (rule 311)", () => {
  it("nextMaxTokens: what is left of the ceiling at the output rate, at most CHAT_MAX_OUT, 0 below CHAT_MIN_OUT or on bad numbers", () => {
    expect(nextMaxTokens(CHAT_MODEL, 0, 0)).toBe(CHAT_MAX_OUT);
    const out = costUsd(CHAT_MODEL, { output_tokens: 1 });
    const spent = CHAT_TURN_MAX_USD * 0.4, input = CHAT_TURN_MAX_USD * 0.1;
    const n = nextMaxTokens(CHAT_MODEL, spent, input);
    expect(n).toBe(Math.min(CHAT_MAX_OUT, Math.floor((CHAT_TURN_MAX_USD - spent - input) / out)));
    expect(spent + input + n * out).toBeLessThanOrEqual(CHAT_TURN_MAX_USD + 1e-9);
    expect(nextMaxTokens(CHAT_MODEL, CHAT_TURN_MAX_USD - (CHAT_MIN_OUT - 1) * out, 0)).toBe(0);
    expect(nextMaxTokens(CHAT_MODEL, Number.NaN, 0)).toBe(0);
    expect(nextMaxTokens(CHAT_MODEL, 0, Number.POSITIVE_INFINITY)).toBe(0);
    // The first call prices the cached prefix as a cache write, later calls as a cache read; the rest at the input rate.
    expect(inputEstimateUsd(CHAT_MODEL, { cached: 1000, fresh: 500 }, true)).toBeCloseTo(costUsd(CHAT_MODEL, { cache_creation_input_tokens: 1000, input_tokens: 500 }), 12);
    expect(inputEstimateUsd(CHAT_MODEL, { cached: 1000, fresh: 500 }, false)).toBeCloseTo(costUsd(CHAT_MODEL, { cache_read_input_tokens: 1000, input_tokens: 500 }), 12);
  });
  it("the tool loop stops when the next call would not fit, with a plain reply, and every call's output fits what was left", async () => {
    const u = await owner("starter");
    const dear: Usage = { input_tokens: 20_000, output_tokens: 2_000 };
    h.turns.push(toolUse(dear), toolUse(dear), toolUse(dear), reply("never reached"));
    const m = await chat(u, "do a lot", undefined, "noor", { lang: "en" });
    expect(h.seen).toHaveLength(2);
    expect(m.content).toMatch(/^This reply reached its limit, so I stopped here/);
    expect(m.usd).toBeCloseTo(2 * costUsd(CHAT_MODEL, dear), 6);
    expect(m.usd!).toBeLessThanOrEqual(CHAT_TURN_MAX_USD);
    for (const s of h.seen) {
      expect(s.model).toBe(CHAT_MODEL);
      expect(s.max_tokens).toBeGreaterThanOrEqual(CHAT_MIN_OUT);
      expect(s.max_tokens).toBeLessThanOrEqual(CHAT_MAX_OUT);
    }
    // The second call's output was capped to what the first left, after an upper estimate of its input.
    const outRate = costUsd(CHAT_MODEL, { output_tokens: 1 });
    expect(costUsd(CHAT_MODEL, dear) + h.seen[1].max_tokens * outRate).toBeLessThan(CHAT_TURN_MAX_USD);
  });
  it("a call cut off at its cap is never acted on: its tool calls do not run, its text is kept and marked", async () => {
    const u = await owner("starter");
    h.turns.push(() => ({ content: [{ type: "text", text: "Here is the start" }, { type: "tool_use", id: "cut1", name: "write_file", input: { name: "x.md", content: "par" } }], stop_reason: "max_tokens", model: CHAT_MODEL, usage: CHEAP }));
    const m = await chat(u, "write a long file", undefined, "noor", { lang: "en" });
    expect(h.seen).toHaveLength(1);
    expect(m.content).toMatch(/^Here is the start\n\n\(The reply was cut off at its limit/);
    expect(m.actions).toEqual([]);
  });
  it("a limit a tool hit still raises its dialog when the loop ends without a closing answer", async () => {
    const u = await owner("starter", 0, { credits: 0 });
    const brand: Brand = { name: "Rose", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "coffee", audience: "Riyadh", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "Riyadh", updatedAt: new Date().toISOString() };
    await saveBrand(acct(u), brand);
    h.turns.push(() => ({ content: [{ type: "tool_use", id: `tu${++k}`, name: "draft_items", input: { type: "social", count: 1, brief: "eid" } }], stop_reason: "tool_use", model: CHAT_MODEL, usage: CHEAP }));
    h.turns.push(() => ({ content: [{ type: "text", text: "No cred" }], stop_reason: "max_tokens", model: CHAT_MODEL, usage: CHEAP }));
    const m = await chat(u, "one caption", undefined, "noor", { lang: "en" });
    expect(m.limit).toBe("credits");
    expect(m.actions?.some((a) => a.startsWith("limit:"))).toBe(false);
  });
  it("the turn's model cost is never sent to the browser", async () => {
    await owner("starter");
    h.turns.push(reply("ok"));
    const j = await (await send()).json();
    expect(j.message).not.toHaveProperty("usd");
  });
  it("chat runs on Sonnet 5.5 under a $0.14 ceiling: the same 14,000 output tokens a message had under $0.35 on Opus 5 ($25/M, removed by rule 970), and a 2-credit hold", () => {
    expect(CHAT_MODEL).toBe("claude-sonnet-5-5");
    expect(CHAT_TURN_MAX_USD).toBe(0.14);
    expect(chatOverflowHold()).toBe(2);
    const tokensUnder = (ceiling: number, model: string) => ceiling / costUsd(model, { output_tokens: 1 });
    expect(tokensUnder(CHAT_TURN_MAX_USD, CHAT_MODEL)).toBeCloseTo(0.35 / 25e-6, 6);
  });
  it("a turn the model refuses says so, never \"Done\", and is still metered", async () => {
    const u = await owner("starter");
    h.turns.push(() => ({ content: [], stop_reason: "refusal", model: CHAT_MODEL, usage: CHEAP }));
    const m = await chat(u, "something it declines", undefined, "noor", { lang: "en" });
    expect(h.seen).toHaveLength(1);
    expect(m.content).toMatch(/^I couldn't complete this request\. Try wording it another way/);
    expect(m.usd).toBeCloseTo(costUsd(CHAT_MODEL, CHEAP), 9);
    h.turns.push(() => ({ content: [], stop_reason: "refusal", model: CHAT_MODEL, usage: CHEAP }));
    expect((await chat(u, "مرة ثانية", undefined, "noor", { lang: "ar" })).content).toMatch(/^لم أستطع إكمال هذا الطلب/);
  });
  it("the code passes the computed cap and the turn's one model (the caller's, else route), never a typed 8000", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/chat.ts"), "utf8");
    expect(src).toContain("max_tokens: maxTokens");
    // Resolved once per turn and used by the first-call fit, every later cap and every stream; CHAT_MODEL is only the export.
    expect(src).toContain('const model = opts.model ?? route("chat").model;');
    expect(src).toContain(".stream({ model, max_tokens: maxTokens");
    expect(src.match(/\bCHAT_MODEL\b/g)).toHaveLength(1);
    expect(src).not.toMatch(/max_tokens: 8000/);
  });
});

describe("the history guard (rule 312)", () => {
  const msg = (role: "user" | "assistant", n: number) => ({ role, content: `${role}${n} `.padEnd(5000, "x") });
  it("keeps the newest that fit and cuts long ones", () => {
    const thread = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? "assistant" : "user", i));
    thread.push({ role: "user", content: "y".repeat(9000) });
    const out = trimHistory(thread);
    expect(out.length).toBeLessThanOrEqual(CHAT_HISTORY_MAX_MSGS);
    expect(out.at(-1)!.content).toBe(`${"y".repeat(CHAT_HISTORY_MSG_MAX_CHARS)}…`);
    expect(out.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(CHAT_HISTORY_MAX_CHARS);
  });
  it("the first-run onboarding messages, written before the owner says anything, are still sent", () => {
    const thread = [{ role: "assistant" as const, content: "intro" }, { role: "assistant" as const, content: "files" }, { role: "user" as const, content: "hi" }];
    expect(trimHistory(thread)).toEqual(thread);
  });
  it("a full workspace shortens the thread from its oldest end until the first call has room for a full answer", () => {
    const msgs = Array.from({ length: 16 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `${i}`.padEnd(1500, "x") }));
    const roomy = fitFirstCall(CHAT_MODEL, msgs, 20_000, 2_000);
    expect(roomy).toEqual({ messages: msgs, maxTokens: CHAT_MAX_OUT });
    const full = fitFirstCall(CHAT_MODEL, msgs, 105_000, 8_000);
    expect(full.maxTokens).toBeGreaterThanOrEqual(CHAT_FIRST_MIN_OUT);
    expect(full.messages.length).toBeLessThan(msgs.length);
    expect(full.messages.at(-1)).toBe(msgs.at(-1));
    const huge = fitFirstCall(CHAT_MODEL, msgs, 200_000, 8_000);
    expect(huge).toEqual({ messages: [msgs.at(-1)], maxTokens: 0 });
  });
  it("the newest message is always sent, even alone over the limit", () => {
    expect(trimHistory([{ role: "user", content: "z".repeat(50_000) }])).toHaveLength(1);
  });
  it("chat() sends the trimmed thread", async () => {
    const u = await owner("starter");
    for (let i = 0; i < 30; i++) await db.lpush(`chat:${acct(u)}`, JSON.stringify({ ...msg(i % 2 ? "assistant" : "user", i), at: new Date().toISOString() }));
    h.turns.push(reply("ok"));
    await chat(u, "latest", undefined, "noor", { lang: "en" });
    const sent = h.seen[0].messages as { content: string }[];
    expect(sent.at(-1)!.content).toBe("latest");
    expect(sent.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(CHAT_HISTORY_MAX_CHARS);
  });
});

describe("chat against the margin floor (rule 313)", () => {
  it("the hold covers the ceiling at the floor rate, and is the smallest that does", () => {
    const hold = chatOverflowHold();
    expect(hold * maxCostPerCreditUsd()).toBeGreaterThanOrEqual(CHAT_TURN_MAX_USD);
    expect((hold - 1) * maxCostPerCreditUsd()).toBeLessThan(CHAT_TURN_MAX_USD);
  });
  it("an over-allowance message is billed at the floor rate: 60% margin on the cheapest credit, more on every other", () => {
    expect(maxCostPerCreditUsd()).toBeCloseTo((1 - MARGIN_FLOOR) * cheapestCreditUsd(), 12);
  });
  it("the chat model has its own rate (an unknown id would be priced as Opus)", () => {
    expect(hasRate(CHAT_MODEL)).toBe(true);
  });
});

describe("the counters go with the account (rule 314)", () => {
  it("usageMonthKeys lists the month's chat counters, and wipeAccount deletes them and the trial's", async () => {
    const u = await newUser("cw");
    const m = monthKey();
    expect(usageMonthKeys(acct(u), m)).toEqual(expect.arrayContaining([chatMsgKey(acct(u), m), chatOverKey(acct(u), m), chatCredKey(acct(u), m)]));
    await Promise.all([db.set(chatMsgKey(acct(u)), 7), db.set(chatOverKey(acct(u)), 2), db.set(chatCredKey(acct(u)), 3), db.set(chatTrialKey(acct(u)), 30)]);
    await wipeAccount(acct(u));
    expect(await Promise.all([db.get(chatMsgKey(acct(u))), db.get(chatOverKey(acct(u))), db.get(chatCredKey(acct(u))), db.get(chatTrialKey(acct(u)))])).toEqual([null, null, null, null]);
  });
});
