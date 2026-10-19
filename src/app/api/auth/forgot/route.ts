import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { resetPassword } from "@/emails";
import { getLogin, normalizeEmail } from "@/lib/auth";
import { db } from "@/lib/db";
import { mailReady, sendEmail } from "@/lib/notify";
import { appOrigin } from "@/lib/origin";
import { allow, clientIp } from "@/lib/rate";
import { captchaRefusal } from "@/lib/turnstile";

/** What a reset token resets: the login it was issued for (read back in ../reset/route.ts). */
type ResetRecord = { email: string; kind: "owner" | "member" };

/**
 * POST {email, lang} → always {ok:true} so the form never reveals which emails
 * have accounts. When the login exists (an owner account or a member login) a
 * one-hour, single-use token is stored hashed with the login it belongs to, and
 * the link is emailed. `mail` tells the UI whether email delivery is configured
 * at all, so it can point to WhatsApp support instead of promising an email that
 * cannot arrive.
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
  if (!(await allow(`forgot:em:${email}`, 3, 900))) return NextResponse.json({ ok: true, mail });
  const login = await getLogin(email);
  // A member whose account is gone has nothing to sign in to: no link, and the same answer as an unknown address. The
  // address is the login's own (the legacy record's, else the person's: multi-workspace M1).
  const target: ResetRecord | null = !login ? null : login.kind === "owner" ? { email: login.user.email, kind: "owner" } : login.owner ? { email: login.member?.email ?? login.person.email, kind: "member" } : null;
  if (target && mail) {
    const token = randomBytes(32).toString("hex");
    await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, target, 3600);
    // The token rides in the URL fragment (#t=), never a query string: browsers never send a fragment to a server, so it
    // stays out of server, proxy and edge logs and the Referer header (src/components/app/AuthForm.tsx ResetForm). Rule 546.
    const link = `${appOrigin()}/${lang}/app/reset#t=${token}`;
    // The text part stays as it was; the HTML part (src/emails/reset-password.ts) says the same in the shared layout.
    await sendEmail(target.email, lang === "ar" ? "إعادة تعيين كلمة المرور في ذكين" : "Reset your Thakeen password", lang === "ar"
      ? `مرحباً،\n\nوصلنا طلب لإعادة تعيين كلمة مرور حسابك في ذكين. افتح الرابط التالي خلال ساعة واحدة:\n\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة، ولن يتغير شيء.`
      : `Hello,\n\nWe received a request to reset your Thakeen password. Open this link within one hour:\n\n${link}\n\nIf you did not ask for this, ignore this email and nothing changes.`, resetPassword({ lang, link }));
  }
  return NextResponse.json({ ok: true, mail });
}
