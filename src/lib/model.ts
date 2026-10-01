import Anthropic from "@anthropic-ai/sdk";

/**
 * One switch for every Claude call in the product: chat, generation and its reviewer, the judge, onboarding, image
 * prompts, the free tools and the golden set.
 *
 * Paused on 2026-09-28 at the owner's request. To turn Claude back on, set CLAUDE_PAUSED to false and deploy.
 *
 * Paused is not the no-key development path. Without ANTHROPIC_API_KEY (outside a Vercel production deployment, which
 * refuses as paused instead: `modelState`) the app answers with [DEV MOCK] placeholders,
 * which is right on a laptop and in CI and wrong for a customer: the mock items would be charged for, and onboarding
 * would save a mock brand file that then blocks the real onboarding. Paused surfaces refuse instead, before a credit
 * moves or anything is written.
 */
export const CLAUDE_PAUSED = true;

export type ModelState = "on" | "paused" | "mock";

/**
 * "mock" only where no customer can be: no key and not a Vercel production deployment (a laptop, vitest, CI, the e2e
 * suite). A production deployment without ANTHROPIC_API_KEY answers "paused", so every surface refuses before a credit
 * moves (rule 76) and no [DEV MOCK] item, chat reply or brand file is ever saved for a customer. Rule 431,
 * tests/launch-security.test.ts.
 */
export function modelState(): ModelState {
  if (!process.env.ANTHROPIC_API_KEY) {
    if (process.env.VERCEL_ENV === "production") {
      warnNoKey();
      return "paused";
    }
    return "mock";
  }
  return CLAUDE_PAUSED ? "paused" : "on";
}

let warned = false;
/** One log line per instance naming the missing variable (never a value), so the cause is visible in the logs. */
function warnNoKey() {
  if (warned) return;
  warned = true;
  console.error("model_not_configured: ANTHROPIC_API_KEY is not set in production; the agents refuse as paused");
}

/** Thrown by the model-backed helpers while paused. A backstop: every caller that charges first refunds on a throw. */
export class ModelPaused extends Error {
  constructor() {
    super("model_paused");
    this.name = "ModelPaused";
  }
}

/** The chat reply while paused, in the reader's language. Agent-neutral, since any of the agents can be the one asked. */
export const PAUSED_REPLY = {
  ar: "الوكلاء متوقفون مؤقتاً، فلا أستطيع الرد أو إنشاء محتوى الآن. لم يُخصم أي كريدت.",
  en: "The agents are paused for now, so I can't reply or create content yet. No credits were used.",
} as const;

/**
 * The only way to make a model client (rule 335; tests/model-timeouts.test.ts fails on any other `new Anthropic(` in src).
 * The SDK's defaults are a 10-minute timeout and two retries, longer than any route's maxDuration (300 s at most): a slow
 * call was killed by the platform first, and a killed function runs no catch or finally, so a charge taken before the
 * call was never refunded (issue #28). Every caller states both numbers.
 *
 * `timeoutMs` bounds each attempt until the response headers arrive; a streamed reply sends them at once, so a stream's
 * body is bounded only by `until(deadline)` passed with the call. `maxRetries` counts the attempts after the first.
 */
export function anthropic(o: { timeoutMs: number; maxRetries: number }): Anthropic {
  if (!(Number.isFinite(o.timeoutMs) && o.timeoutMs > 0)) throw new Error(`invalid_model_timeout:${String(o.timeoutMs)}`);
  if (!(Number.isInteger(o.maxRetries) && o.maxRetries >= 0 && o.maxRetries <= 2)) throw new Error(`invalid_model_retries:${String(o.maxRetries)}`);
  return new Anthropic({ timeout: Math.floor(o.timeoutMs), maxRetries: o.maxRetries });
}

/**
 * Per-call options that end a model call by `deadline` (epoch ms), a stream's body included: the signal aborts it wherever
 * it is (the SDK throws, and the caller's catch refunds), and `timeout` caps each attempt at the smaller of the time left
 * and `cap`, the caller's per-attempt budget from MODEL_BUDGET. The SDK's per-request `timeout` replaces the client's, so
 * without `cap` an attempt could wait the whole time left and a retry would have nothing left. A deadline already past,
 * or not a number, aborts at once. A plain timer, so a test's fake clock drives it; unref'd, so it never keeps a process
 * alive.
 */
export function until(deadline: number, o: { cap?: number; now?: number } = {}): { signal: AbortSignal; timeout: number } {
  const now = o.now ?? Date.now();
  const ms = Number.isFinite(deadline) ? Math.max(1, Math.floor(deadline - now)) : 1;
  const cap = o.cap !== undefined && Number.isFinite(o.cap) && o.cap > 0 ? Math.floor(o.cap) : Infinity;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error("model_deadline")), ms);
  (t as { unref?: () => void }).unref?.();
  return { signal: c.signal, timeout: Math.min(ms, cap) };
}

/**
 * The model budgets, each inside its route's maxDuration so the refund path always runs (docs/system/flows.md section
 * 8). A caller with a request deadline (`deadlineFor(maxDuration)`, 15 s under the platform's limit) passes it on; these
 * are the per-attempt timeouts and the defaults when there is none.
 * - GEN: one batch (`generate`): the default deadline without a caller's, and each attempt's timeout. One retry.
 * - REVIEW: the second-pass reviewer, at most this long, and only with REVIEW_MIN_MS of the deadline left.
 * - CHAT: each chat turn's attempt; the turn's stream is bounded by the request's deadline. A turn starts only with
 *   CHAT_TURN_MIN_MS left, and leaves CHAT_REPLY_MS to save the reply.
 * - ONBOARD: each of the three onboarding parts; a failed part is tried again only with ONBOARD_RETRY_MIN_MS left.
 * - JUDGE: each attempt of the judge (runs after the response, charges nothing; one retry).
 * - TOOL: each attempt of a free tool; both attempts end by the route's deadline (maxDuration 60, `deadlineFor`).
 */
export const MODEL_BUDGET = {
  GEN_MS: 240_000,
  REVIEW_MS: 90_000,
  REVIEW_MIN_MS: 30_000,
  CHAT_MS: 120_000,
  CHAT_TURN_MIN_MS: 20_000,
  CHAT_REPLY_MS: 5_000,
  ONBOARD_MS: 240_000,
  ONBOARD_RETRY_MIN_MS: 60_000,
  JUDGE_MS: 90_000,
  TOOL_MS: 45_000,
} as const;
