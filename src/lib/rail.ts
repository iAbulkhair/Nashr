import { RAIL_COOKIE } from "./cookie-names";

/**
 * The folding desktop rail (rules 3123-3127). The choice lives in one first-party cookie on this browser, `thakeen_rail`,
 * holding only the word `collapsed` or `open`: no account field and nothing on the server. The app layout reads it with
 * `cookies()` so the first paint already has the chosen width (no jump after hydration); the fold button writes it with
 * `document.cookie`. Anything else in the cookie, or no cookie, is the open rail. Import-light: the layout and the
 * client sidebar both use it.
 */

/** Whether a stored value means "folded". Only the exact word counts. */
export const railCollapsed = (v: string | null | undefined): boolean => v === "collapsed";

/** The cookie line the fold button writes: a year, the whole site, lax, Secure on https. Holds only the word. */
export function railCookie(collapsed: boolean, secure: boolean): string {
  return `${RAIL_COOKIE}=${collapsed ? "collapsed" : "open"}; path=/; max-age=31536000; samesite=lax${secure ? "; secure" : ""}`;
}
