import { NextResponse } from "next/server";
import { PLAN_CREDITS, getUser, isAdmin, saveUser, type Plan } from "@/lib/auth";
import { db } from "@/lib/db";
import { monthKey, withUserLock } from "@/lib/credits";
import { getUsage } from "@/lib/usage";

// GET  /api/admin/plan            → list users with this month's model usage
// POST /api/admin/plan {email, plan?, addCredits?} → set plan (resets to plan allowance, starts renewal cycle) / add credits
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const emails = await db.smembers("users:all");
  const users = [];
  for (const e of emails) {
    const u = await getUser(e);
    if (!u) continue;
    const usage = await getUsage(u.email);
    users.push({ email: u.email, name: u.name, phone: u.phone, plan: u.plan, credits: u.credits, trialEnds: u.trialEnds, createdAt: u.createdAt, renewedAt: u.renewedAt ?? null, tokens: usage.in + usage.out, usd: usage.usd, calls: usage.calls });
  }
  users.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const total = await getUsage("_all");
  return NextResponse.json({ ok: true, count: users.length, users, total });
}

export async function POST(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { email?: string; plan?: Plan; addCredits?: number };
  if (!b.email || !(await getUser(b.email))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const user = await withUserLock(b.email, async (u) => {
    if (b.plan && b.plan in PLAN_CREDITS) {
      u.plan = b.plan;
      u.credits = PLAN_CREDITS[b.plan];
      u.renewedAt = monthKey();
    }
    if (typeof b.addCredits === "number") u.credits = Math.max(0, u.credits + Math.trunc(b.addCredits));
    await saveUser(u);
    return u;
  });
  return NextResponse.json({ ok: true, user: { email: user.email, plan: user.plan, credits: user.credits, renewedAt: user.renewedAt } });
}
