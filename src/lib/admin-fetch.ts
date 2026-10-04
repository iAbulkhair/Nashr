/**
 * The founder console's fetch (rule 436). A key session ends after 15 minutes of inactivity (rule 422), so a console
 * left open starts getting 401 from every admin API. Every admin call in the console and its panels goes through
 * `adminFetch`, which announces a 401 on `window` (`ADMIN_ENDED_EVENT`); the console then shows `ADMIN_ENDED` with a
 * link back to the key form (`adminEndedHref`) instead of an empty user table or a raw "unauthorized". Client-safe: no
 * server imports.
 */
export const ADMIN_ENDED_EVENT = "nashr:admin-session-ended";

export async function adminFetch(input: string, init?: RequestInit, f: typeof fetch = fetch): Promise<Response> {
  const r = await f(input, init);
  if (r.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(ADMIN_ENDED_EVENT));
  return r;
}

/** What the console says once its access is gone: the key session (15 minutes idle, 12 hours at most), or the founder's own sign-in. */
export const ADMIN_ENDED = {
  ar: {
    key: "انتهت جلسة المفتاح: مرّت 15 دقيقة بلا نشاط، أو بلغت 12 ساعة. أدخل المفتاح مرة أخرى لمتابعة العمل.",
    keyLink: "إدخال المفتاح",
    founder: "انتهت جلستك في لوحة المؤسس. سجّل الدخول مرة أخرى لمتابعة العمل.",
    founderLink: "تسجيل الدخول",
  },
  en: {
    key: "The key session has ended: 15 minutes passed without activity, or it reached 12 hours. Enter the key again to continue.",
    keyLink: "Enter the key",
    founder: "Your founder console session has ended. Sign in again to continue.",
    founderLink: "Sign in",
  },
} as const;

/** Where the founder goes to get back in: the key form (shown only with `?login=1`) or the normal sign-in page. */
export const adminEndedHref = (lang: "ar" | "en", keySession: boolean) => (keySession ? `/${lang}/app/admin?login=1` : `/${lang}/app/login`);
