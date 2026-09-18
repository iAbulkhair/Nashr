import { NextResponse } from "next/server";
import { PLAN_CREDITS, getUser, isAdmin, saveUser, type Plan } from "@/lib/auth";
import { CAPS, db, pushCapped } from "@/lib/db";
import { monthKey, withUserLock } from "@/lib/credits";
import { getUsage } from "@/lib/usage";
import { pmap } from "@/lib/parallel";

// GET  /api/admin/plan            → list users with this month's model usage
// POST /api/admin/plan {email, plan?, addCredits?} → set plan (resets to plan allowance, starts renewal cycle) / add credits
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const emails = await db.smembers("users:all");
  const rows = await pmap(emails, async (e) => {
    const u = await getUser(e);
    if (!u) return null;
    const usage = await getUsage(u.email);
    return ({ email: u.email, name: u.name, phone: u.phone, plan: u.plan, credits: u.credits, trialEnds: u.trialEnds, createdAt: u.createdAt, renewedAt: u.renewedAt ?? null, suspended: !!u.suspended, lang: u.lang, tokens: usage.in + usage.out, usd: usage.usd, calls: usage.calls });
  });
  const users = rows.filter((x): x is NonNullable<typeof x> => !!x);
  users.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const total = await getUsage("_all");
  return NextResponse.json({ ok: true, count: users.length, users, total });
}

export async function POST(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { email?: string; plan?: Plan; addCredits?: number; reason?: string };
  if (!b.email || !(await getUser(b.email))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const prev = await getUser(b.email);
  const before = prev ? { plan: String(prev.plan), credits: Number(prev.credits) } : undefined;
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
  await pushCapped("admin:log", JSON.stringify({ actor: "founder", email: user.email, what: b.plan ? `plan:${b.plan}` : `credits:${b.addCredits}`, before, after: { plan: user.plan, credits: user.credits }, reason: (b.reason ?? "").slice(0, 200) || undefined, at: new Date().toISOString() }), CAPS.adminLog);
  return NextResponse.json({ ok: true, user: { email: user.email, plan: user.plan, credits: user.credits, renewedAt: user.renewedAt } });
}
