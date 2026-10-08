import { NextResponse } from "next/server";
import { sessionCookie } from "@/lib/auth";
import { isStaging } from "@/lib/deploy-env";
import { appOrigin } from "@/lib/origin";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { sameSecret } from "@/lib/secret";
import { STAGING_COOKIE, accessToken } from "@/lib/staging-access";

/**
 * POST /api/staging-access (rule 675): the staging site's door. A form posts `code` (and `lang`); the right code is
 * answered with the access cookie the proxy checks (`hasAccess`, rule 674) and a 303 to the site, anything else with a
 * 303 back to the page with `?e=1` and no cookie. Off staging the route does not exist (404).
 *
 * Public by design: it is open on staging because nobody holds the cookie yet. So it is rate-limited per IP (5 tries
 * per 15 minutes, counted before the code is read, so the sixth is refused even with the right one), compares with
 * `sameSecret`, and reads the code only from the form body: never the URL, which lands in logs and history. The cookie
 * holds the HMAC token, never the code, and nothing here writes the code anywhere.
 *
 * Redirects go to `appOrigin()`, never `req.url`: behind the Hostinger proxy the request URL can be the internal host.
 */
export async function POST(req: Request) {
  if (!isStaging()) return new NextResponse(null, { status: 404 });
  if (!(await allow("stagingaccess:" + clientIp(req), 5, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);

  const form = await req.formData().catch(() => null);
  const code = form?.get("code");
  const lang = form?.get("lang") === "en" ? "en" : "ar";
  const key = process.env.STAGING_ACCESS_KEY;
  const token = accessToken(key);

  // No key set (or an empty one) is no way in: `token` is null and every code is wrong.
  if (token === null || typeof code !== "string" || !sameSecret(code, key)) {
    return NextResponse.redirect(`${appOrigin()}/${lang}/staging-access?e=1`, 303);
  }
  const res = NextResponse.redirect(`${appOrigin()}/${lang}`, 303);
  res.cookies.set(STAGING_COOKIE, token, await sessionCookie(60 * 60 * 24 * 30));
  return res;
}
