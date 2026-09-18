import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { getUser, normalizeEmail } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/notify";
import { allow, clientIp } from "@/lib/rate";

const ORIGIN = () => process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app";

/**
 * POST {email, lang} → always {ok:true} so the form never reveals which emails
 * have accounts. When the account exists a one-hour, single-use token is
 * stored hashed and the link is emailed. `mail` tells the UI whether email
 * delivery is configured at all, so it can point to WhatsApp support instead
 * of promising an email that cannot arrive.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { email?: string; lang?: string };
  const email = normalizeEmail(b.email ?? "");
  const lang = b.lang === "en" ? "en" : "ar";
  const mail = !!process.env.RESEND_API_KEY;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  if (!(await allow(`forgot:ip:${clientIp(req)}`, 8, 900)) || !(await allow(`forgot:em:${email}`, 3, 900))) return NextResponse.json({ ok: true, mail });
  const u = await getUser(email);
  if (u && mail) {
    const token = randomBytes(32).toString("hex");
    await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, { email }, 3600);
    const link = `${ORIGIN()}/${lang}/app/reset?token=${token}`;
    await sendEmail(email, lang === "ar" ? "إعادة تعيين كلمة المرور في نشر" : "Reset your Nashr password", lang === "ar"
      ? `مرحباً،\n\nوصلنا طلب لإعادة تعيين كلمة مرور حسابك في نشر. افتح الرابط التالي خلال ساعة واحدة:\n\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة، ولن يتغير شيء.`
      : `Hello,\n\nWe received a request to reset your Nashr password. Open this link within one hour:\n\n${link}\n\nIf you did not ask for this, ignore this email and nothing changes.`);
  }
  return NextResponse.json({ ok: true, mail });
}
