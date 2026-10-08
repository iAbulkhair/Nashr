import { NextResponse, type NextRequest } from "next/server";
import { crossSiteRefusal } from "@/lib/csrf";

type Lang = "ar" | "en";

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
  // API routes: refuse a state-changing request another site started (src/lib/csrf.ts, rules 690-693), else pass it on
  // untouched. The language and x-pathname logic below is for pages only.
  if (pathname.startsWith("/api/")) return crossSiteRefusal(req) ?? NextResponse.next();

  // Root: pick language from cookie, then Accept-Language, default Arabic.
  if (pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = `/${pickLang(req)}`;
    url.search = search;
    return NextResponse.redirect(url, 307);
  }

  // App routes: forward the pathname to server components.
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers: reqHeaders } });
}

// The /api entry is every API path except the ones in CROSS_SITE_EXEMPT (src/lib/csrf.ts), where the check passes
// anyway: Next buffers the body of each request the proxy sees and waits for the whole upload, which would undo the
// webhook and cron routes' 64 KB caps. An exact entry is written `name/*$`; a prefix needs a character after its slash,
// as isCrossSiteExempt reads it. Next needs a literal here, so the list is repeated; tests/csrf.test.ts pins the two.
export const config = { matcher: ["/", "/:lang/app/:path*", "/api/((?!mcp/*$|oauth/token/*$|oauth/register/*$|media/hook/[^/]|secretary/booking/[^/]|billing/paymob/[^/]|cron/[^/]).*)"] };
