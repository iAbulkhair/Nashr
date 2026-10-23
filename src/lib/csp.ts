/**
 * The Content-Security-Policy (rules 2320-2329). Import-free on purpose: the proxy builds it for every page request, and
 * nothing the proxy loads may reach the store (tests/staging.test.ts holds that list closed).
 *
 * Scripts are enforced and nonce based: a fresh nonce per page request, `'strict-dynamic'` so the scripts Next loads
 * with that nonce may load their own chunks and the Turnstile script, and no `'unsafe-inline'`, so an injected
 * `<script>` or `onerror=` attribute does not run. Next reads the nonce from the request's policy and puts it on its own
 * scripts; the page must render per request for that, so src/app/[lang]/layout.tsx reads the nonce header (rule 2322).
 * `'self'` and the Turnstile origin stay for browsers older than `'strict-dynamic'`, which ignore the nonce-less rest.
 * Development adds `'unsafe-eval'`: React rebuilds server error stacks with eval there, never in production.
 *
 * Styles stay out of the enforced policy (rule 2324): React `style={...}` attributes are used across the app and a nonce
 * cannot cover an attribute, so `style-src` without `'unsafe-inline'` would break the layout. The report-only twin keeps
 * the rest of the full policy (rule 1341) visible in the console until it is enforced in turn.
 */

/** The request header the proxy hands the page's nonce on. Never a secret worth keeping: it is in the page itself. */
export const NONCE_HEADER = "x-nonce";

/** The Cloudflare Turnstile origin (rule 428): its script, iframe and calls on signup and forgot-password. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** The directives every answer has carried since rule 428; the page policy keeps them all. */
const BASE = ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"] as const;
/** The enforced policy of an answer that is not a page (the API, media, files): no scripts run there. */
export const BASE_CSP = BASE.join("; ");

/** A fresh nonce: 16 random bytes, base64 (128 bits, unguessable). One per page request, never reused. */
export function cspNonce(): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(16))) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Hosts one page adds for the public site's active analytics provider (rules 3340-3341, src/lib/analytics.ts): its script
 * host to script-src, its event host to the report-only connect-src. Empty, the default, leaves both policies exactly as
 * before; the proxy passes it only on a public marketing page while a provider is switched on. Origins only: a value
 * with a space or `;` would add a directive, so it is dropped here as well as refused where it is read.
 */
export type CspExtra = { script: readonly string[]; connect: readonly string[] };
const NO_EXTRA: CspExtra = { script: [], connect: [] };
const hosts = (list: readonly string[]): string =>
  list.filter((h) => /^https:\/\/[A-Za-z0-9.*:-]+$/.test(h)).map((h) => ` ${h}`).join("");

/** The script directive of both policies: the nonce, `'strict-dynamic'`, never `'unsafe-inline'`. */
export function scriptSrc(nonce: string, dev: boolean, extra: CspExtra = NO_EXTRA): string {
  return `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${TURNSTILE_ORIGIN}${hosts(extra.script)}${dev ? " 'unsafe-eval'" : ""}`;
}

/** The enforced policy of a page: the nonce-based scripts plus the four directives of rule 428. */
export function pageCsp(nonce: string, dev: boolean, extra: CspExtra = NO_EXTRA): string {
  return [scriptSrc(nonce, dev, extra), ...BASE].join("; ");
}

/**
 * The full policy, report-only (rule 1341): what the site should end up enforcing for everything but scripts. Beyond
 * 'self': Turnstile's frame and calls; inline styles (above); images and video from any https host, because rendered
 * replies and catalogue images name outside hosts and media plays from blob: and the storage host.
 */
export function reportOnlyCsp(nonce: string, dev: boolean, extra: CspExtra = NO_EXTRA): string {
  return [
    "default-src 'self'",
    scriptSrc(nonce, dev, extra),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${TURNSTILE_ORIGIN} https://*.public.blob.vercel-storage.com${hosts(extra.connect)}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...BASE,
  ].join("; ");
}

/**
 * True for a path that renders a page and so gets the nonce policy. The API, the media files (`/m/`, which send their
 * own `sandbox` policy, rule 1756) and the short links (`/p/`, a redirect) keep the base policy.
 */
export const pagePath = (pathname: string): boolean => !/^\/(?:api|m|p)(?:\/|$)/.test(pathname);
