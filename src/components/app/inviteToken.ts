/**
 * Invite links look like /{lang}/app/join#t=<64 hex>. The token rides in the URL FRAGMENT, which browsers never send to
 * a server, so it stays out of server, proxy and edge logs and out of the Referer header. It is read on the client only,
 * then removed from the address bar (`withoutFragment`), and posted in a JSON body to /api/team/accept. Never a query
 * string (CLAUDE.md: secrets are never accepted in URLs).
 */
import { INVITE_TOKEN_KEY, readStored, removeStored, writeStored } from "@/lib/cookie-names";

const TOKEN = /^[a-f0-9]{64}$/i;

/** The token from `location.hash`, lower-cased, or "" when the fragment carries none or a malformed one. */
export function readInviteToken(hash: string): string {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("t") ?? "";
  return TOKEN.test(raw) ? raw.toLowerCase() : "";
}

/**
 * The revert link of an address move (account-id R2, D1): /{lang}/app/reset#r=<64 hex>, mailed to the OLD address. Read
 * like the reset token, from the fragment only; "" when there is none or it is malformed.
 */
export function readRevertToken(hash: string): string {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("r") ?? "";
  return TOKEN.test(raw) ? raw.toLowerCase() : "";
}

/** The same address with no fragment: what the join page leaves in the address bar and history once it has read the token. */
export const withoutFragment = (loc: { pathname: string; search: string }) => `${loc.pathname}${loc.search}`;

/**
 * The token for the rest of this TAB's life, in sessionStorage (per tab, per origin, gone when the tab closes). The
 * fragment is cleared from the address bar once read, so switching the page language, which reloads the page under the
 * other /{lang}, would otherwise land on "this invite link is incomplete" with no way to join in that language.
 * Forgotten after a successful accept and after the server calls the token invalid. Storage can be blocked (private
 * windows, site data off): every call is wrapped, and the page works without it, as before.
 */
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const store = (): Store | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};
export function rememberInviteToken(token: string, s: Store | null = store()) {
  try {
    if (TOKEN.test(token)) writeStored(s, INVITE_TOKEN_KEY, token.toLowerCase());
  } catch {
    // Storage refused: the fragment was the only copy, as before.
  }
}
/** The remembered token, or "" when there is none, it is malformed, or storage is unavailable. */
export function recallInviteToken(s: Store | null = store()): string {
  try {
    const t = readStored(s, INVITE_TOKEN_KEY) ?? "";
    return TOKEN.test(t) ? t.toLowerCase() : "";
  } catch {
    return "";
  }
}
export function forgetInviteToken(s: Store | null = store()) {
  try {
    removeStored(s, INVITE_TOKEN_KEY);
  } catch {
    // Nothing to forget.
  }
}
