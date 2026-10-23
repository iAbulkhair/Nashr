import { NextResponse } from "next/server";
import { normalizeEmail } from "@/lib/auth";
import { globalKey } from "@/lib/keys";
import { mailReady } from "@/lib/notify";
import { mailResetLink } from "@/lib/password-reset";
import { allow, clientIp } from "@/lib/rate";
import { captchaRefusal } from "@/lib/turnstile";

/**
 * POST {email, lang} → always {ok:true} so the form never reveals which emails
 * have accounts. When the login exists (an owner account or a member login) a
 * one-hour, single-use token is stored hashed with the login it belongs to, and
 * the link is emailed (`mailResetLink`, src/lib/password-reset.ts, shared with the
 * signed-in "set a password" card, rule 3101). `mail` tells the UI whether email
 * delivery is configured at all, so it can point to WhatsApp support instead of
 * promising an email that cannot arrive.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { email?: string; lang?: string; turnstile?: unknown };
  const email = normalizeEmail(typeof b.email === "string" ? b.email : "");
  const lang = b.lang === "en" ? "en" : "ar";
  // A key alone is not delivery. With RESEND_API_KEY set but no MAIL_FROM, every reset link was refused by Resend while
  // this told the form to say "a link arrives within minutes" — so the honest fallback below (WhatsApp support and a
  // manual reset) was never shown to anyone. It is shown until a real sender exists.
  const mail = mailReady();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  // The per-IP limit comes first: every token sent costs an outbound siteverify call to Cloudflare (up to 5 s, carrying
  // the site's secret), so a script must not be able to make those calls without limit. Rule 427.
  if (!(await allow(`forgot:ip:${clientIp(req)}`, 8, 900))) return NextResponse.json({ ok: true, mail });
  // Cloudflare Turnstile when both keys are set (src/lib/turnstile.ts), before the per-address limit: a script without a
  // token cannot use up an address's three links per 15 minutes. The answer says nothing about whether the address
  // exists. Rule 427.
  const refused = await captchaRefusal(req, b.turnstile);
  if (refused) return refused;
  if (!(await allow(globalKey.resetLinkBucket(email), 3, 900))) return NextResponse.json({ ok: true, mail });
  if (mail) await mailResetLink(email, lang);
  return NextResponse.json({ ok: true, mail });
}
