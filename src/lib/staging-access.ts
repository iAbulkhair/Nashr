import { createHmac } from "node:crypto";
import { sameSecret } from "@/lib/secret";

/**
 * The staging lock's cookie and token (rules 674-675). The cookie holds an HMAC of a fixed label keyed by
 * `STAGING_ACCESS_KEY`, never the code itself, so a copied cookie cannot be turned back into the code and changing
 * the key signs everyone out. This file and `src/proxy.ts` never pull in the store, the rate limiter or the auth
 * module: the proxy must not load Redis. `STAGING_ACCESS_KEY` is read at call time.
 */
export const STAGING_COOKIE = "thakeen_staging";

/** The only paths a visitor without the cookie reaches on staging. Exact match: no trailing slash, no case folding. */
export const STAGING_OPEN_PATHS: ReadonlySet<string> = new Set([
  "/ar/staging-access",
  "/en/staging-access",
  "/api/staging-access",
  "/robots.txt",
]);

/**
 * Rule 1760: the staging lock also lets `/m/{name}` through, because Meta, kie, Higgsfield and Composio fetch staging's
 * media with no cookie. The route itself still demands a member session or a share signature (rules 1754-1755), so this
 * opens nothing a visitor without one can read. No other prefix opens.
 */
export const stagingOpen = (pathname: string): boolean => STAGING_OPEN_PATHS.has(pathname) || pathname.startsWith("/m/");

/** The cookie value for a key, or null without one (an empty key is no key: nobody gets in). */
export function accessToken(key: string | undefined): string | null {
  if (!key) return null;
  return createHmac("sha256", key).update("staging-access-v1").digest("hex");
}

/** Does this cookie match the token of the current `STAGING_ACCESS_KEY`? False when the key is missing or empty. */
export function hasAccess(cookie: string | undefined): boolean {
  const token = accessToken(process.env.STAGING_ACCESS_KEY);
  return token !== null && sameSecret(cookie, token);
}
