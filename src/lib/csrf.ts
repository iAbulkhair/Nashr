import { NextResponse, type NextRequest } from "next/server";
import { appOrigin } from "@/lib/origin";

/**
 * The cross-site request check for `/api` (rules 690-693), run by `src/proxy.ts` before any route handler.
 *
 * The session cookie is `SameSite=Lax` and host-only (src/lib/auth.ts `sessionCookie`). Lax keeps it off a cross-site
 * POST from a third-party page, but three holes stay open: routes call `req.json()` without checking `Content-Type`, so
 * a `<form enctype="text/plain">` can deliver JSON; login and logout need no cookie to be abused (log a victim into the
 * attacker's account, or out of their own); and a sibling under the same registrable domain, such as
 * `staging.thakeen.com`, is "same site", so Lax sends the cookie on its posts. The browser says who started a request,
 * so the check reads that instead of a token:
 *
 * 1. Only POST, PUT, PATCH and DELETE are checked. GET, HEAD and OPTIONS change nothing, and a CORS preflight is OPTIONS.
 * 2. `Sec-Fetch-Site`, when present, decides alone: `same-origin` or `none` (the person typed the address or opened a
 *    bookmark) passes, anything else is refused. Pages cannot set this header: every `Sec-` name is reserved to the
 *    browser. `Origin` is not compared as well: a browser never pairs `same-origin` with another site's `Origin`, and a
 *    client that forges the pair holds no victim's cookie, so the comparison could only refuse our own pages when the
 *    server cannot see its public name (Hostinger without APP_ORIGIN, behind a proxy that rewrites `Host`). Go 1.25's
 *    `CrossOriginProtection` uses the same order.
 * 3. Without `Sec-Fetch-Site` (an older browser), `Origin`, when present, must be one of `acceptedOrigins`. `null` (a
 *    sandboxed frame, a `data:` page, a request redirected across origins) is refused: our own pages never send it,
 *    because next.config.ts sets `Referrer-Policy: strict-origin-when-cross-origin`.
 * 4. A request with neither header passes. Only browsers send them, and the callers that send neither (crons with the
 *    CRON_SECRET bearer, QStash, webhooks, MCP and OAuth clients, curl) hold no browser's cookie.
 *
 * Paths in `CROSS_SITE_EXEMPT` skip the check. The proxy still runs on them, because the staging lock must see every
 * path (src/proxy.ts `config`, rule 674), so Next buffers their body up to `experimental.proxyClientMaxBodySize` (6 MB,
 * next.config.ts, rule 774) before the routes' own 64 KB caps refuse it. None of their state-changing handlers reaches
 * the session or a cookie, even through what they import, which tests/csrf.test.ts pins, so a cross-site post to them
 * can only do what its own token or signature allows.
 */

/** The methods that are checked. */
export const CROSS_SITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** `Sec-Fetch-Site` values that mean this site, or the person, started the request. */
export const SAME_ORIGIN_FETCH_SITES: ReadonlySet<string> = new Set(["same-origin", "none"]);

/** The `error` field of the 403 answer. */
export const CROSS_SITE_ERROR = "cross_site";

/**
 * Routes that take cross-site browser or third-party posts, or that no browser session can reach. An entry ending in
 * `/` is a prefix; any other entry is one exact path, because a prefix would also cover the cookie routes beside it.
 *
 * Buffering. For every request the proxy sees with a body, Next clones that body, buffers up to 6 MB of it
 * (`experimental.proxyClientMaxBodySize` in next.config.ts, rule 774) and waits for the whole upload before the proxy's
 * answer or the route runs. Since the staging lock (rule 674) the proxy sees every path, these included, so the webhook
 * and cron routes' 64 KB caps refuse a larger body only after Next has read it. The limit is one for every route, file
 * and media uploads included, so it stays above the largest legitimate body (`POST /api/performance`).
 *
 * - `/api/mcp`: the MCP endpoint. Bearer token only, `Access-Control-Allow-Origin: *`, and browser-based MCP clients
 *   post to it from their own origin. Exact: `/api/mcp/token` and `/api/mcp/grants` are cookie routes and stay checked.
 * - `/api/oauth/token`, `/api/oauth/register`: token exchange and client registration for MCP clients. Public or
 *   client-authenticated, CORS `*`, called from wherever the client runs. `/api/oauth/approve` is NOT exempt: it is
 *   the consent form posted from our own `/oauth/authorize` page, and it reads the session.
 * - `/api/media/hook/`: kie.ai and Higgsfield job callbacks. Their HTTP clients are not ours and may send an `Origin`
 *   of their own; the body is only a hint that is checked by asking the provider.
 * - `/api/secretary/booking/`: Cal.com and Calendly booking webhooks, proven by the provider's signature over the body.
 *   Their HTTP clients are not ours either. With the slash: `/api/secretary/booking` itself manages the links with the
 *   session cookie and stays checked.
 * - `/api/billing/paymob/`: the Paymob webhook, `/api/billing/paymob/webhook` (PR #279), posted by Paymob's servers and
 *   proven by Paymob's HMAC. The buyer's return from Paymob's page lands on the billing page (a GET), not here;
 *   `/api/billing/checkout` and `/api/billing/renewal` are cookie routes outside the prefix and stay checked.
 * - `/api/billing/geidea/`: the Geidea order callback, `/api/billing/geidea/webhook` (rule 3905), posted by Geidea's
 *   servers and proven by the signature inside its body. The buyer's return lands on the billing page (a GET).
 * - `/api/shopify/compliance`: Shopify's mandatory compliance webhooks (rules 2168-2171), posted by Shopify's servers
 *   and proven by `X-Shopify-Hmac-Sha256` over the raw body. Exact: nothing else lives under `/api/shopify`.
 * - `/api/cron/`: the cron runner (GET with the CRON_SECRET bearer, which the check never looks at) and POST
 *   `/api/cron/secretary` from our own QStash schedule or with that bearer. They send neither header and would pass
 *   anyway; the entry keeps that true if a cron route ever reads a browser header. No cron handler reads a session.
 *
 * The other routes that a provider or a feed reader calls, `/api/connect/{provider}/callback` and
 * `/api/secretary/feed/{token}`, are GET, so the check never looks at them.
 */
export const CROSS_SITE_EXEMPT: readonly string[] = [
  "/api/mcp",
  "/api/oauth/token",
  "/api/oauth/register",
  "/api/media/hook/",
  "/api/secretary/booking/",
  "/api/billing/paymob/",
  "/api/billing/geidea/",
  "/api/shopify/compliance",
  "/api/cron/",
];

/** A host as it appears in `Host` or `X-Forwarded-Host`: a name or a bracketed IPv6 address, then an optional port. */
const HOST_SHAPE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

/** The first value of a comma-separated header, lowercased; "" when absent. */
const first = (v: string | null) => (v ?? "").split(",")[0].trim().toLowerCase();

/** Whether `pathname` skips the check. A trailing slash is ignored, so `/api/mcp/` is `/api/mcp`. */
export function isCrossSiteExempt(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return CROSS_SITE_EXEMPT.some((e) => (e.endsWith("/") ? path.startsWith(e) : path === e));
}

/**
 * The origins a same-origin request may carry: `appOrigin()`, and the request's own origin as the browser addressed
 * it. The scheme is `X-Forwarded-Proto` (first value) or else the URL's; the host is the first `X-Forwarded-Host` value
 * and the `Host` header, either one. Hostinger may run without APP_ORIGIN, and behind its proxy the server may see
 * neither the public name in the URL nor TLS, which is why both headers count and `https` on that host is always
 * accepted: only the holder of the host's certificate can serve a page whose origin is `https://` that host. Plain
 * `http` is accepted only when the server itself sees no TLS (local development).
 *
 * Trusting `X-Forwarded-Host` is safe here. A cross-site page cannot set it, or `Host` (which no page can set at all),
 * on a request to us: any header outside the CORS safelist makes the browser send a preflight first, and no checked
 * route grants one (the routes that do are exempt above). A client that is not a browser can forge every header,
 * `Origin` and `Sec-Fetch-Site` included, but it holds no victim's cookie, so it can do only what its own credentials
 * allow.
 */
export function acceptedOrigins(req: Request): Set<string> {
  const out = new Set([appOrigin()]);
  const proto = first(req.headers.get("x-forwarded-proto"));
  const scheme = proto === "http" || proto === "https" ? proto : new URL(req.url).protocol.replace(/:$/, "");
  for (const host of [first(req.headers.get("x-forwarded-host")), first(req.headers.get("host"))]) {
    if (!HOST_SHAPE.test(host)) continue;
    for (const s of new Set([scheme, "https"])) {
      try {
        out.add(new URL(`${s}://${host}`).origin);
      } catch {
        // Not a host after all: nothing to accept.
      }
    }
  }
  return out;
}

/** The 403 for a cross-site request: JSON, never cached. */
function refused(): NextResponse {
  return NextResponse.json({ error: CROSS_SITE_ERROR }, { status: 403, headers: { "cache-control": "no-store" } });
}

/** The 403 when another site started this state-changing `/api` request; null when it may go on to its route. */
export function crossSiteRefusal(req: NextRequest): NextResponse | null {
  if (!CROSS_SITE_METHODS.has(req.method.toUpperCase())) return null;
  if (isCrossSiteExempt(req.nextUrl.pathname)) return null;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return SAME_ORIGIN_FETCH_SITES.has(site.trim().toLowerCase()) ? null : refused();
  const origin = req.headers.get("origin");
  if (origin === null) return null;
  if (origin.trim() === "null" || !acceptedOrigins(req).has(origin.trim())) return refused();
  return null;
}
