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
 * The cookie's `Secure` flag follows `appOrigin()` for the same reason (see the cookie below).
 *
 * The per-IP bucket assumes `clientIp(req)` sees the real client. If the host forwarded no address header at all, every
 * caller would share one "unknown" bucket and five tries from anyone would lock the team out for 15 minutes. That is a
 * fact about Hostinger's proxy that no code here can settle, so it is checked on staging (docs/system/flows.md, section
 * 49, item 7) and pinned for the cases the proxy can differ in (tests/staging.test.ts).
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
  // `sessionCookie` decides `Secure` from the forwarded Host and x-forwarded-proto, and a proxy may forward a loopback
  // Host without the proto header, which reads as plain http to localhost and drops the flag. The browser is sent to
  // `appOrigin()` (above), so an https origin means the cookie is Secure whatever the proxy forwarded. Over an http
  // origin (local development) the helper's own rule stays: Secure except plain http to loopback.
  const opts = await sessionCookie(60 * 60 * 24 * 30);
  res.cookies.set(STAGING_COOKIE, token, { ...opts, secure: opts.secure || appOrigin().startsWith("https://") });
  return res;
}
