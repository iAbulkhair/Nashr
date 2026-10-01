import { NextResponse } from "next/server";
import { CAPS, db, pushCapped } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { allow, clientIp } from "@/lib/rate";
import { APPLICATIONS, newId } from "@/lib/partners";

export async function POST(req: Request) {
  // Public, unauthenticated write: throttled per IP.
  if (!(await allow(`affiliates:ip:${clientIp(req)}`, 10, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  if (!b.email || !b.name) return NextResponse.json({ ok: false }, { status: 400 });
  // An id, so the founder console can approve or reject this application (src/lib/partners.ts).
  const rec = { id: newId("app"), name: b.name.slice(0, 80), email: b.email.slice(0, 120), phone: (b.phone ?? "").slice(0, 30), channel: (b.channel ?? "").slice(0, 200), audience: (b.audience ?? "").slice(0, 100), lang: b.lang === "en" ? "en" : "ar", at: new Date().toISOString() };
  await pushCapped(APPLICATIONS, JSON.stringify(rec), CAPS.tickets);
  return NextResponse.json({ ok: true });
}
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = await db.lrange(APPLICATIONS, 0, 499);
  return NextResponse.json({ ok: true, applications: rows.map((r) => JSON.parse(r)) });
}
