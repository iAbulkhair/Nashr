import { NextResponse, type NextRequest } from "next/server";

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

export const config = { matcher: ["/", "/:lang/app/:path*"] };
