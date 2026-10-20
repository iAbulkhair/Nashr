import { BRAND_HEADER, brandFromPath, isBrandId } from "./brand-path";

/**
 * The browser's half of the brand in the link (rule 889, brand id in the URL "Part C"). A same-origin request to `/api/`
 * from a page at `/{lang}/app/b/{id}/…` (or `/{lang}/app/w/{handle}/b/{id}/…` once draft #418 lands) carries that page's
 * brand in `x-thakeen-brand`, so each tab writes into its own brand and a state-changing request is never answered by the
 * brand guard (rule 888). The server treats the value as a selector among the caller's own brands only.
 *
 * The app's screens call `fetch("/api/…")` directly (about 120 calls), so the header is added by wrapping `window.fetch`
 * once, from the shell's provider (src/components/app/WorkspaceContext.tsx), the same shape as #418's
 * `installWorkspaceFetch`. The two wrappers stack and each adds its own header. Navigations (a link, a download, a
 * redirect to a connector) cannot send a header: `apiHref` puts the brand in the query and the proxy copies it into the
 * header on GET and HEAD (R-C13).
 *
 * The brand is read from `window.location` when the request is SENT, not when the work that sends it was scheduled: a
 * timer, a retry or a promise chain that outlives a soft navigation to another brand's page sends the new page's brand.
 * A screen whose late request must stay with the brand it started on sets the header itself (the wrapper keeps it).
 */

/** The brand a request to `input` should carry from a page at `pagePath`, or null (another site, not `/api/`, no brand). */
export function brandHeaderFor(input: RequestInfo | URL, pagePath: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) return null;
  return brandFromPath(pagePath);
}

/**
 * `init` with the brand header added, unless the caller set one already (on `init` or on a `Request`). An empty value is
 * no header (fix round item 11: empty counts as absent in the proxy, the guard and `currentUser` too), so it is replaced.
 */
function withBrandHeader(input: RequestInfo | URL, init: RequestInit | undefined, brand: string): RequestInit {
  const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
  if (!headers.get(BRAND_HEADER)) headers.set(BRAND_HEADER, brand);
  return { ...init, headers };
}

/**
 * The mark on our wrapper and on the window it wrapped. `Symbol.for`, not a module flag: a second copy of this module (a
 * hot reload) sees the same symbol, so it neither wraps our wrapper again nor wraps a wrapper that another one (#418's
 * `installWorkspaceFetch`) put around ours.
 */
const WRAPPED = Symbol.for("thakeen.brandFetch");
type Marked = { [WRAPPED]?: true };

/** Wrap `window.fetch` once so app requests name their page's brand. Idempotent; a no-op on the server. Always on (not behind `MULTI_ORG`). */
export function installBrandFetch(): void {
  if (typeof window === "undefined") return;
  const win = window as typeof window & Marked;
  if (win[WRAPPED] || (win.fetch as typeof fetch & Marked)[WRAPPED]) return;
  const real = win.fetch.bind(win);
  const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
    const brand = brandHeaderFor(input, win.location.pathname, win.location.origin);
    return brand ? real(input, withBrandHeader(input, init, brand)) : real(input, init);
  };
  (wrapped as typeof wrapped & Marked)[WRAPPED] = true;
  win.fetch = wrapped as typeof fetch;
  win[WRAPPED] = true;
}

/**
 * `path` (an `/api/…` path, with or without a query and a hash) with `brand={id}` added, for a navigation to a brand GET
 * route that cannot carry the header (R-C13). Unchanged when `brand` is not a brand id or the path names a brand already.
 * Pure, so a server page (the series export on the to-do page) builds the same link from its route's `brand` param.
 */
export function withBrandQuery(path: string, brand: string | null | undefined): string {
  if (!isBrandId(brand)) return path;
  const [, base = path, tail = ""] = /^([^#]*)(#[\s\S]*)?$/.exec(path) ?? [];
  const q = base.indexOf("?");
  if (q !== -1 && new URLSearchParams(base.slice(q + 1)).has("brand")) return path;
  return `${base}${q === -1 ? "?" : "&"}brand=${brand}${tail}`;
}

/**
 * A link to an `/api/…` GET route of the page's brand: the browser path names the brand, the query carries it. On a page
 * that is not under `/b/{id}` (an account page) or on the server, the path is unchanged. Account routes
 * (`/api/account/export`, `/api/auth/google/start`) never go through here.
 */
export function apiHref(path: string): string {
  return withBrandQuery(path, typeof location === "undefined" ? null : brandFromPath(location.pathname));
}

/**
 * R-C12: a shell component that is shown on account pages (the rail's new conversation, the account settings save) and
 * writes to a brand route names the session's brand itself, since the page has none for the wrapper to read. On a `/b/{id}`
 * page it adds nothing: the wrapper sends the page's brand, which is the one that must win. Spread into `headers`.
 */
export function sessionBrandHeaders(sessionBrand: string | null | undefined): Record<string, string> {
  if (!isBrandId(sessionBrand)) return {};
  if (typeof location !== "undefined" && brandFromPath(location.pathname)) return {};
  return { [BRAND_HEADER]: sessionBrand };
}
