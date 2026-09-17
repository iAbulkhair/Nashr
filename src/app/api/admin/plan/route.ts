import { NextResponse } from "next/server";
import { PLAN_CREDITS, getUser, isAdmin, saveUser, type Plan } from "@/lib/auth";
import { db } from "@/lib/db";

// GET  /api/admin/plan?key=...            → list users
// POST /api/admin/plan?key=... {email, plan?, addCredits?} → set plan / add credits
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const emails = await db.smembers("users:all");
  const users = [];
  for (const e of emails) {
    const u = await getUser(e);
    if (u) users.push({ email: u.email, name: u.name, phone: u.phone, plan: u.plan, credits: u.credits, trialEnds: u.trialEnds, createdAt: u.createdAt });
  }
  users.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return NextResponse.json({ ok: true, count: users.length, users });
}

export async function POST(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { email?: string; plan?: Plan; addCredits?: number };
  const u = b.email ? await getUser(b.email) : null;
  if (!u) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (b.plan && b.plan in PLAN_CREDITS) {
    u.plan = b.plan;
    u.credits = Math.max(u.credits, 0) + PLAN_CREDITS[b.plan];
  }
  if (typeof b.addCredits === "number") u.credits += Math.trunc(b.addCredits);
  await saveUser(u);
  return NextResponse.json({ ok: true, user: { email: u.email, plan: u.plan, credits: u.credits } });
}
