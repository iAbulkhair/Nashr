/**
 * The one canonical public origin of the app: links in emails, OAuth issuer and redirect URIs, the MCP URL in help text
 * and on the MCP settings page, the connector OAuth callback's return link, robots, sitemap, share metadata, the
 * crawler's user agent and referral links.
 *
 * `APP_ORIGIN` when it is set; otherwise the current production host. That host appears nowhere else in `src/`
 * (tests/origin.test.ts fails the build if it does), so moving to the owned domain is one environment change, not a hunt
 * through a dozen copies of the literal. A value with a trailing slash is trimmed, and an empty value counts as unset:
 * both used to produce links such as `https://host//ar/app` or `/ar/app` with no host at all.
 *
 * The value is also checked. `metadataBase` in the `[lang]` layout parses it on every page, so a value that is not an
 * absolute http(s) origin (`thakeen.com` with no scheme, a typo, a path) would turn every page into a 500. Such a value
 * is ignored with one warning that names the variable, never its value, and the fallback is used until it is fixed.
 */
export const FALLBACK_ORIGIN = "https://nashr-tau.vercel.app";

let warned = false;

export function appOrigin(): string {
  const v = (process.env.APP_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!v) return FALLBACK_ORIGIN;
  const ok = (() => {
    try {
      const u = new URL(v);
      // Only a bare origin: no path, query, fragment or credentials, so `${appOrigin()}/x` is always a well-formed URL.
      const bare = u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password && !v.includes("?") && !v.includes("#");
      return (u.protocol === "https:" || u.protocol === "http:") && bare ? u.origin : null;
    } catch {
      return null;
    }
  })();
  if (ok) return ok;
  if (!warned) {
    warned = true;
    console.warn("APP_ORIGIN is not an absolute http(s) origin such as https://example.com; using the fallback origin");
  }
  return FALLBACK_ORIGIN;
}

/** The origin's host alone (no scheme), for prose such as a sample prompt that names the site. */
export const appHost = (): string => new URL(appOrigin()).host;
