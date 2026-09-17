import { NextResponse } from "next/server";

export async function POST(req: Request) {
  let body: { email?: string; company?: string; industry?: string; lang?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const email = (body.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  }

  const record = {
    email,
    company: (body.company ?? "").trim().slice(0, 200),
    industry: (body.industry ?? "").trim().slice(0, 60),
    lang: body.lang === "en" ? "en" : "ar",
    at: new Date().toISOString(),
  };

  const key = process.env.RESEND_API_KEY;
  const to = process.env.WAITLIST_TO;
  if (key && to) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(key);
      await resend.emails.send({
        from: process.env.WAITLIST_FROM ?? "Nashr <onboarding@resend.dev>",
        to,
        subject: `Nashr waitlist: ${record.email}`,
        text: JSON.stringify(record, null, 2),
      });
    } catch (e) {
      console.error("waitlist email failed", e);
      return NextResponse.json({ ok: false, error: "send_failed" }, { status: 502 });
    }
  } else {
    // No email provider configured yet: keep the signup visible in Vercel logs.
    console.log("WAITLIST", JSON.stringify(record));
  }

  return NextResponse.json({ ok: true });
}
