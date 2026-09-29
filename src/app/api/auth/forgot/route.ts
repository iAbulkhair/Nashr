import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { getLogin, normalizeEmail } from "@/lib/auth";
import { db } from "@/lib/db";
import { mailReady, sendEmail } from "@/lib/notify";
import { ORIGIN } from "@/lib/oauth";
import { allow, clientIp } from "@/lib/rate";

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
  const b = (await req.json().catch(() => ({}))) as { email?: string; lang?: string };
  const email = normalizeEmail(typeof b.email === "string" ? b.email : "");
  const lang = b.lang === "en" ? "en" : "ar";
  // A key alone is not delivery. With RESEND_API_KEY set but no MAIL_FROM, every reset link was refused by Resend while
  // this told the form to say "a link arrives within minutes" — so the honest fallback below (WhatsApp support and a
  // manual reset) was never shown to anyone. It is shown until a real sender exists.
  const mail = mailReady();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  if (!(await allow(`forgot:ip:${clientIp(req)}`, 8, 900)) || !(await allow(`forgot:em:${email}`, 3, 900))) return NextResponse.json({ ok: true, mail });
  const login = await getLogin(email);
  // A member whose account is gone has nothing to sign in to: no link, and the same answer as an unknown address.
  const target: ResetRecord | null = !login ? null : login.kind === "owner" ? { email: login.user.email, kind: "owner" } : login.owner ? { email: login.member.email, kind: "member" } : null;
  if (target && mail) {
    const token = randomBytes(32).toString("hex");
    await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, target, 3600);
    const link = `${ORIGIN()}/${lang}/app/reset?token=${token}`;
    await sendEmail(target.email, lang === "ar" ? "إعادة تعيين كلمة المرور في نشر" : "Reset your Nashr password", lang === "ar"
      ? `مرحباً،\n\nوصلنا طلب لإعادة تعيين كلمة مرور حسابك في نشر. افتح الرابط التالي خلال ساعة واحدة:\n\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة، ولن يتغير شيء.`
      : `Hello,\n\nWe received a request to reset your Nashr password. Open this link within one hour:\n\n${link}\n\nIf you did not ask for this, ignore this email and nothing changes.`);
  }
  return NextResponse.json({ ok: true, mail });
}
