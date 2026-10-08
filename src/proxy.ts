import { NextResponse, type NextRequest } from "next/server";
import { isStaging } from "@/lib/deploy-env";
import { STAGING_COOKIE, STAGING_OPEN_PATHS, hasAccess } from "@/lib/staging-access";

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
  // Root: pick language from cookie, then Accept-Language, default Arabic. `/app` is the installed app's start URL
  // (src/app/manifest.ts, rule 681): the same choice, into the app.
  if (pathname === "/" || pathname === "/app") {
    const url = req.nextUrl.clone();
    url.pathname = pathname === "/" ? `/${pickLang(req)}` : `/${pickLang(req)}/app`;
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
// `/favicon.icox` or `/_next/staticx/a` still meets the lock. Off staging the other paths pass through untouched.
export const config = { matcher: ["/((?!_next/static/|_next/image$|favicon\\.ico$).*)"] };
