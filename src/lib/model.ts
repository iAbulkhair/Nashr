import Anthropic from "@anthropic-ai/sdk";
import { isProductionDeploy } from "./deploy-env";
import { db } from "./db";
import { gatewayOrigin } from "./models/gateway-url";

/**
 * One switch for every Claude call in the product: chat, generation and its reviewer, the judge, onboarding, image
 * prompts, the free tools and the golden set.
 *
 * Paused on 2026-09-28 at the owner's request, back on since 2026-10-05 at the owner's request. To pause again, set
 * CLAUDE_PAUSED to true and deploy.
 *
 * Paused is not the no-key development path. Without ANTHROPIC_API_KEY (outside a production deployment, which refuses
 * as paused instead: `modelState`) the app answers with [DEV MOCK] placeholders,
 * which is right on a laptop and in CI and wrong for a customer: the mock items would be charged for, and onboarding
 * would save a mock brand file that then blocks the real onboarding. Paused surfaces refuse instead, before a credit
 * moves or anything is written.
 */
export const CLAUDE_PAUSED = false;

export type ModelState = "on" | "paused" | "mock";

/**
 * Provider switch (tests/model-provider.test.ts). Where the model calls go: Anthropic directly (the default, and what
 * any other value of LLM_PROVIDER means, a typo included) or the Straitly gateway (`LLM_PROVIDER=straitly`). Read at call
 * time, so a deploy that changes the variable changes the next call.
 */
export type LlmProvider = "anthropic" | "straitly";

export function llmProvider(): LlmProvider {
  return process.env.LLM_PROVIDER === "straitly" ? "straitly" : "anthropic";
}

/**
 * The key that sends calls to the gateway, or undefined when they do not go there: the gateway is used only with
 * `LLM_PROVIDER=straitly` AND `STRAITLY_API_KEY`. The one place that decides it: `anthropic()` builds its client from it and
 * `effectiveProvider()` names the provider from it, so the metering (src/lib/usage.ts) cannot disagree with the client.
 */
function straitlyKey(): string | undefined {
  return llmProvider() === "straitly" ? process.env.STRAITLY_API_KEY : undefined;
}

/**
 * The provider the model calls really go to (Task 8, plan section "metering"): `straitly` only when `anthropic()` builds the
 * gateway client, so with `LLM_PROVIDER=straitly` and only ANTHROPIC_API_KEY (a supported setup, see `hasModelKey`) it is
 * `anthropic`, which is where those calls go. A closed set of two, never a string from the environment. It names where a
 * call was SENT: a request the gateway failed and `withDirectFallback` re-sent to Anthropic still counts as `straitly`
 * (the `usage:_all:{month}:provider:fallback` counter says how many). Read at call time, like `llmProvider()`.
 */
export function effectiveProvider(): LlmProvider {
  return straitlyKey() ? "straitly" : "anthropic";
}

/**
 * Is there a key for the active provider? With `anthropic`, ANTHROPIC_API_KEY. With `straitly`, either key: STRAITLY_API_KEY
 * sends the calls through the gateway, and ANTHROPIC_API_KEY alone sends them to Anthropic directly (`anthropic` below),
 * the same key the gateway's fallback uses. STRAITLY_API_KEY is read in `straitlyKey` and `hasModelKey` and nowhere else
 * in `src` (tests/model-timeouts.test.ts), never logged and never put in an error or a URL.
 */
export function hasModelKey(): boolean {
  return llmProvider() === "straitly" ? !!(process.env.STRAITLY_API_KEY || process.env.ANTHROPIC_API_KEY) : !!process.env.ANTHROPIC_API_KEY;
}

/**
 * "mock" only where no customer can be: no key and not a production deployment on any host (`isProductionDeploy`; a
 * laptop, vitest, a Vercel preview, the e2e suite under `APP_ENV=test`). A production deployment without a key for the
 * active provider (`hasModelKey`) answers "paused", so every surface refuses before a credit
 * moves (rule 76) and no [DEV MOCK] item, chat reply or brand file is ever saved for a customer. Rule 431,
 * tests/launch-security.test.ts.
 */
export function modelState(): ModelState {
  if (!hasModelKey()) {
    if (isProductionDeploy()) {
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
  const missing = llmProvider() === "straitly" ? "STRAITLY_API_KEY and ANTHROPIC_API_KEY are not set" : "ANTHROPIC_API_KEY is not set";
  console.error(`model_not_configured: ${missing} in production; the agents refuse as paused`);
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

const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The only way to make a model client (rule 335; tests/model-timeouts.test.ts fails on any other `new Anthropic(` in src).
 * The SDK's defaults are a 10-minute timeout and two retries, longer than any route's maxDuration (300 s at most): a slow
 * call was killed by the platform first, and a killed function runs no catch or finally, so a charge taken before the
 * call was never refunded (issue #28). Every caller states both numbers.
 *
 * `timeoutMs` bounds each attempt until the response headers arrive; a streamed reply sends them at once, so a stream's
 * body is bounded only by `until(deadline)` passed with the call. `maxRetries` counts the attempts after the first.
 *
 * Provider switch: with `LLM_PROVIDER=straitly` and STRAITLY_API_KEY set, the same client talks to the Straitly gateway
 * (STRAITLY_BASE_URL, an origin only, default `https://api.straitly.ai`: `gatewayOrigin` in src/lib/models/gateway-url.ts,
 * which refuses anything else with a message that names neither the value nor a key; the SDK adds `/v1/messages` itself),
 * and a Claude model it fails on is retried once against Anthropic (`withDirectFallback`). With `straitly` and only
 * ANTHROPIC_API_KEY, the client is the plain Anthropic one: that key is never sent to the gateway. The default (no
 * LLM_PROVIDER) builds exactly the client it always did.
 */
export function anthropic(o: { timeoutMs: number; maxRetries: number }): Anthropic {
  if (!(Number.isFinite(o.timeoutMs) && o.timeoutMs > 0)) throw new Error(`invalid_model_timeout:${String(o.timeoutMs)}`);
  if (!(Number.isInteger(o.maxRetries) && o.maxRetries >= 0 && o.maxRetries <= 2)) throw new Error(`invalid_model_retries:${String(o.maxRetries)}`);
  const timeout = Math.floor(o.timeoutMs);
  const gatewayKey = straitlyKey();
  if (!gatewayKey) return new Anthropic({ timeout, maxRetries: o.maxRetries });
  const baseURL = gatewayOrigin(process.env.STRAITLY_BASE_URL);
  // `authToken: null` so an ambient ANTHROPIC_AUTH_TOKEN is not sent to the gateway along with its key.
  return new Anthropic({ timeout, maxRetries: o.maxRetries, baseURL, apiKey: gatewayKey, authToken: null, fetch: withDirectFallback() });
}

/**
 * The gateway's fallback: a `fetch` for the SDK client that sends a request to Straitly and, only when that failed before
 * any response body was read, sends the same request once to Anthropic with ANTHROPIC_API_KEY.
 *
 * Retried: a connection error (the call threw) or a status of 500 or more, for a request whose JSON body names a
 * `claude-*` model, with ANTHROPIC_API_KEY set. The body is a string the SDK built; it is read for its `model` only after
 * a failure, and the same string is sent again (nothing here consumes it twice). The origin becomes Anthropic's, the path
 * (the SDK's own, since the gateway's base is an origin) and the query string stay, and the gateway's key is replaced by
 * Anthropic's; every other header (anthropic-version, anthropic-beta, content-type) stays.
 *
 * Never retried: a status below 500 (a 4xx is the request's fault and would fail again), and so never a reply that has
 * started, whatever happens to its body afterwards (a second request would repeat it, and a streamed chat turn would
 * duplicate text and tool actions); a non-Claude model (Anthropic does not serve it); a request the caller aborted; a
 * body that is not a string; no ANTHROPIC_API_KEY.
 *
 * The SDK arms its per-attempt timeout and the caller's abort signal around this whole function, so the gateway and the
 * retry share one attempt's time, and a timeout is an abort and is not retried here; the SDK's own `maxRetries` run on top
 * and start at the gateway again. Logs a status code or "network" and no key, no header and no body.
 */
function withDirectFallback(): Fetch {
  return async (input, init) => {
    let first: Response | undefined;
    try {
      first = await globalThis.fetch(input, init);
      if (first.status < 500) return first;
    } catch (e) {
      if (init?.signal?.aborted) throw e;
      const retry = directRequest(input, init);
      if (!retry) throw e;
      console.warn("model_fallback: straitly connection error, retried on anthropic");
      noteFallback();
      return globalThis.fetch(retry.url, retry.init);
    }
    const retry = directRequest(input, init);
    if (!retry) return first;
    console.warn(`model_fallback: straitly status ${first.status}, retried on anthropic`);
    // Unread, so the connection is released instead of held until the body is collected.
    void first.body?.cancel().catch(() => {});
    noteFallback();
    return globalThis.fetch(retry.url, retry.init);
  };
}

/**
 * Counts one request re-sent to Anthropic, in the founder's global counter `usage:_all:{YYYY-MM}:provider:fallback` (read by
 * `getUsage("_all")`, shown in the founder console). No account, model, key or error text goes in the name or the log.
 * Fire and forget and wrapped twice (a synchronous throw, a rejected promise): a store that fails or is slow never delays,
 * changes or fails the retry. It does not import usage.ts (that file imports this one); the key is spelled out here and pinned
 * by tests/model-provider.test.ts.
 */
function noteFallback(): void {
  try {
    void db.incrby(`usage:_all:${new Date().toISOString().slice(0, 7)}:provider:fallback`, 1).catch(() => {});
  } catch {
    /* best effort */
  }
}

/** The same request aimed at Anthropic, or null when this request is not one to send there (see `withDirectFallback`). */
function directRequest(input: string | URL | Request, init: RequestInit | undefined): { url: string; init: RequestInit } | null {
  const key = process.env.ANTHROPIC_API_KEY;
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : null;
  if (!key || !raw || typeof init?.body !== "string") return null;
  let model: unknown;
  try {
    model = (JSON.parse(init.body) as { model?: unknown } | null)?.model;
  } catch {
    return null;
  }
  if (typeof model !== "string" || !model.startsWith("claude-")) return null;
  const u = new URL(raw);
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.set("x-api-key", key);
  return { url: `${ANTHROPIC_ORIGIN}${u.pathname}${u.search}`, init: { ...init, headers } };
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
