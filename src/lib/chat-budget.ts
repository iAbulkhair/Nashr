import { costUsd } from "./usage";
import { chatTurnMaxUsd } from "./models/credits";
import type { ChatMsg } from "./chat";

/**
 * The hard per-message guards of a chat turn (pricing phase 2, rules 311-312), checked in code before every model call,
 * never left to the prompt. A turn is one owner message: up to `CHAT_MAX_CALLS` model calls with tools in between.
 *
 * - Output: each call's `max_tokens` is what is left of the model's per-message ceiling (`chatTurnMaxUsd`: CHAT_TURN_MAX_USD
 *   on the default chat model, times the chat tier multiplier on another, src/lib/models/credits.ts) after what the turn
 *   already cost and an upper estimate of the call's input, at the model's output rate, and never more than `CHAT_MAX_OUT`.
 * - The loop: when less than `CHAT_MIN_OUT` tokens would be left, no further call is made and the turn ends with the
 *   work already done (the items its tools made are on the reply's cards). A call the model ended at `max_tokens` is
 *   never acted on (src/lib/chat.ts): its tool calls may be cut off.
 * - History: the last `CHAT_HISTORY_MAX_MSGS` messages, each cut to `CHAT_HISTORY_MSG_MAX_CHARS` and together at most
 *   `CHAT_HISTORY_MAX_CHARS`, newest kept first; and when even then the first call would get less than
 *   `CHAT_FIRST_MIN_OUT`, the oldest are dropped until it fits (`fitFirstCall`). A full workspace first shortens the
 *   memory of the thread; with the newest message alone left it shortens the answer (down to `CHAT_MIN_OUT`), and past
 *   that no call is made: the turn ends with LARGE_REPLY, given back and not billed (rule 309). Where that happens is per
 *   model: Opus 5's ceiling is twice the Sonnets' at 2.5 times their rates, so it has 80% of their room and reaches the
 *   cliff first (on 2026-10-09 with every core memory file at the budget, for 6 of 8 agents; the Sonnets still get
 *   `CHAT_FIRST_MIN_OUT`). `tests/pricing-floor.test.ts` pins the figures and the exact cliff per model.
 */
export const CHAT_MAX_CALLS = 5;
export const CHAT_MAX_OUT = 8000;
/** Below this many output tokens a call has no room for adaptive thinking and a useful answer: it is not made. */
export const CHAT_MIN_OUT = 2048;
/** What the first call of a turn should get at least; the thread is shortened to reach it (`fitFirstCall`). */
export const CHAT_FIRST_MIN_OUT = 4000;
export const CHAT_HISTORY_MAX_MSGS = 16;
export const CHAT_HISTORY_MAX_CHARS = 24_000;
export const CHAT_HISTORY_MSG_MAX_CHARS = 6_000;
/**
 * Characters per token for the input estimate. `docs/system/costs.md` measured about 3.3 for this Arabic and English mix;
 * a little lower counts a few more tokens, so the estimate stays above the real input.
 */
export const CHARS_PER_TOKEN_EST = 3;

export const estTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN_EST);

/**
 * A call's input in tokens, split by how it is billed: `cached` is the prefix that carries `cache_control` (the tools and
 * the first two system blocks), `fresh` everything after it (the volatile system block, the messages, tool results).
 */
export type InputEst = { cached: number; fresh: number };

/**
 * An upper estimate of a call's input cost in USD. The first call of a turn may find the cached prefix cold, so it is
 * priced as a cache write; every later call reads the prefix the first one cached (the calls of one turn are seconds to
 * a couple of minutes apart, inside the cache's five minutes), so it is priced as a cache read. The rest is plain input.
 */
export function inputEstimateUsd(model: string, est: InputEst, first: boolean): number {
  const cached = Math.max(0, Math.ceil(est.cached)), fresh = Math.max(0, Math.ceil(est.fresh));
  return first ? costUsd(model, { cache_creation_input_tokens: cached, input_tokens: fresh }) : costUsd(model, { cache_read_input_tokens: cached, input_tokens: fresh });
}

/** USD for one output token of `model`. */
const outRate = (model: string) => costUsd(model, { output_tokens: 1 });

/**
 * `max_tokens` for the next call of a turn, or 0 when the call must not be made: what is left of the ceiling after
 * `spentUsd` and `inputUsd`, at the output rate, capped at CHAT_MAX_OUT; 0 below CHAT_MIN_OUT. Non-finite inputs give
 * 0: a guard that cannot read the numbers stops the loop rather than letting it run unbounded. The ceiling is the model's
 * own (`chatTurnMaxUsd(model)`), the same one its overflow hold covers (`chatHoldFor`), unless a caller passes one.
 */
export function nextMaxTokens(model: string, spentUsd: number, inputUsd: number, ceilingUsd: number = chatTurnMaxUsd(model)): number {
  if (![spentUsd, inputUsd, ceilingUsd].every(Number.isFinite)) return 0;
  const room = Math.floor((ceilingUsd - spentUsd - inputUsd) / outRate(model));
  return room >= CHAT_MIN_OUT ? Math.min(CHAT_MAX_OUT, room) : 0;
}

type Turn = { role: ChatMsg["role"]; content: string };

/**
 * The thread as the model gets it: the newest messages that fit, oldest dropped first. The newest (the owner's message
 * this turn) is always kept, cut to CHAT_HISTORY_MSG_MAX_CHARS like the rest. A thread may start with the assistant
 * (the first-run onboarding writes its messages before the owner says anything), as it always could.
 */
export function trimHistory(thread: Pick<ChatMsg, "role" | "content">[]): Turn[] {
  const out: Turn[] = [];
  let total = 0;
  for (const m of thread.slice(-CHAT_HISTORY_MAX_MSGS).reverse()) {
    const raw = typeof m.content === "string" ? m.content : String(m.content ?? "");
    const content = raw.length > CHAT_HISTORY_MSG_MAX_CHARS ? `${raw.slice(0, CHAT_HISTORY_MSG_MAX_CHARS)}…` : raw;
    if (out.length && total + content.length > CHAT_HISTORY_MAX_CHARS) break;
    out.push({ role: m.role, content });
    total += content.length;
  }
  return out.reverse();
}

/**
 * The first call of a turn: drop the oldest messages until the call gets at least CHAT_FIRST_MIN_OUT output tokens, or
 * only the newest is left. `prefixChars` is the cached prefix (tools and the first two system blocks), `volatileChars`
 * the uncached system block. Returns the messages to send and the call's `max_tokens` (0 when even the newest message
 * alone does not leave CHAT_MIN_OUT: the turn is then not answered and not counted).
 */
export function fitFirstCall(model: string, messages: Turn[], prefixChars: number, volatileChars: number): { messages: Turn[]; maxTokens: number } {
  let msgs = messages;
  const room = (m: Turn[]) => nextMaxTokens(model, 0, inputEstimateUsd(model, { cached: estTokens(prefixChars), fresh: estTokens(volatileChars + JSON.stringify(m).length) }, true));
  let max = room(msgs);
  while (max < CHAT_FIRST_MIN_OUT && msgs.length > 1) {
    msgs = msgs.slice(1);
    max = room(msgs);
  }
  return { messages: msgs, maxTokens: max };
}
