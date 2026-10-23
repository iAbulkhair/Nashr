import { appHref as brandHref, brandSectionOf } from "./brand-path";
import type { Lang } from "./i18n";

/**
 * The workspace in the link (multi-workspace release M2, docs/specs/2026-10-18-multi-org.md section 7, decision 7 as the
 * founder changed it on 2026-10-19, rules 2112-2114). Pure (it imports only brand-path.ts, itself pure), so the proxy,
 * client components and server code all read the same path rules.
 *
 * A workspace page is served at `/{lang}/app/w/{handle}/…`; the proxy rewrites it to `/{lang}/app/…` and sets the
 * `x-thakeen-ws` request header to the handle (src/proxy.ts). Client requests to `/api/` send the handle of their own
 * page in the same header (the one fetch wrapper, src/lib/brand-fetch.ts). The handle is only a selector among the caller's own memberships,
 * re-checked on every request (src/lib/auth.ts `resolveSession`): it is never a key and never names an account by itself.
 *
 * Part C (brand in the link, rules 885-891) nests `/w/{handle}/b/{brandId}/…`: the proxy strips `w/{handle}` and the real
 * `b/[brand]` folders serve the rest, so one rewrite serves both; the `rest` kept here carries the brand segment untouched.
 */

/** The request header that names the request's workspace. Set by the proxy for pages, by the fetch wrapper (`installBrandFetch`) for APIs. */
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
 * An app link, the one builder with both selectors (rules 889, 2113). `path` is what follows `/app` (`""`, `"/tasks"`,
 * `"/tasks?tab=done#x"`). It is brand-path.ts `appHref` with the workspace added: a brand section with a brand is
 * `/{lang}/app/w/{handle}/b/{brand}{path}`, any other path `/{lang}/app/w/{handle}{path}`. Without a handle it is main's
 * brand link (`/{lang}/app/b/{brand}…` or `/{lang}/app…`), so with `MULTI_ORG` off (no handle is ever passed) every link
 * is the string Part C makes. A person-level page never takes a handle (`PERSON_PAGES`) and is no brand section.
 */
export function appHref(lang: string, path: string = "", handle?: string | null, brand?: string | null): string {
  const p = path === "/" ? "" : path;
  const h = personPage(`/${lang}/app${p}`) ? null : asHandle(handle);
  return brandHref(lang as Lang, p, { brand, handle: h });
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
  "/magic",
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
  // better-auth and oRPC behind AUTH_ENGINE (rules 3414, 3423): the person's own sign-in, devices and passkeys; neither
  // keys a workspace (tests/better-auth-rpc.test.ts scans src/lib/rpc and src/lib/account-security.ts for `sc(`).
  "/api/better-auth/",
  "/api/rpc/",
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
export function oldAppTarget(lang: string, browserPath: string, search: string, handle: string | null, brand?: string | null): string | null {
  const base = `/${lang}/app`;
  if (!asHandle(handle) || splitWsPath(browserPath) || personPage(browserPath)) return null;
  if (browserPath !== base && !browserPath.startsWith(base + "/")) return null;
  if (browserPath.startsWith(base + "/w/")) return null;
  // `brand` (the session's, rule 891): an old brand section goes to `w/{handle}/b/{brand}/…` in this one hop, not on to
  // the `[...legacy]` page's 307. A path already under `/b/{id}` keeps its own brand segment.
  return appHref(lang, browserPath.slice(base.length) + search, handle, brand);
}

const APP_HREF = /^\/([^/?#]+)\/app(\/[^?#]*)?([?#].*)?$/;

/**
 * A stored or server-made app link (a notification's `href`, a link a route answered) moved into `handle`'s workspace,
 * the query and hash kept. Any other link, one already inside `w/`, a person page or a missing handle comes back
 * unchanged, so with `MULTI_ORG` off (no handle) nothing changes.
 */
export function inWorkspace(href: string, handle: string | null | undefined): string {
  const m = APP_HREF.exec(href);
  if (!m || !asHandle(handle) || splitWsPath(`/${m[1]}/app${m[2] ?? ""}`)) return href;
  return appHref(m[1], (m[2] ?? "") + (m[3] ?? ""), handle);
}

/**
 * Where the switcher goes after a switch (spec sections 7 "Switching" and 16): the new workspace's link `href` (as the
 * switch route answered it) at the page now on show. Record ids ride in the query (`?conv=`, `?task=`), never in the
 * path, so the query is dropped and a page showing a record falls back to its section; a person page or any path
 * outside `w/{handle}` opens the workspace's home.
 */
export function switchTarget(href: string, pathname: string): string {
  const rest = splitWsPath(pathname)?.rest ?? "";
  // A brand page (`/b/{id}/…`): that brand belongs to the workspace being left, so the new one opens the same section
  // without it, and the `[...legacy]` page sends it to the new workspace's own brand (rule 891).
  const inBrand = /^\/b\/[^/]+(\/.*)?$/.exec(rest);
  if (!inBrand) return href + rest;
  const section = brandSectionOf(inBrand[1] ?? "");
  return href + (section ? `/${section}` : "");
}
