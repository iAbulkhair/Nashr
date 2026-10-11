import { NextResponse, type NextRequest } from "next/server";
import { crossSiteRefusal } from "@/lib/csrf";
import { isStaging } from "@/lib/deploy-env";
import { STAGING_COOKIE, STAGING_OPEN_PATHS, hasAccess } from "@/lib/staging-access";
import { legacySettingsPath } from "@/lib/settings-nav";

type Lang = "ar" | "en";

const NOINDEX = "noindex, nofollow";
// `/ar/app`, `/en/app/tasks`: the paths whose layout reads the `x-pathname` header.
const APP_PATH = /^\/[^/]+\/app(\/|$)/;

function pickLang(req: NextRequest): Lang {
  const c = req.cookies.get("nashr_lang")?.value;
  if (c === "ar" || c === "en") return c;
  const al = (req.headers.get("accept-language") || "").toLowerCase();
  // Arabic is the default; only send English to browsers that prefer it and do not list Arabic first.
  const first = al.split(",")[0]?.trim() ?? "";
  if (first.startsWith("en") && !al.startsWith("ar")) return "en";
  return "ar";
}

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const staging = isStaging();

  // Staging lock (rules 674, 677): without the access cookie every path but the four open ones is a bare 404, and
  // with no STAGING_ACCESS_KEY nobody gets in. The proxy sees every path, so this runs before anything else.
  if (staging && !STAGING_OPEN_PATHS.has(pathname) && !hasAccess(req.cookies.get(STAGING_COOKIE)?.value)) {
    return new NextResponse(null, { status: 404, headers: { "x-robots-tag": NOINDEX } });
  }

  let res: NextResponse;
  if (pathname.startsWith("/api/")) {
    // API routes: refuse a state-changing request another site started (src/lib/csrf.ts, rules 690-693), else pass it
    // on untouched. The exempt paths (webhooks, crons, MCP, OAuth token) pass inside crossSiteRefusal. The language and
    // x-pathname logic below is for pages only.
    res = crossSiteRefusal(req) ?? NextResponse.next();
  } else if (pathname === "/" || pathname === "/app") {
    // Root: pick language from cookie, then Accept-Language, default Arabic. `/app` is the installed app's start URL
    // (src/app/manifest.ts, rule 681): the same choice, into the app.
    const url = req.nextUrl.clone();
    url.pathname = pathname === "/" ? `/${pickLang(req)}` : `/${pickLang(req)}/app`;
    url.search = search;
    res = NextResponse.redirect(url, 307);
  } else if (legacySettingsPath(pathname)) {
    // The old account, team, brand and billing pages moved under /app/settings (rule 1141, expand step): a 307 keeps the
    // query string (a Paymob return, an integration error) and lets a rollback find the old pages again.
    const url = req.nextUrl.clone();
    url.pathname = legacySettingsPath(pathname)!;
    url.search = search;
    res = NextResponse.redirect(url, 307);
  } else if (APP_PATH.test(pathname)) {
    // App routes: forward the pathname to server components.
    const reqHeaders = new Headers(req.headers);
    reqHeaders.set("x-pathname", pathname);
    res = NextResponse.next({ request: { headers: reqHeaders } });
  } else {
    res = NextResponse.next();
  }

  if (staging) res.headers.set("x-robots-tag", NOINDEX);
  return res;
}

// Every path except Next's static assets and the favicon: the staging lock must see them all (`/` and `/app` included).
// The exclusions are anchored (`_next/static/`, `_next/image` and `favicon.ico` end the path), so a look-alike such as
// `/favicon.icox` or `/_next/staticx/a` still meets the lock. Off staging the other paths pass through untouched, but
// for the cross-site check on /api. Next buffers the body of every request the proxy sees, up to
// `experimental.proxyClientMaxBodySize` (6 MB, next.config.ts, rule 774), the webhook and cron routes included: their
// 64 KB caps still refuse a larger body, after Next has read it (src/lib/csrf.ts, the CROSS_SITE_EXEMPT comment).
export const config = { matcher: ["/((?!_next/static/|_next/image$|favicon\\.ico$).*)"] };
