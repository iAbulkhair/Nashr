import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { allow, clientIp } from "@/lib/rate";
import { cookieRef, partnerByCode, partnerCookie } from "@/lib/partners";
import { PARTNER_COOKIE, codeProblem, normalizeCode, partnerCookieValue } from "@/lib/partner-rules";

export const dynamic = "force-dynamic";

/** The visitor's language: `?lang=`, then the site's language cookie, then Accept-Language (src/proxy.ts), Arabic by default. */
function langOf(req: Request): "ar" | "en" {
  const q = new URL(req.url).searchParams.get("lang");
  if (q === "ar" || q === "en") return q;
  const c = /(?:^|;\s*)nashr_lang=(ar|en)(?:;|$)/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (c === "ar" || c === "en") return c;
  const al = (req.headers.get("accept-language") ?? "").toLowerCase();
  return al.split(",")[0]?.trim().startsWith("en") && !al.startsWith("ar") ? "en" : "ar";
}

/**
 * GET /p/{CODE}: a partner's link (rule 391). Public and throttled per IP. A partner's code sets the first-party httpOnly
 * cookie `nashr_partner` for 30 days, `CODE.<click time>` so the 30-day attribution window runs from this click, unless
 * the visitor already carries a partner's valid code (first touch: that cookie, and its click time, stay),
 * then sends the visitor to the localized signup with the code that will count filled in. An unknown code, or a visitor
 * over the limit, is sent to signup with nothing set. Separate from the credits referral (`/app/signup?ref=`), which this
 * never reads or writes.
 */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code: raw } = await ctx.params;
  const dest = new URL(`/${langOf(req)}/app/signup`, req.url);
  let code = "";
  try { code = normalizeCode(decodeURIComponent(raw)); } catch { code = ""; }
  if (!codeProblem(code) && (await allow(`plink:ip:${clientIp(req)}`, 60, 3600))) {
    const partner = await partnerByCode(code);
    if (partner) {
      const held = (await cookieRef())?.code ?? "";
      // A valid cookie is kept, the same partner's included: clicking the link again never restarts the 30 days.
      const keep = held && (held === code || (await partnerByCode(held))) ? held : "";
      if (!keep) (await cookies()).set(PARTNER_COOKIE, partnerCookieValue(code, Date.now()), await partnerCookie());
      dest.searchParams.set("partner", keep || code);
    }
  }
  return NextResponse.redirect(dest, 307);
}
