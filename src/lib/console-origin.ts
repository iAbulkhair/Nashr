import { NextResponse } from "next/server";
import { CROSS_SITE_METHODS, CROSS_SITE_ERROR, SAME_ORIGIN_FETCH_SITES, acceptedOrigins } from "./csrf";

/**
 * The console's own write check (rule 1647), run by `secondFactorRefusal` before anything else and by every staff
 * sign-in route. It repeats the proxy's cross-site check (src/lib/csrf.ts) inside the route, stricter:
 *
 * - `Sec-Fetch-Site`, when present, must be `same-origin` or `none`;
 * - `Origin`, when present, must be this site's own (`acceptedOrigins`), whatever `Sec-Fetch-Site` said; `null` is refused;
 * - a body must be JSON (`Content-Type: application/json`), so no HTML form of another site can deliver one.
 *
 * A request with neither header (a script on `x-admin-key`, curl) holds no browser's cookie and passes the first two.
 * Reads (GET, HEAD, OPTIONS) are not checked.
 *
 * `script` is true when the actor is the `x-admin-key` header (`via: "header"`): the Origin and JSON rules are skipped for
 * it. They exist to stop another site from riding a browser's cookie, and a header actor carries the key itself, which no
 * other site can make a browser send; scripts may post forms or set an Origin of their own (rule 1647, flows section 71).
 * `Sec-Fetch-Site: cross-site` is still refused.
 */
export function consoleWriteRefusal(req: Request, script = false): NextResponse | null {
  if (!CROSS_SITE_METHODS.has(req.method.toUpperCase())) return null;
  const refused = () => NextResponse.json({ ok: false, error: CROSS_SITE_ERROR }, { status: 403, headers: { "cache-control": "no-store" } });
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && !SAME_ORIGIN_FETCH_SITES.has(site.trim().toLowerCase())) return refused();
  if (script) return null;
  const origin = req.headers.get("origin");
  if (origin !== null && (origin.trim() === "null" || !acceptedOrigins(req).has(origin.trim()))) return refused();
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if ((req.body !== null || type !== "") && type !== "application/json") {
    return NextResponse.json({ ok: false, error: "json_only" }, { status: 415, headers: { "cache-control": "no-store" } });
  }
  return null;
}
