import { db } from "./db";
import type { User } from "./auth";
import { settleChatOverflow } from "./credits";
import { chatAllowanceOf, chatOverflowHold, maxCostPerCreditUsd } from "./pricing";
import { chatCredKey, chatMsgKey, chatOverKey, chatTrialKey } from "./usage";
import type { ChatTurn } from "./chat";

/**
 * The chat allowance (pricing phase 2, rules 308-310): every owner message (one turn, however many model calls it takes)
 * is counted per account, shared by every seat, brand and connected app (`u.email` is always the account's). A paid plan
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
export type ChatGate =
  | { ok: true; mode: "included"; key: string; status: ChatStatus }
  | { ok: true; mode: "overflow"; key: string; hold: number; status: ChatStatus }
  | Refusal;
export type ChatReserved = Extract<ChatGate, { ok: true }>;

const counterKey = (u: Pick<User, "email" | "plan">) => (u.plan === "trial" ? chatTrialKey(u.email) : chatMsgKey(u.email));
/** "Continue on credits" is offered on paid plans only: the trial's chat is its 30 messages. */
export const overflowAvailable = (u: Pick<User, "plan">) => u.plan !== "trial";
const overflowOn = (u: Pick<User, "plan" | "chatOverflow">) => overflowAvailable(u) && u.chatOverflow === true;
const creditMicro = () => Math.round(maxCostPerCreditUsd() * 1e6);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

function statusOf(u: Pick<User, "plan" | "chatOverflow" | "chatAllowance">, counted: number, overUsed: number, overCredits: number): ChatStatus {
  const allowance = chatAllowanceOf(u);
  const used = Math.max(0, Math.min(allowance, counted));
  return {
    used,
    allowance,
    left: Math.max(0, allowance - used),
    counted: Math.max(0, counted),
    period: u.plan === "trial" ? "trial" : "month",
    overflow: { on: overflowOn(u), available: overflowAvailable(u), used: Math.max(0, overUsed), credits: Math.max(0, overCredits), hold: chatOverflowHold() },
  };
}

/** The account's chat status now: up to three reads, in parallel. */
export async function chatStatus(u: Pick<User, "email" | "plan" | "chatOverflow" | "chatAllowance">): Promise<ChatStatus> {
  const trial = u.plan === "trial";
  const [counted, over, cred] = await Promise.all([db.get<number>(counterKey(u)), trial ? 0 : db.get<number>(chatOverKey(u.email)), trial ? 0 : db.get<number>(chatCredKey(u.email))]);
  return statusOf(u, num(counted), num(over), num(cred));
}

/**
 * Reserve one message before the turn. Inside the allowance: counted (INCRBY, so N parallel turns can never pass it).
 * Past it: the reservation is taken back, and the turn goes ahead only when the owner turned overflow on and the balance
 * covers the most a message can cost; otherwise `chat_allowance` (paused) or `chat_credits` (overflow on, too few credits).
 */
export async function reserveChatTurn(u: User): Promise<ChatGate> {
  const key = counterKey(u);
  const allowance = chatAllowanceOf(u);
  const n = await db.incrby(key, 1);
  if (n <= allowance) return { ok: true, mode: "included", key, status: statusOf(u, n, 0, 0) };
  await db.incrby(key, -1);
  const credits = Math.max(0, num(u.credits));
  // An allowance of 0 is the founder turning chat off for the account: no message, not even on credits.
  if (!overflowOn(u) || allowance === 0) return { ok: false, error: "chat_allowance", status: await chatStatus(u), credits };
  const hold = chatOverflowHold();
  if (credits < hold) return { ok: false, error: "chat_credits", status: await chatStatus(u), credits, need: hold };
  const [over, cred] = await Promise.all([db.incrby(chatOverKey(u.email), 1), db.get<number>(chatCredKey(u.email))]);
  return { ok: true, mode: "overflow", key: chatOverKey(u.email), hold, status: statusOf(u, n - 1, over, num(cred)) };
}

/**
 * After the turn. `usd` is what its model calls cost (`ChatTurn.usd`); null when the turn threw. A message that failed
 * or made no model call is given back (its count). In overflow the metered cost is billed at the floor rate, at most the
 * hold, and added to the month's chat credits. Updates `u.credits` for the reply. Returns the status after it.
 */
export async function settleChatTurn(u: User, gate: ChatReserved, usd: number | null): Promise<{ status: ChatStatus; charged: number }> {
  const answered = usd !== null && Number.isFinite(usd) && usd > 0;
  const s = gate.status;
  if (!answered) {
    await db.incrby(gate.key, -1);
    return gate.mode === "included"
      ? { status: { ...s, used: Math.max(0, s.used - 1), counted: Math.max(0, s.counted - 1), left: Math.min(s.allowance, s.left + 1) }, charged: 0 }
      : { status: { ...s, overflow: { ...s.overflow, used: Math.max(0, s.overflow.used - 1) } }, charged: 0 };
  }
  if (gate.mode === "included") return { status: s, charged: 0 };
  const r = await settleChatOverflow(u.email, gate.hold, Math.round(usd * 1e6), creditMicro());
  u.credits = r.credits;
  if (r.charged) await db.incrby(chatCredKey(u.email), r.charged);
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
    await settleChatTurn(u, gate, null).catch((x) => console.error("chat settle failed", x instanceof Error ? x.name : "error"));
    throw e;
  }
  const { usd, ...message } = m;
  try {
    const s = await settleChatTurn(u, gate, usd ?? 0);
    return { message, chat: s.status, charged: s.charged };
  } catch (x) {
    console.error("chat settle failed", x instanceof Error ? x.name : "error");
    return { message, chat: gate.status, charged: 0 };
  }
}

/** The plain sentence an MCP client (and the model relaying it) gets for a refused message. */
export function refusalText(r: Refusal): string {
  const s = r.status;
  const when = s.period === "trial" ? "for the trial" : "this month (it renews on the 1st, UTC)";
  if (r.error === "chat_credits") return `Chat paused: this account used its ${s.allowance} chat messages ${when}, and continuing on credits needs at least ${r.need ?? s.overflow.hold} credits in the balance (the most one message can cost); the account has ${r.credits}. Nothing was sent. The owner can add credits or upgrade the plan from the Subscription page in the app.`;
  return `Chat paused: this account used its ${s.allowance} chat messages ${when}. Nothing was sent. ${s.overflow.available ? "The owner can upgrade the plan, or turn on \"continue on credits\" on the Subscription page in the app." : "The owner can subscribe from the Subscription page in the app."}`;
}
