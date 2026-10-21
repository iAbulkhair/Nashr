import { createHmac } from "node:crypto";
import { acct, base32lower } from "./account-id";

/**
 * Workspace handles (multi-workspace release M2, docs/specs/2026-10-18-multi-org.md section 7, rule 2114).
 *
 * `wsHandle(aid) = "w_" + base32(HMAC-SHA256(CONNECT_SECRET, "ws:handle:v1:" + aid))[:16]`: a public, opaque name for
 * an account. It is derived, never stored and never indexed, so there is nothing to look an account up by: a request's
 * handle is only compared with the handles of the accounts the caller already holds (src/lib/auth.ts). It never contains
 * an address, even for a legacy account whose id is still its first address. Imports only node:crypto and
 * src/lib/account-id.ts, so the auth module and the proxy-free server code can both read it.
 */

/** Same source and dev fallback as src/lib/booking-token.ts; production must set its own CONNECT_SECRET. */
function connectSecret(): string {
  const v = process.env.CONNECT_SECRET;
  if (v) return v;
  if (process.env.NODE_ENV === "production") throw new Error("CONNECT_SECRET is not set");
  return process.env.WAITLIST_ADMIN_KEY ?? "dev-only-insecure";
}

/**
 * Handles can be made here: false only in production without CONNECT_SECRET. A route that would otherwise answer 500
 * from `wsHandle` checks it first and answers 503 `not_configured` before changing anything (M3 fix round).
 */
export function handlesReady(): boolean {
  return !!process.env.CONNECT_SECRET || process.env.NODE_ENV !== "production";
}

/** The handle of account `aid` (rule 2114). */
export function wsHandle(aid: string): string {
  const mac = createHmac("sha256", connectSecret()).update("ws:handle:v1:" + aid).digest();
  return "w_" + base32lower(mac).slice(0, 16);
}

/** The handle of a loaded account. */
export const handleOf = (u: { id?: string; email: string }): string => wsHandle(acct(u));

/** The one id among `aids` whose handle is `handle`, or null. Only ever called on ids read from the caller's own records. */
export function matchHandle(handle: string, aids: readonly string[]): string | null {
  for (const aid of aids) if (wsHandle(aid) === handle) return aid;
  return null;
}
