import { NextResponse, type NextRequest } from "next/server";
import { crossSiteRefusal } from "@/lib/csrf";
import { isStaging } from "@/lib/deploy-env";
import { STAGING_COOKIE, hasAccess, stagingOpen } from "@/lib/staging-access";
import { legacySettingsPath } from "@/lib/settings-nav";
import { LANG_COOKIE, readCookie } from "@/lib/cookie-names";
import { REQUEST_ID_HEADER, requestId } from "@/lib/request-id";
import { NONCE_HEADER, cspNonce, pageCsp, pagePath, reportOnlyCsp } from "@/lib/csp";

type Lang = "ar" | "en";

const NOINDEX = "noindex, nofollow";
// `/ar/app`, `/en/app/tasks`: the paths whose layout reads the `x-pathname` header.
const APP_PATH = /^\/[^/]+\/app(\/|$)/;
// The founder console's pages and the staff routes (rule 1653): never indexed and never stored by a browser or a cache,
// so a sign-in step, a setup code or a recovery code is never kept on disk or behind a back button.
const CONSOLE_PATH = /^\/(ar|en)\/admin(\/|$)|^\/api\/admin\/staff(\/|$)/;

// English locales of the Gulf (rule 1873): a browser set to en-SA or en-AE is a Gulf reader on an English system, and
// the site is Arabic first, so these pick Arabic. A cookie the visitor chose still wins over any header.
const GULF_ENGLISH = new Set(["en-sa", "en-ae", "en-kw", "en-qa", "en-bh", "en-om"]);

/** The visitor's language: their cookie, else the first Accept-Language entry, else Arabic. */
export function pickLang(req: Pick<NextRequest, "cookies" | "headers">): Lang {
  const c = readCookie(req.cookies, LANG_COOKIE);
  if (c === "ar" || c === "en") return c;
  const al = (req.headers.get("accept-language") || "").toLowerCase();
  // Arabic is the default; only send English to browsers that prefer it and do not list Arabic first.
  const first = al.split(",")[0]?.split(";")[0]?.trim() ?? "";
  if (GULF_ENGLISH.has(first)) return "ar";
  if (first.startsWith("en") && !al.startsWith("ar")) return "en";
  return "ar";
}

/**
 * The public pages' first path segments under `src/app/[lang]` (rule 1874). An address without the language, such as
 * `/pricing` or `/for/clinics`, is sent to `/{lang}` plus the same path and query. Only these segments move: `/api`,
 * `/m`, `/p`, `/oauth`, `/llms.txt`, `/robots.txt`, `/sitemap.xml`, the manifest, the icons, `/_next` and `/.well-known`
 * are never redirected, and the app and the console keep their own paths. tests/global-nav.test.ts holds this list to
 * the folders on disk.
 */
export const PUBLIC_SEGMENTS = [
  "affiliates", "agents", "ai-marketing-agent", "blog", "compare", "customers", "enterprise", "for", "help", "pricing",
  "privacy", "resources", "terms", "tools", "updates",
] as const;
const UNPREFIXED = new RegExp(`^/(?:${PUBLIC_SEGMENTS.join("|")})(?:/|$)`);
/** True for a public page's address written without its language. */
export const unprefixedPublic = (pathname: string): boolean => UNPREFIXED.test(pathname);

/**
 * The first path segments that live outside `src/app/[lang]`: the folders beside it (`api`, `m`, `p`, `oauth`, `fonts`)
 * and under `public` (`icons`). tests/global-nav.test.ts holds this list to the folders on disk.
 */
export const ROOT_SEGMENTS = ["api", "fonts", "icons", "m", "oauth", "p"] as const;
const ROOT_ROUTE = new RegExp(`^/(?:ar|en|${ROOT_SEGMENTS.join("|")})(?:/|$)`);
/**
 * True for an address outside the language tree that no route serves (rule 1891): `/xyz`, `/ar-sa/pricing`, `/admin`.
 * `[lang]` takes any first segment, so `/xyz` reached `[lang]/layout.tsx` with `lang = "xyz"`, whose `notFound()` has no
 * root `not-found` above it and showed the framework's untitled English page; `global-not-found.tsx` never ran, because
 * the address did match a route. A segment with a dot (`/robots.txt`, `/favicon.ico`, `/manifest.webmanifest`) or a
 * leading `_` or `.` (`/_next`, `/.well-known`) is a file or a framework path and is left alone. So is a file under
 * `/-/`: Next serves a metadata file of the `[lang]` segment from that placeholder, and every page's share image is
 * `/-/opengraph-image.png` (rule 1891a).
 */
export const strayPath = (pathname: string): boolean =>
  pathname !== "/" && !ROOT_ROUTE.test(pathname) && !/^\/(?:[_.]|[^/]*\.|-\/[^/]*\.)/.test(pathname);
/** The segment a stray path is served from: no folder under `[lang]` claims it, so `[lang]/[...rest]` answers 404. */
export const STRAY_TARGET = "__missing";

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const staging = isStaging();
  // Request id (rule 1975): kept from an upstream hop when it is well formed, else a fresh one. It goes to the route on the
  // request (`withRequest` in src/lib/log.ts reads it) and back to the browser on the response, so a support message
  // that quotes it finds the matching log lines. Never a secret, never derived from the request's content.
  const rid = requestId(req.headers) ?? crypto.randomUUID();
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set(REQUEST_ID_HEADER, rid);
  // Content-Security-Policy (rules 2320-2329): a fresh nonce for every page request, on the request (Next reads the policy
  // there and puts the nonce on its scripts; the layout reads NONCE_HEADER for the theme script) and on the response. A
  // nonce sent by the browser is never kept: both headers are always overwritten here.
  const nonce = pagePath(pathname) ? cspNonce() : null;
  const dev = process.env.NODE_ENV === "development";
  if (nonce) {
    reqHeaders.set(NONCE_HEADER, nonce);
    reqHeaders.set("content-security-policy", pageCsp(nonce, dev));
  } else {
    reqHeaders.delete(NONCE_HEADER);
    reqHeaders.delete("content-security-policy");
  }
  const next = () => NextResponse.next({ request: { headers: reqHeaders } });

  // Staging lock (rules 674, 677): without the access cookie every path but the four open ones and `/m/` (rule 1760) is
  // a bare 404, and with no STAGING_ACCESS_KEY nobody gets in. The proxy sees every path, so this runs before anything else.
  if (staging && !stagingOpen(pathname) && !hasAccess(req.cookies.get(STAGING_COOKIE)?.value)) {
    return new NextResponse(null, { status: 404, headers: { "x-robots-tag": NOINDEX, [REQUEST_ID_HEADER]: rid } });
  }

  let res: NextResponse;
  if (pathname.startsWith("/api/")) {
    // API routes: refuse a state-changing request another site started (src/lib/csrf.ts, rules 690-693), else pass it
    // on untouched. The exempt paths (webhooks, crons, MCP, OAuth token) pass inside crossSiteRefusal. The language and
    // x-pathname logic below is for pages only.
    res = crossSiteRefusal(req) ?? next();
  } else if (pathname === "/" || pathname === "/app") {
    // Root: pick language from cookie, then Accept-Language, default Arabic. `/app` is the installed app's start URL
    // (src/app/manifest.ts, rule 681): the same choice, into the app.
    const url = req.nextUrl.clone();
    url.pathname = pathname === "/" ? `/${pickLang(req)}` : `/${pickLang(req)}/app`;
    url.search = search;
    res = NextResponse.redirect(url, 307);
  } else if (unprefixedPublic(pathname)) {
    // `/pricing`, `/agents/noor`, `/for/clinics` (rule 1874): the same choice as the root, then the same path and query.
    // A 307 like the root's, never a permanent redirect: the target depends on the visitor's cookie and browser language.
    const url = req.nextUrl.clone();
    url.pathname = `/${pickLang(req)}${pathname}`;
    url.search = search;
    res = NextResponse.redirect(url, 307);
    res.headers.set("Vary", "Cookie, Accept-Language");
  } else if (strayPath(pathname)) {
    // `/xyz`, `/admin`, `/xyz/app` (rule 1891): served, without moving the address bar, by the page at `/{lang}/__missing`, which
    // no folder under `[lang]` claims, so the catch-all answers 404 with the branded page inside the visitor's language
    // and navigation. A rewrite, never a redirect: the visitor keeps the address they typed and can see the mistake.
    const url = req.nextUrl.clone();
    url.pathname = `/${pickLang(req)}/${STRAY_TARGET}`;
    url.search = "";
    // The request's headers go along (rule 2321): the nonce and the request id must reach the page it is served from.
    res = NextResponse.rewrite(url, { request: { headers: reqHeaders } });
    res.headers.set("Vary", "Cookie, Accept-Language");
  } else if (legacySettingsPath(pathname)) {
    // The old account, team, brand and billing pages moved under /app/settings (rule 1141, expand step): a 307 keeps the
    // query string (a Paymob return, an integration error) and lets a rollback find the old pages again.
    const url = req.nextUrl.clone();
    url.pathname = legacySettingsPath(pathname)!;
    url.search = search;
    res = NextResponse.redirect(url, 307);
  } else if (APP_PATH.test(pathname)) {
    // App routes: forward the pathname to server components.
    reqHeaders.set("x-pathname", pathname);
    res = next();
  } else {
    res = next();
  }

  res.headers.set(REQUEST_ID_HEADER, rid);
  if (nonce) {
    res.headers.set("Content-Security-Policy", pageCsp(nonce, dev));
    res.headers.set("Content-Security-Policy-Report-Only", reportOnlyCsp(nonce, dev));
  }

  if (staging || CONSOLE_PATH.test(pathname)) res.headers.set("x-robots-tag", NOINDEX);
  if (CONSOLE_PATH.test(pathname)) res.headers.set("Cache-Control", "no-store");
  return res;
}

// Every path except Next's static assets and the favicon: the staging lock must see them all (`/` and `/app` included).
// The exclusions are anchored (`_next/static/`, `_next/image` and `favicon.ico` end the path), so a look-alike such as
// `/favicon.icox` or `/_next/staticx/a` still meets the lock. Off staging the other paths pass through untouched, but
// for the cross-site check on /api. Next buffers the body of every request the proxy sees, up to
// `experimental.proxyClientMaxBodySize` (6 MB, next.config.ts, rule 774), the webhook and cron routes included: their
// 64 KB caps still refuse a larger body, after Next has read it (src/lib/csrf.ts, the CROSS_SITE_EXEMPT comment).
export const config = { matcher: ["/((?!_next/static/|_next/image$|favicon\\.ico$).*)"] };
