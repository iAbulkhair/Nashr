import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  if (!b.email || !b.name) return NextResponse.json({ ok: false }, { status: 400 });
  const rec = { name: b.name.slice(0, 80), email: b.email.slice(0, 120), phone: (b.phone ?? "").slice(0, 30), channel: (b.channel ?? "").slice(0, 200), audience: (b.audience ?? "").slice(0, 100), lang: b.lang === "en" ? "en" : "ar", at: new Date().toISOString() };
  await db.lpush("affiliate-applications", JSON.stringify(rec));
  return NextResponse.json({ ok: true });
}
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = await db.lrange("affiliate-applications", 0, 499);
  return NextResponse.json({ ok: true, applications: rows.map((r) => JSON.parse(r)) });
}
