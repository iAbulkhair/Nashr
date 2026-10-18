import { db } from "./db";
import type { User } from "./auth";
import { settleChatOverflow } from "./credits";
import { chatAllowanceOf, maxCostPerCreditUsd } from "./pricing";
import { chatHoldFor, chatUnitsFor } from "./models/credits";
import { modelById } from "./models/catalog";
import { chatCredKey, chatMsgKey, chatOverKey, chatTrialKey } from "./usage";
import type { ChatTurn } from "./chat";
import { fairUseGate, fairUseText, type FairUseRefusal } from "./fair-use";
import { log } from "./log";
import { acct } from "./account-id";

/**
 * The chat allowance (pricing phase 2, rules 308-310): every owner message (one turn, however many model calls it takes)
 * is counted per account, shared by every seat, brand and connected app (`acct(u)`, the account's id). A paid plan
 * counts per UTC calendar month (`chatMsgKey`), a trial once for the whole trial (`chatTrialKey`), against
 * `chatAllowanceOf` (src/lib/pricing.ts).
 *
 * The count is reserved before the turn and given back when the turn failed or never reached the model (paused, mock),
 * so only answered messages count. When the allowance is used up, chat pauses until the next month, unless the owner
 * turned "continue on credits" on (`User.chatOverflow`, paid plans only, never with a founder allowance of 0, which
 * stops chat for the account): then the turn goes ahead only while the
 * balance covers `chatOverflowHold()` credits (the most a message can cost), and after it the metered cost is billed at
 * the floor rate, at most that much (`settleChatOverflow`). Nothing is held before the turn, so the turn's own tools can
 * spend the whole balance. Both web chat and MCP `ask_noor` go through here, before `chat()` saves the owner's message.
 *
 * By model tier (spec 2026-10-08-straitly-model-routing, section 6; coordinator ruling 2026-10-08, option a): a message
 * counts `chatUnitsFor(model)` = ceil(its chat multiplier) messages of the allowance (1 on the default Sonnet 5.5, 2 on
 * Opus 5), its per-message ceiling is the model's own (`chatTurnMaxUsd`, src/lib/chat-budget.ts), so each unit still
 * carries at most CHAT_TURN_MAX_USD, and its overflow hold is the model's own (`chatHoldFor`: 2 and 4). The units are
 * computed once, in `reserveChatTurn`, and carried on the gate: the settle gives back `gate.units` on the counter it took
 * them from, never a count worked out again. A message whose units would pass the allowance is refused (or goes wholly on
 * credits) before any model call, even when fewer messages are left than it counts.
 */

/** What the app and the founder console show: messages used of the allowance, and the over-allowance settings. */
export type ChatStatus = {
  /** Messages used, at most the allowance (what the owner is shown). */
  used: number;
  allowance: number;
  left: number;
  /** The raw count, which can pass the allowance after it was lowered mid-period (the founder console's cost per message). */
  counted: number;
  /** "trial": granted once for the trial; "month": renews on the 1st (UTC). */
  period: "trial" | "month";
  /** `used`: messages continued on credits this month; `credits`: what they were billed; `hold`: the most one can cost. */
  overflow: { on: boolean; available: boolean; used: number; credits: number; hold: number };
};

type Refusal = { ok: false; error: "chat_allowance" | "chat_credits"; status: ChatStatus; credits: number; need?: number };
/** The fair-use stop (src/lib/fair-use.ts, rule 1722): the account's cost this month reached 95% of what it paid. */
type FairUseStop = { ok: false; error: FairUseRefusal["error"]; fairUse: FairUseRefusal; status: ChatStatus; credits: number };
/**
 * `units`: the messages this turn counts (`chatUnitsFor(model)`), on `key`; `model`: the catalog id they were computed
 * for. The caller must run the turn on that same model, or the count and the ceiling would price another model: the chat
 * routes resolve the turn's model once (`chatRouteFor`, the conversation's pick or automatic; MCP `route("chat")`), reserve
 * with it and hand `gate.model` to `chat()` (tests/model-route-calls.test.ts, tests/model-override.test.ts).
 */
type Reserved = { ok: true; key: string; units: number; model: string; status: ChatStatus };
export type ChatGate = (Reserved & { mode: "included" }) | (Reserved & { mode: "overflow"; hold: number }) | Refusal | FairUseStop;
export type ChatReserved = Extract<ChatGate, { ok: true }>;

// By account id (rule 1985), like the overflow and credit counters next to it.
const counterKey = (u: Pick<User, "id" | "email" | "plan">) => (u.plan === "trial" ? chatTrialKey(acct(u)) : chatMsgKey(acct(u)));
/** "Continue on credits" is offered on paid plans only: the trial's chat is its 30 messages. */
export const overflowAvailable = (u: Pick<User, "plan">) => u.plan !== "trial";
const overflowOn = (u: Pick<User, "plan" | "chatOverflow">) => overflowAvailable(u) && u.chatOverflow === true;
const creditMicro = () => Math.round(maxCostPerCreditUsd() * 1e6);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

function statusOf(u: Pick<User, "plan" | "chatOverflow" | "chatAllowance">, counted: number, overUsed: number, overCredits: number, hold: number): ChatStatus {
  const allowance = chatAllowanceOf(u);
  const used = Math.max(0, Math.min(allowance, counted));
  return {
    used,
    allowance,
    left: Math.max(0, allowance - used),
    counted: Math.max(0, counted),
    period: u.plan === "trial" ? "trial" : "month",
    overflow: { on: overflowOn(u), available: overflowAvailable(u), used: Math.max(0, overUsed), credits: Math.max(0, overCredits), hold },
  };
}

/**
 * The account's chat status now: up to three reads, in parallel. `model`: the chat model whose hold is shown, required
 * (coordinator ruling 2026-10-08): a conversation's routed model (`chatRouteFor`, src/lib/models/overrides.ts), or
 * `route("chat").model` where no conversation is in view (the account's pages and the founder console).
 */
export async function chatStatus(u: Pick<User, "email" | "plan" | "chatOverflow" | "chatAllowance">, model: string): Promise<ChatStatus> {
  const trial = u.plan === "trial";
  const [counted, over, cred] = await Promise.all([db.get<number>(counterKey(u)), trial ? 0 : db.get<number>(chatOverKey(acct(u))), trial ? 0 : db.get<number>(chatCredKey(acct(u)))]);
  return statusOf(u, num(counted), num(over), num(cred), chatHoldFor(model));
}

/**
 * Reserve the turn's messages before the turn: `chatUnitsFor(model)` of them, computed here once and carried on the gate.
 * Inside the allowance: counted (INCRBY by the units, so N parallel turns can never pass it). Past it, by even one unit:
 * the reservation is taken back, and the turn goes ahead only when the owner turned overflow on and the balance covers the
 * most the message can cost (`chatHoldFor(model)`), counted by the same units on the month's overflow counter; otherwise
 * `chat_allowance` (paused) or `chat_credits` (overflow on, too few credits). `model` is the turn's chat model, required
 * (coordinator ruling 2026-10-08): the routes pass the turn's routed model, a conversation's pick when it passed
 * `route("chat")`. An id that is not exactly a catalog id (`unknown_model`), an entry the routing may not offer (neither
 * `auto` nor `pick`: `model_not_offered`), one without tool use (`model_not_chat`), or a chat multiplier that is not a
 * finite number above 0 (`chat_allowance_unpriced`) throws before anything is counted.
 */
export async function reserveChatTurn(u: User, model: string): Promise<ChatGate> {
  const entry = modelById(model);
  if (!entry) throw new Error("unknown_model");
  // Only a model the routing may offer (the set the floor tests cover), and one that can run chat's tools.
  if (!entry.auto && !entry.pick) throw new Error(`model_not_offered:${entry.id}`);
  if (!entry.caps.tools) throw new Error(`model_not_chat:${entry.id}`);
  const units = chatUnitsFor(entry.id);
  const hold = chatHoldFor(entry.id);
  // The fair-use stop (rule 1722), before anything is counted: a paused account counts no message and spends no credit,
  // included or on credits. The trial is not gated here (its 30 messages are its limit).
  const stop = await fairUseGate(u);
  if (stop) return { ok: false, error: stop.error, fairUse: stop, status: await chatStatus(u, model), credits: Math.max(0, num(u.credits)) };
  const key = counterKey(u);
  const allowance = chatAllowanceOf(u);
  const n = await db.incrby(key, units);
  if (n <= allowance) return { ok: true, mode: "included", key, units, model: entry.id, status: statusOf(u, n, 0, 0, hold) };
  await db.incrby(key, -units);
  const credits = Math.max(0, num(u.credits));
  // An allowance of 0 is the founder turning chat off for the account: no message, not even on credits.
  if (!overflowOn(u) || allowance === 0) return { ok: false, error: "chat_allowance", status: await chatStatus(u, model), credits };
  if (credits < hold) return { ok: false, error: "chat_credits", status: await chatStatus(u, model), credits, need: hold };
  const [over, cred] = await Promise.all([db.incrby(chatOverKey(acct(u)), units), db.get<number>(chatCredKey(acct(u)))]);
  return { ok: true, mode: "overflow", key: chatOverKey(acct(u)), units, model: entry.id, hold, status: statusOf(u, n - units, over, num(cred), hold) };
}

/**
 * After the turn. `usd` is what its model calls cost (`ChatTurn.usd`); null when the turn threw. A message that failed
 * or made no model call is given back: exactly the `gate.units` the reserve counted, on the counter it counted them on. In
 * overflow the metered cost is billed at the floor rate, at most the gate's hold, and added to the month's chat credits.
 * Updates `u.credits` for the reply. Returns the status after it. A gate whose units are not a whole number of at least 1
 * throws before anything moves.
 */
export async function settleChatTurn(u: User, gate: ChatReserved, usd: number | null): Promise<{ status: ChatStatus; charged: number }> {
  if (!Number.isSafeInteger(gate.units) || gate.units < 1) throw new Error(`invalid_units:${String(gate.units)}`);
  const answered = usd !== null && Number.isFinite(usd) && usd > 0;
  const s = gate.status;
  const k = gate.units;
  if (!answered) {
    await db.incrby(gate.key, -gate.units);
    return gate.mode === "included"
      ? { status: { ...s, used: Math.max(0, s.used - k), counted: Math.max(0, s.counted - k), left: Math.min(s.allowance, s.left + k) }, charged: 0 }
      : { status: { ...s, overflow: { ...s.overflow, used: Math.max(0, s.overflow.used - k) } }, charged: 0 };
  }
  if (gate.mode === "included") return { status: s, charged: 0 };
  const r = await settleChatOverflow(acct(u), gate.hold, Math.round(usd * 1e6), creditMicro());
  u.credits = r.credits;
  if (r.charged) await db.incrby(chatCredKey(acct(u)), r.charged);
  return { status: { ...s, overflow: { ...s.overflow, credits: s.overflow.credits + r.charged } }, charged: r.charged };
}

/**
 * Run a reserved turn and settle it on every path: a throw gives the message back before it is rethrown, so the routes'
 * error answers stay as they were. A settle that fails after a good turn is logged, not thrown: the owner has the reply.
 * The turn's model cost (`usd`) is the route's to settle with and is never sent on to the browser.
 */
export async function runChatTurn(u: User, gate: ChatReserved, run: () => Promise<ChatTurn>): Promise<{ message: ChatTurn; chat: ChatStatus; charged: number }> {
  let m: ChatTurn;
  try {
    m = await run();
  } catch (e) {
    await settleChatTurn(u, gate, null).catch((x) => log.error("chat settle failed", x));
    throw e;
  }
  const { usd, ...message } = m;
  try {
    const s = await settleChatTurn(u, gate, usd ?? 0);
    return { message, chat: s.status, charged: s.charged };
  } catch (x) {
    log.error("chat settle failed", x);
    return { message, chat: gate.status, charged: 0 };
  }
}

/** The plain sentence an MCP client (and the model relaying it) gets for a refused message. */
export function refusalText(r: Refusal | FairUseStop): string {
  if (r.error === "fair_use") return fairUseText();
  const s = r.status;
  const when = s.period === "trial" ? "for the trial" : "this month (it renews on the 1st, UTC)";
  if (r.error === "chat_credits") return `Chat paused: this account used its ${s.allowance} chat messages ${when}, and continuing on credits needs at least ${r.need ?? s.overflow.hold} credits in the balance (the most one message can cost); the account has ${r.credits}. Nothing was sent. The owner can top up credits (packs used after the month's plan credits) or upgrade the plan from the Subscription page in the app.`;
  return `Chat paused: this account used its ${s.allowance} chat messages ${when}. Nothing was sent. ${s.overflow.available ? "The owner can upgrade the plan, or turn on \"continue on credits\" on the Subscription page in the app." : "The owner can subscribe from the Subscription page in the app."}`;
}
