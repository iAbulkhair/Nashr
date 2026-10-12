/**
 * Model provider faults, classified for the customer and the founder (rules 1476-1478). When Anthropic or the gateway
 * rate-limits, is overloaded or has run out of balance, the customer sees a clear message in their language and never the
 * provider's name, status or text; the founder sees one audit row per fault and place an hour (src/lib/provider-fault-note.ts).
 *
 * Imports nothing on purpose: the chat panel, the generate panel and the onboarding page (client components) read the copy.
 */

/** What went wrong at the provider: too many requests, the provider overloaded, or our account's balance spent. */
export type ProviderFault = "rate_limited" | "overloaded" | "no_balance";
/** What the customer is told: `model_busy` (try again in a minute) or `model_unavailable` (try later; the founder is told). */
export type CustomerModelError = "model_busy" | "model_unavailable";

/** A 4xx whose text says the account's credit or balance is spent (Anthropic answers 400 "credit balance is too low"). */
const BALANCE = /credit balance|insufficient[ _](?:balance|credits?|funds|quota)|payment required|billing/i;

/**
 * The fault behind `e`, or null for anything else (a bug, a timeout, a refused request). Reads the Anthropic SDK's error
 * (`status`, the API's error `type`), a media adapter's `ProviderError` (`code`, src/lib/media/types.ts) and up to three
 * `cause` links below it, by shape only, so nothing here imports the SDK. Never returns or keeps any provider text.
 */
export function providerFault(e: unknown): ProviderFault | null {
  let x: unknown = e;
  for (let depth = 0; depth < 4 && x && typeof x === "object"; depth++) {
    const o = x as { status?: unknown; type?: unknown; error?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const status = typeof o.status === "number" ? o.status : 0;
    const body = o.error && typeof o.error === "object" ? (o.error as { type?: unknown; error?: { type?: unknown } }) : undefined;
    const type = [o.type, body?.error?.type, body?.type].find((t): t is string => typeof t === "string") ?? "";
    const text = typeof o.message === "string" ? o.message : "";
    if (status === 402 || type === "billing_error" || o.code === "no_balance" || (status >= 400 && status < 500 && BALANCE.test(text))) return "no_balance";
    if (status === 429 || type === "rate_limit_error" || o.code === "busy") return "rate_limited";
    if (status === 529 || type === "overloaded_error") return "overloaded";
    x = o.cause;
  }
  return null;
}

/** The customer's code for a fault: a spent balance is not the customer's to wait out, so it is `model_unavailable`. */
export const customerCode = (f: ProviderFault): CustomerModelError => (f === "no_balance" ? "model_unavailable" : "model_busy");

/** Why, in one sentence, for a message that already says what happened to the credits (the onboarding refund). */
export const MODEL_ERROR_CAUSE: Record<"ar" | "en", Record<CustomerModelError, string>> = {
  ar: { model_busy: "الضغط على الوكلاء عالٍ الآن.", model_unavailable: "الوكلاء غير متاحين الآن، وأُبلغ فريق ذكين." },
  en: { model_busy: "The agents are very busy right now.", model_unavailable: "The agents are unavailable right now, and the Thakeen team has been told." },
};

/** The customer's whole message for each code, in both languages. Nothing was charged: every caller refunds on a throw. */
export const MODEL_ERROR_COPY: Record<"ar" | "en", Record<CustomerModelError, string>> = {
  ar: { model_busy: `${MODEL_ERROR_CAUSE.ar.model_busy} لم يُخصم شيء. حاول بعد دقيقة.`, model_unavailable: `${MODEL_ERROR_CAUSE.ar.model_unavailable} لم يُخصم شيء. حاول بعد قليل.` },
  en: { model_busy: `${MODEL_ERROR_CAUSE.en.model_busy} Nothing was charged. Try again in a minute.`, model_unavailable: `${MODEL_ERROR_CAUSE.en.model_unavailable} Nothing was charged. Try again a little later.` },
};

const isCode = (code: unknown): code is CustomerModelError => code === "model_busy" || code === "model_unavailable";
/** The message for an error code from the API, or null when the code is not one of these. */
export const modelErrorText = (lang: "ar" | "en", code: unknown): string | null => (isCode(code) ? MODEL_ERROR_COPY[lang][code] : null);
/** The one-sentence cause for an error code from the API, or null. */
export const modelErrorCause = (lang: "ar" | "en", code: unknown): string | null => (isCode(code) ? MODEL_ERROR_CAUSE[lang][code] : null);
