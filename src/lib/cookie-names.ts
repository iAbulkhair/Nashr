/**
 * Cookie and browser-storage names (rules 1810-1813). Import-free on purpose: client components (the language and theme
 * toggles, the install hint, the invite page) and the head theme script use it.
 *
 * The product was built under the code name Nashr, so its cookies were `nashr_*`. They are renamed to `thakeen_*` in two
 * releases (rule 679, `docs/system/flows.md` "Releases"). This is the EXPAND release:
 * - every write uses the new name, and the code that writes a cookie the server owns also clears the old one;
 * - every read asks for the new name first and falls back to the old one, so a browser that still holds only
 *   `nashr_session` (or `nashr_lang`, `nashr_partner`...) stays signed in, keeps its language and keeps its partner;
 * - every delete (sign out, "stop viewing", a used OAuth state) clears both names.
 * The CONTRACT release, after the 30-day session and partner cookies written before this release have expired, deletes
 * `LEGACY` and the fallbacks (a language or theme cookie older than that falls back to the default, which is harmless).
 * A rollback to the code before this release ignores the new names safely: a visitor who signed in after the release
 * signs in again, and nobody's data changes.
 *
 * Not renamed here: the console's own cookies (`nashr_admin`, `nashr_admin_2fa`), whose code the staff-identity change
 * rewrites; they follow once that change is merged.
 */

export const SESSION_COOKIE = "thakeen_session";
/** The founder's own session, kept while a customer's account is viewed (console impersonation). */
export const RETURN_COOKIE = "thakeen_return";
/** Display hint only: which account the console is viewing. Never trusted, never logged. */
export const IMPERSONATE_COOKIE = "thakeen_impersonate";
export const LANG_COOKIE = "thakeen_lang";
export const THEME_COOKIE = "thakeen_theme";
export const PARTNER_COOKIE = "thakeen_partner";
export const OAUTH_COOKIE = "thakeen_oauth";
/**
 * The desktop rail's width on this browser (rules 3123-3127): `collapsed` or `open`. Display only, read by the app layout
 * so the first paint has the right width. New under this name (no `nashr_` spelling ever existed), so it has no LEGACY entry.
 */
export const RAIL_COOKIE = "thakeen_rail";

/** sessionStorage: the invite token from the link's fragment, so a language switch keeps it. */
export const INVITE_TOKEN_KEY = "thakeen_invite_token";
/** localStorage: when the install hint was dismissed. */
export const INSTALL_DISMISS_KEY = "thakeen_install_hint_dismissed";
/** localStorage: the first-week journey's ticked milestones. */
export const JOURNEY_KEY = "thakeen:journey:v1";
/** localStorage: the metrics a viewer picked on the reports page. */
export const METRICS_KEY = "thakeen:metrics";

/** Each new name and the old name it replaces. Read as a fallback, cleared on write and delete; gone in the contract release. */
export const LEGACY: Readonly<Record<string, string>> = {
  [SESSION_COOKIE]: "nashr_session",
  [RETURN_COOKIE]: "nashr_return",
  [IMPERSONATE_COOKIE]: "nashr_impersonate",
  [LANG_COOKIE]: "nashr_lang",
  [THEME_COOKIE]: "nashr_theme",
  [PARTNER_COOKIE]: "nashr_partner",
  [OAUTH_COOKIE]: "nashr_oauth",
  [INVITE_TOKEN_KEY]: "nashr_invite_token",
  [INSTALL_DISMISS_KEY]: "nashr_install_hint_dismissed",
  [JOURNEY_KEY]: "nashr:journey:v1",
  [METRICS_KEY]: "nashr:metrics",
};

/** Both spellings of a name, the new one first: the order every read tries them in. */
export const namesOf = (name: string): string[] => (LEGACY[name] ? [name, LEGACY[name]] : [name]);

type Jar = { get(name: string): { value: string } | undefined };
/** A cookie's value from Next's `cookies()` or `req.cookies`: the new name, else the old one. Empty values count as absent. */
export function readCookie(jar: Jar, name: string): string | undefined {
  for (const n of namesOf(name)) {
    const v = jar.get(n)?.value;
    if (v) return v;
  }
  return undefined;
}

type Deleter = { delete(name: string): unknown };
/** Delete a cookie under both names. */
export function dropCookie(jar: Deleter, name: string): void {
  for (const n of namesOf(name)) jar.delete(n);
}
/** Clear only the old name, after the new one was written. */
export function dropLegacyCookie(jar: Deleter, name: string): void {
  if (LEGACY[name]) jar.delete(LEGACY[name]);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A cookie's value from a raw `Cookie` header or `document.cookie`, new name first, when it matches `allowed`. */
export function cookieFromHeader(header: string | null | undefined, name: string, allowed: RegExp = /[^;]+/): string | undefined {
  for (const n of namesOf(name)) {
    const v = new RegExp(`(?:^|;\\s*)${escape(n)}=(${allowed.source})(?:;|$)`).exec(header ?? "")?.[1];
    if (v) return v;
  }
  return undefined;
}

/** A `document.cookie` line that removes the old name of a cookie the browser writes itself (language, theme). */
export const expireLegacyLine = (name: string): string | null => (LEGACY[name] ? `${LEGACY[name]}=; path=/; max-age=0; samesite=lax` : null);

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Partial<Pick<Storage, "setItem" | "removeItem">>;
/** A storage item under the new key, else the old one. Throws what the storage throws (callers already wrap storage). */
export function readStored(store: ReadStore | null | undefined, key: string): string | null {
  if (!store) return null;
  for (const k of namesOf(key)) {
    const v = store.getItem(k);
    if (v !== null) return v;
  }
  return null;
}
/** Write under the new key and drop the old one. */
export function writeStored(store: WriteStore | null | undefined, key: string, value: string): void {
  store?.setItem?.(key, value);
  if (LEGACY[key]) store?.removeItem?.(LEGACY[key]);
}
/** Remove under both keys. */
export function removeStored(store: WriteStore | null | undefined, key: string): void {
  for (const k of namesOf(key)) store?.removeItem?.(k);
}
