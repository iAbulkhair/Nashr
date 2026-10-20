/**
 * The workspace in the link (multi-workspace release M2, docs/specs/2026-10-18-multi-org.md section 7, decision 7 as the
 * founder changed it on 2026-10-19, rules 2112-2114). Import-free, so the proxy, client components and server code all
 * read the same path rules.
 *
 * A workspace page is served at `/{lang}/app/w/{handle}/…`; the proxy rewrites it to `/{lang}/app/…` and sets the
 * `x-thakeen-ws` request header to the handle (src/proxy.ts). Client requests to `/api/` send the handle of their own
 * page in the same header (src/lib/api-client.ts). The handle is only a selector among the caller's own memberships,
 * re-checked on every request (src/lib/auth.ts `resolveSession`): it is never a key and never names an account by itself.
 *
 * Part C (brand in the link) nests `/w/{handle}/b/{brandId}/…`; the `rest` kept here carries that segment untouched.
 */

/** The request header that names the request's workspace. Set by the proxy for pages, by `api-client.ts` for APIs. */
export const WS_HEADER = "x-thakeen-ws";

/** A workspace handle (rule 2114): `w_` and 16 base32 characters. No `@`, `.`, `:` or `#`. */
export const HANDLE_RE = /^w_[a-z2-7]{16}$/;

/** The handle when `h` is one, else null. */
export const asHandle = (h: string | null | undefined): string | null => (h && HANDLE_RE.test(h) ? h : null);

const WS_PATH = /^\/([^/]+)\/app\/w\/([^/?#]+)(\/[^?#]*)?$/;

/** `/{lang}/app/w/{handle}{rest}` split into its parts; null for any other path or a malformed handle. */
export function splitWsPath(pathname: string): { lang: string; handle: string; rest: string } | null {
  const m = WS_PATH.exec(pathname);
  if (!m || !HANDLE_RE.test(m[2])) return null;
  return { lang: m[1], handle: m[2], rest: m[3] && m[3] !== "/" ? m[3] : "" };
}

/** The path without its `w/{handle}` segment: what the page folders under `src/app/[lang]/app` serve. */
export function stripWs(pathname: string): string {
  const p = splitWsPath(pathname);
  return p ? `/${p.lang}/app${p.rest}` : pathname;
}

/** The handle in a browser path, or null. */
export const handleOfPath = (pathname: string): string | null => splitWsPath(pathname)?.handle ?? null;

/**
 * An app link. `path` is what follows `/app` (`""`, `"/tasks"`, `"/tasks?tab=done#x"`). With a handle the link is
 * `/{lang}/app/w/{handle}{path}`; without one it is today's `/{lang}/app{path}`, so with `MULTI_ORG` off (no handle is
 * ever passed) every link is the old string. A person-level page never takes a handle (`PERSON_PAGES`).
 */
export function appHref(lang: string, path: string = "", handle?: string | null): string {
  const p = path === "/" ? "" : path;
  const h = asHandle(handle);
  if (!h || personPage(`/${lang}/app${p}`)) return `/${lang}/app${p}`;
  return `/${lang}/app/w/${h}${p}`;
}

/**
 * The person-level pages under `/{lang}/app`: they belong to the person, not to a workspace, and stay outside
 * `w/{handle}` (spec section 7 "Routes"). The old-URL redirect leaves them alone.
 */
export const PERSON_PAGES: readonly string[] = [
  "/login",
  "/signup",
  "/forgot",
  "/reset",
  "/verify",
  "/join",
  "/admin",
  "/workspaces",
  "/settings/security",
];

/** True when `pathname` (`/{lang}/app/…`, query and hash ignored) is a person-level page. */
export function personPage(pathname: string): boolean {
  const m = /^\/[^/]+\/app(\/[^?#]*)?/.exec(pathname);
  if (!m) return false;
  const rest = m[1] ?? "";
  return PERSON_PAGES.some((p) => rest === p || rest.startsWith(p + "/"));
}

/**
 * The API paths outside the second guard (rule 2113): person-level routes (`currentPerson()`, the person's own security),
 * sign-in and sign-up, the founder console, OAuth consent and callbacks, the staging gate, public forms and every path
 * the cross-site check exempts (webhooks, crons, MCP bearer calls: src/lib/csrf.ts `CROSS_SITE_EXEMPT`, repeated here so
 * this file stays import-free). An entry ending in `/` is a prefix; any other entry is one exact path.
 * tests/multi-org-guard-coverage.test.ts holds the two lists together and fails when a free path serves a
 * state-changing handler that calls `sc(`.
 */
export const WORKSPACE_FREE: readonly string[] = [
  "/api/auth/",
  "/api/workspaces",
  "/api/workspaces/",
  "/api/team/accept",
  "/api/account/2fa",
  "/api/account/sessions",
  "/api/account/email",
  "/api/account/google",
  "/api/admin/",
  "/api/oauth/",
  "/api/staging-access",
  "/api/waitlist",
  "/api/affiliates",
  "/api/ops/",
  // src/lib/csrf.ts CROSS_SITE_EXEMPT
  "/api/mcp",
  "/api/oauth/token",
  "/api/oauth/register",
  "/api/media/hook/",
  "/api/secretary/booking/",
  "/api/billing/paymob/",
  "/api/shopify/compliance",
  "/api/cron/",
];

/** Whether an API path is outside the second guard. A trailing slash is ignored. */
export function workspaceFree(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return WORKSPACE_FREE.some((e) => (e.endsWith("/") ? path.startsWith(e) : path === e));
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The second guard (rule 2113): true when a state-changing browser request (it carries the session cookie) to a
 * workspace API names no workspace. Such a request answers 409 `workspace_missing` and writes nothing, so a tab can
 * never save into whichever workspace the session last chose. A GET without the header uses the session's account.
 * The caller checks `MULTI_ORG` first.
 */
export function workspaceMissing(method: string, pathname: string, hasSession: boolean, handle: string | null): boolean {
  if (!hasSession || !STATE_CHANGING.has(method.toUpperCase())) return false;
  if (!pathname.startsWith("/api/") || workspaceFree(pathname)) return false;
  return !asHandle(handle);
}

/**
 * True for the error `notFound()` throws (its digest is `NEXT_HTTP_ERROR_FALLBACK;404`), so the route wrapper can answer
 * a foreign handle with the JSON `not_found` body instead of the 404 page.
 */
export const isNotFoundError = (e: unknown): boolean => {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === "string" && d.startsWith("NEXT_HTTP_ERROR_FALLBACK;404");
};

/**
 * Where an old app address goes (spec section 7 "Old URLs"): `/{lang}/app/…` without `w/` answers 307 to the same page
 * of the session's workspace, the query kept, so bookmarks and old mails keep working. Null when nothing moves: a path
 * already inside `w/{handle}`, a person-level page, a path outside the app, or no valid handle (never a redirect loop).
 */
export function oldAppTarget(lang: string, browserPath: string, search: string, handle: string | null): string | null {
  const base = `/${lang}/app`;
  if (!asHandle(handle) || splitWsPath(browserPath) || personPage(browserPath)) return null;
  if (browserPath !== base && !browserPath.startsWith(base + "/")) return null;
  if (browserPath.startsWith(base + "/w/")) return null;
  return appHref(lang, browserPath.slice(base.length) + search, handle);
}
