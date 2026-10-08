import { NextResponse } from "next/server";
import { CAPS, db, pushCapped } from "@/lib/db";
import { currentUser, isAdmin } from "@/lib/auth";
import { sendEmail } from "@/lib/notify";
import { allow, clientIp, retryLater } from "@/lib/rate";

export async function POST(req: Request) {
  // Public and unauthenticated, and every accepted ticket sends an email to the founder: throttled per IP.
  if (!(await allow(`support:ip:${clientIp(req)}`, 10, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  if (!b.email || !b.message) return NextResponse.json({ ok: false }, { status: 400 });
  const u = await currentUser();
  // `user` is the login that wrote the ticket (a member's own address for a member); `account` is whose workspace it is.
  const rec = { email: b.email.slice(0, 120), user: u ? (u.actor?.email ?? u.email) : null, account: u?.email ?? null, type: (b.type ?? "question").slice(0, 20), message: b.message.slice(0, 4000), page: (b.page ?? "").slice(0, 200), lang: b.lang === "en" ? "en" : "ar", at: new Date().toISOString(), status: "open" };
  await pushCapped("support-tickets", JSON.stringify(rec), CAPS.tickets);
  if (process.env.WAITLIST_TO) await sendEmail(process.env.WAITLIST_TO, `Thakeen support [${rec.type}] ${rec.email}`, JSON.stringify(rec, null, 2));
  return NextResponse.json({ ok: true });
}
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = await db.lrange("support-tickets", 0, 499);
  return NextResponse.json({ ok: true, tickets: rows.map((r) => JSON.parse(r)) });
}
