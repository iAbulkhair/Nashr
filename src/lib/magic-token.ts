/**
 * The magic link's shape, shared by the server (src/lib/better-auth/magic.ts, POST /api/auth/magic) and the page that
 * opens it (src/components/app/MagicLanding.tsx). Imports nothing, so a client component can use it (rules 3415-3416).
 *
 * The link is `{appOrigin}/{lang}/app/magic#t={token}`: the token rides in the URL fragment, which a browser never sends
 * to a server, so it stays out of server, proxy and edge logs and the Referer header (rule 546). better-auth makes it:
 * 32 letters (`generateRandomString(32, "a-z", "A-Z")`, about 182 bits), stored only as its SHA-256.
 */

/** A token better-auth's magic-link plugin made. Anything else is refused before better-auth reads the store. */
export const MAGIC_TOKEN = /^[A-Za-z]{32}$/;

/** How long a link works, in seconds: 15 minutes, as the mail says. */
export const MAGIC_TTL_SECONDS = 900;

/** The token from `location.hash` (`#t=`), or "" when the fragment carries none or a malformed one. Never a query string. */
export function readMagicToken(hash: string): string {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("t") ?? "";
  return MAGIC_TOKEN.test(raw) ? raw : "";
}
