/**
 * The one canonical public origin of the app: links in emails, OAuth issuer and redirect URIs, the MCP URL in help text,
 * robots, sitemap, share metadata, the crawler's user agent and referral links.
 *
 * `APP_ORIGIN` when it is set; otherwise the current production host. That host appears nowhere else in `src/`
 * (tests/origin.test.ts fails the build if it does), so moving to the owned domain is one environment change, not a hunt
 * through a dozen copies of the literal. A value with a trailing slash is trimmed, and an empty value counts as unset:
 * both used to produce links such as `https://host//ar/app` or `/ar/app` with no host at all.
 */
export const FALLBACK_ORIGIN = "https://nashr-tau.vercel.app";

export function appOrigin(): string {
  const v = (process.env.APP_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return v || FALLBACK_ORIGIN;
}

/** The origin's host alone (no scheme), for prose such as a sample prompt that names the site. */
export const appHost = (): string => new URL(appOrigin()).host;
