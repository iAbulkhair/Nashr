/**
 * The public site's cookie consent (rules 3335-3339): the visitor's yes or no for analytics, kept in one first-party
 * cookie the browser writes itself. Nothing about an anonymous visitor is recorded on the server: no route reads this
 * cookie, and no store key is ever built from it. Separate from src/lib/consent.ts, which records what an OWNER agreed
 * to at signup.
 *
 * Imports only the cookie names (import-free), so the banner, the footer link and the loader can use it in the browser.
 */
import { ANALYTICS_ID_COOKIE, CONSENT_COOKIE, cookieFromHeader } from "./cookie-names";

export type ConsentChoice = "yes" | "no";

/** How long an answer is kept: 180 days, then the banner asks again. */
export const CONSENT_MAX_AGE = 180 * 24 * 60 * 60;

/** The visitor's answer in a `document.cookie` string, or null when they have not answered (or the value is not ours). */
export const readConsent = (cookie: string | null | undefined): ConsentChoice | null => {
  const v = cookieFromHeader(cookie, CONSENT_COOKIE, /yes|no/);
  return v === "yes" || v === "no" ? v : null;
};

/** The `document.cookie` line that stores an answer: first-party, the whole site, Lax, Secure on https. */
export const consentCookieLine = (choice: ConsentChoice, secure: boolean): string =>
  `${CONSENT_COOKIE}=${choice}; path=/; max-age=${CONSENT_MAX_AGE}; samesite=lax${secure ? "; secure" : ""}`;

/** The anonymous id in a `document.cookie` string, or null. A random UUID, never derived from the visitor. */
export const readAnalyticsId = (cookie: string | null | undefined): string | null =>
  cookieFromHeader(cookie, ANALYTICS_ID_COOKIE, /[0-9a-f-]{36}/) ?? null;

export const analyticsIdLine = (id: string, secure: boolean): string =>
  `${ANALYTICS_ID_COOKIE}=${id}; path=/; max-age=${CONSENT_MAX_AGE}; samesite=lax${secure ? "; secure" : ""}`;

/**
 * The cookies a "no" removes: our anonymous id and Google's `_ga` / `_ga_<id>` cookies, on this host and on its parent
 * domains (Google writes them on the widest one it can). Returns `document.cookie` lines; the browser ignores lines for
 * cookies it does not hold.
 */
export function clearAnalyticsLines(cookie: string, hostname: string): string[] {
  const names = new Set<string>([ANALYTICS_ID_COOKIE]);
  for (const part of cookie.split(";")) {
    const n = part.split("=")[0]?.trim();
    if (n && (n === "_ga" || /^_ga_[A-Z0-9]+$/.test(n) || n === "_gid")) names.add(n);
  }
  const labels = hostname.split(".");
  const domains = [""];
  for (let i = 0; i < labels.length - 1; i++) domains.push(`; domain=.${labels.slice(i).join(".")}`);
  return [...names].flatMap((n) => domains.map((d) => `${n}=; path=/; max-age=0${d}`));
}

/** The browser events the banner, the footer link and the loader use to talk: an answer changed, or "show the banner". */
export const CONSENT_EVENT = "thakeen:consent";
export const CONSENT_OPEN_EVENT = "thakeen:consent-open";

/** The banner's words (rule 3339): plain, both languages, no legal claim, equal-weight answers. */
export const CONSENT_COPY = {
  title: { ar: "قياس زيارات الموقع", en: "Counting site visits" },
  body: {
    ar: "نودّ أن نعدّ زيارات صفحات هذا الموقع بأداة قياس خارجية تضع ملف تعريف ارتباط في متصفحك. لا تعمل إلا إذا وافقت، ولا تصلها أي بيانات تعرّف بك مثل اسمك أو بريدك. تستطيع تغيير اختيارك في أي وقت من أسفل الصفحة.",
    en: "We'd like to count visits to this site's pages with an outside analytics tool that sets a cookie in your browser. It runs only if you agree, and it never receives anything that identifies you, such as your name or email. You can change your choice any time from the bottom of the page.",
  },
  accept: { ar: "أوافق", en: "Accept" },
  reject: { ar: "لا أوافق", en: "Reject" },
  privacy: { ar: "سياسة الخصوصية", en: "Privacy policy" },
  settings: { ar: "إعدادات ملفات الارتباط", en: "Cookie settings" },
  label: { ar: "اختيار ملفات تعريف الارتباط", en: "Cookie choice" },
} as const;
