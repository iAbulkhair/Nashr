import { NextResponse } from "next/server";
import { createSession, createUser, getUser, normalizeEmail } from "@/lib/auth";

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const email = normalizeEmail(b.email ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  if (!b.password || b.password.length < 8) return NextResponse.json({ ok: false, error: "weak_password" }, { status: 400 });
  if (!b.phone || b.phone.replace(/\D/g, "").length < 9) return NextResponse.json({ ok: false, error: "bad_phone" }, { status: 400 });
  if (await getUser(email)) return NextResponse.json({ ok: false, error: "exists" }, { status: 409 });
  const u = await createUser({ email, name: b.name ?? "", phone: b.phone, password: b.password, lang: b.lang === "en" ? "en" : "ar" });
  await createSession(u.email);
  return NextResponse.json({ ok: true });
}
