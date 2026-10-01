/**
 * What the sign-up, log-in, forgot and reset forms (src/components/app/AuthForm.tsx) share. Import-free, so the client
 * bundle can use it, and pure, so tests/launch-security.test.ts pins it (rules 433-434).
 *
 * The forms used to await `fetch` and `res.json()` with nothing around them: a dropped connection or an HTML 502 page
 * threw, the button stayed disabled and no message appeared. The log-in form also showed "wrong email or password"
 * for a rate limit and for a server error, which sent a customer with the right password to a reset.
 */

export type AuthLang = "ar" | "en";

/** A finished POST: the HTTP status (0 when the request never got an answer) and the JSON body ({} when there is none). */
export type Posted = { status: number; body: Record<string, unknown> };

/** POST JSON and never throw. A dropped connection is status 0; a body that is not JSON (an HTML error page) is {}. */
export async function postJson(url: string, data: unknown, f: typeof fetch = fetch): Promise<Posted> {
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  } catch {
    return { status: 0, body: {} };
  }
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {} };
}

/** True when the server accepted the request. */
export const succeeded = (p: Posted) => p.status >= 200 && p.status < 300 && p.body.ok === true;

/**
 * Why a request failed, as one code: "network" (no answer), "slow_down" (429), the Turnstile codes, "server" (5xx or
 * an answer with no code), otherwise the route's own error code ("invalid", "exists", "bad_email"...). The form looks
 * the code up in its own messages first, then in AUTH_ERR, and falls back to AUTH_ERR.server, never to a raw code.
 */
export function failureCode(p: Posted): string {
  if (p.status === 0) return "network";
  if (p.status === 429) return "slow_down";
  const code = typeof p.body.error === "string" ? p.body.error : "";
  if (code === "captcha_failed" || code === "captcha_unavailable") return code;
  if (p.status >= 500 || !code) return "server";
  return code;
}

/** Messages shared by every auth form. Gulf-friendly MSA, matching src/lib/app-i18n.ts. */
export const AUTH_ERR = {
  ar: {
    network: "تعذّر الاتصال بالخادم. تحقّق من اتصالك بالإنترنت ثم حاول مرة أخرى.",
    server: "حدث خطأ من جهتنا. حاول مرة أخرى بعد قليل.",
    slow_down: "محاولات كثيرة. انتظر ربع ساعة ثم حاول مرة أخرى.",
    slow_down_signup: "محاولات تسجيل كثيرة من هذا الاتصال. حاول مرة أخرى بعد ساعة.",
    captcha_failed: "لم يكتمل التحقق الأمني. أكمل التحقق ثم حاول مرة أخرى.",
    captcha_unavailable: "خدمة التحقق الأمني لا تستجيب الآن. حاول مرة أخرى بعد قليل.",
    disabled: "دخولك موقوف مؤقتاً لأن خطة الحساب لا تتسع له. اطلب من مالك الحساب ترقية الخطة.",
  },
  en: {
    network: "Couldn't reach the server. Check your internet connection and try again.",
    server: "Something went wrong on our side. Please try again shortly.",
    slow_down: "Too many attempts. Wait 15 minutes, then try again.",
    slow_down_signup: "Too many sign-ups from this connection. Try again in an hour.",
    captcha_failed: "The security check wasn't completed. Complete it and try again.",
    captcha_unavailable: "The security check isn't responding right now. Try again shortly.",
    disabled: "Your login is paused because the account's plan has no free seat. Ask the account owner to upgrade.",
  },
} as const;

/** The message for `code`: the form's own messages first, then the shared ones, then the generic server message. */
export function authMessage(code: string, lang: AuthLang, own: Record<string, string> = {}): string {
  return own[code] ?? (AUTH_ERR[lang] as Record<string, string>)[code] ?? AUTH_ERR[lang].server;
}

/** The three password rules, in the order the forms list them. Must agree with `strongPassword` in src/lib/auth.ts. */
export const passwordChecks = (pw: string): [boolean, boolean, boolean] => [pw.length >= 8, /\p{L}/u.test(pw), /\d/.test(pw)];

export const RULE_TEXT = {
  ar: { met: "متحقق", unmet: "غير متحقق", needs: "كلمة المرور ما زالت تحتاج:", sep: "، " },
  en: { met: "met", unmet: "not met", needs: "Your password still needs:", sep: ", " },
} as const;

/** The one status line a screen reader hears as the password changes, e.g. "2 of 3 password rules met". */
export function rulesStatus(checks: readonly boolean[], lang: AuthLang): string {
  const n = checks.filter(Boolean).length, t = checks.length;
  return lang === "ar" ? `${n} من ${t} شروط لكلمة المرور متحققة` : `${n} of ${t} password rules met`;
}

/** Why the submit button does nothing yet: the unmet rules by name. Empty when every rule is met. */
export function unmetRules(checks: readonly boolean[], rules: readonly string[], lang: AuthLang): string {
  const missing = rules.filter((_, i) => !checks[i]);
  return missing.length ? `${RULE_TEXT[lang].needs} ${missing.join(RULE_TEXT[lang].sep)}.` : "";
}
