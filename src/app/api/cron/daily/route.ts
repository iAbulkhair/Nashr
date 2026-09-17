import { NextResponse } from "next/server";
import { allUsers, runDaily } from "@/lib/schedule";
import { getBrand } from "@/lib/brand";
import { once, sendEmail } from "@/lib/notify";
import { runLifecycle } from "@/lib/lifecycle";
import { db } from "@/lib/db";
import { renewIfDue } from "@/lib/credits";
import { followUps, notifEmailText } from "@/lib/notifications";
import { getUser } from "@/lib/auth";

export const maxDuration = 120;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ ok: false }, { status: 401 });
  let n = 0, emails = 0, nudges = 0, lifecycle = 0, renewed = 0, follow = 0;
  const wa = process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}` : "";
  for (const u of await allUsers()) {
    // Monthly credit renewal for paid plans (no-op after the first brand of a multi-brand account).
    if (await renewIfDue(u.email)) {
      renewed++;
      const fresh = await getUser(u.email);
      if (fresh) u.credits = fresh.credits;
    }
    const brand = await getBrand(u.scope ?? u.email);
    // Signup nudge: registered but never built a brand (Enrich-style founder follow-up)
    if (!brand && Date.now() - new Date(u.createdAt).getTime() > 10 * 60e3 && process.env.RESEND_API_KEY && (await once(u.email, "nudge1"))) {
      const ar = u.lang === "ar";
      const link = `https://nashr-tau.vercel.app/${u.lang}/app/start`;
      const ok = await sendEmail(u.email, ar ? "نور جاهزة — أعطيها رابط موقعك" : "Noor is ready — give her your website", ar
        ? `أهلاً ${u.name} 👋\n\nسجّلت في نشر وما بدأت بعد. نور جاهزة: أعطيها رابط موقعك وتكتب ملف علامتك وخطة 90 يوماً أمامك خلال دقيقة، ثم تقدر تطلب منها منشورات ومقالات ورسائل واتساب بلهجتك.\n\nابدأ من هنا: ${link}\n\nإذا فيه شيء وقّفك، رد على هذا الإيميل${wa ? " أو راسلنا واتساب: " + wa : ""}.\n\n— فريق نشر`
        : `Hi ${u.name} 👋\n\nYou signed up for Nashr but haven't started. Noor is ready: give her your website and she writes your brand file and 90-day plan in about a minute, then you can ask her for posts, articles and WhatsApp messages in your dialect.\n\nStart here: ${link}\n\nIf anything blocked you, reply to this email${wa ? " or WhatsApp us: " + wa : ""}.\n\n— Team Nashr`);
      if (ok) nudges++;
      continue;
    }
    const lc = await runLifecycle(u);
    lifecycle += lc.length;
    const brief = await runDaily(u);
    const fu = await followUps(u, u.scope ?? u.email);
    follow += fu.length;
    const pref = ((await db.get<{ emails?: string }>(`profile:${u.email}`)) ?? {}).emails ?? "all";
    if (brief) {
      n++;
      const worth = pref === "all" || (pref === "important" && (brief.pending > 0 || fu.length > 0));
      const extra = fu.length ? `\n\n${notifEmailText(u, fu)}` : "";
      if (worth && await sendEmail(u.email, u.lang === "ar" ? `ملخص نور — ${brief.date}` : `Noor's brief — ${brief.date}`, brief.text + extra + `\n\nhttps://nashr-tau.vercel.app/${u.lang}/app`)) emails++;
    } else if (fu.length && pref !== "none") {
      if (await sendEmail(u.email, u.lang === "ar" ? "متابعة من فريق نشر" : "Follow-up from your Nashr team", notifEmailText(u, fu))) emails++;
    }
  }
  return NextResponse.json({ ok: true, briefs: n, emails, nudges, lifecycle, renewed, followUps: follow, emailConfigured: !!process.env.RESEND_API_KEY });
}
