/**
 * The Straitly gateway's base URL (STRAITLY_BASE_URL), checked in one place for the app (`anthropic()` in src/lib/model.ts)
 * and for the release script (scripts/check-models.ts). Pure: it reads no environment variable and imports nothing, so the
 * script loads it without the app. Rule 810, tests/model-provider.test.ts and tests/model-catalog.test.ts.
 *
 * The base is an origin and nothing else. The SDK adds `/v1/messages` and the script adds `/v1/models`, so a base with
 * `/v1` (Straitly's docs show one for their own clients) would send every call to `/v1/v1/...`; any other path, a query or
 * a fragment changes where the gateway's key goes, and user info would put a secret in the URL. https only, since the key
 * travels in a header, except plain http to a loopback host (localhost, 127.0.0.1, [::1]) for a local stand-in.
 *
 * A refusal throws one of two fixed messages that never contain the value (it can hold user info) or a key.
 */
export const DEFAULT_GATEWAY_BASE_URL = "https://api.straitly.ai";
/** Not a URL (whitespace or a control character inside, port 0 included), or a scheme the key may not travel over. */
export const INVALID_GATEWAY_URL = "invalid_straitly_base_url";
/** A URL with more than an origin in it. */
export const GATEWAY_URL_NOT_ORIGIN = "invalid_straitly_base_url: origin only, no /v1 or other path, no query, fragment or user info";

const LOOPBACK: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin to send to (`https://host[:port]`, lower-case), from STRAITLY_BASE_URL's value, or the default when it is empty. */
export function gatewayOrigin(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_GATEWAY_BASE_URL;
  // Whitespace or a control character left inside after the trim: the parser drops a tab or newline without a word, so
  // "https://api.straitly.ai\n.evil.com" would become the host api.straitly.ai.evil.com.
  if (/[\s\p{Cc}]/u.test(value)) throw new Error(INVALID_GATEWAY_URL);
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(INVALID_GATEWAY_URL);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new Error(INVALID_GATEWAY_URL);
  if (u.port === "0") throw new Error(INVALID_GATEWAY_URL);
  // `?`, `#` and `@` in the text too: an empty query, fragment or user info parses to nothing and would otherwise pass.
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash || /[?#@]/.test(value)) throw new Error(GATEWAY_URL_NOT_ORIGIN);
  return u.origin;
}
