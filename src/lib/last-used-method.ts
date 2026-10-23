import { cookieFromHeader, LAST_LOGIN_COOKIE } from "./cookie-names";

/**
 * The "last used" hint on the log-in page (rules 3103-3105, after Supastarter's LastUsedBadge). Pure and import-free
 * apart from the cookie name, so the log-in form and the server share it and tests/last-used-method.test.ts pins it.
 *
 * After a sign-in finished with a session (`finishLogin` in src/lib/login-finish.ts, and a Google sign-up), the server
 * writes `thakeen_last_login` holding ONLY the method's name. It is a display hint: nothing reads it to decide anything,
 * it names no person, address or account, and a value that is not one of the three names is read as no hint at all.
 */
export const LOGIN_METHODS = ["password", "google", "passkey"] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export const isLoginMethod = (v: unknown): v is LoginMethod => typeof v === "string" && (LOGIN_METHODS as readonly string[]).includes(v);

/** 180 days: long enough to help the next sign-in, inside the 400-day cap browsers put on a cookie's life. */
export const LAST_LOGIN_MAX_AGE = 180 * 86_400;

/**
 * The cookie the server sets after a sign-in by `method`. Not HttpOnly on purpose (the form reads it); `sameSite` lax,
 * `secure` from the caller (off only on plain-HTTP local development), the whole site.
 */
export function lastUsedCookie(method: LoginMethod, secure: boolean) {
  return { name: LAST_LOGIN_COOKIE, value: method, options: { httpOnly: false, sameSite: "lax", secure, path: "/", maxAge: LAST_LOGIN_MAX_AGE } as const };
}

/** The hint from a `document.cookie` line (or a `Cookie` header): one of the three names, else null. */
export function readLastUsed(cookieHeader: string | null | undefined): LoginMethod | null {
  const v = cookieFromHeader(cookieHeader, LAST_LOGIN_COOKIE, /password|google|passkey/);
  return isLoginMethod(v) ? v : null;
}

/** Whether `method`'s button carries the tag. No hint, no tag. */
export const isLastUsed = (stored: LoginMethod | null | undefined, method: LoginMethod): boolean => !!stored && stored === method;

/** The tag's words. */
export const LAST_USED_TEXT = { ar: "آخر ما استخدمت", en: "Last used" } as const;
