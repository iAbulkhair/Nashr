import { NextResponse } from "next/server";
import { currentUser, saveUser, sc } from "@/lib/auth";
import { listTasks, TASK_COST } from "@/lib/brand";
import { db } from "@/lib/db";

export type EmailPrefs = "all" | "important" | "none";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const tasks = await listTasks(sc(u));
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const usage: Record<string, { count: number; credits: number }> = {};
  for (const t of tasks) {
    if (new Date(t.createdAt) < monthStart) continue;
    const k = t.type; usage[k] ??= { count: 0, credits: 0 }; usage[k].count++;
  }
  // credits per batch, not per item: social=10 items/10cr, ads=5/5, whatsapp=3/3, gbp=3/3, article=1/2, weekly_plan=1/1
  const per: Record<string, number> = { social: 1, ads: 1, whatsapp: 1, gbp: 1, article: TASK_COST.article, weekly_plan: TASK_COST.weekly_plan };
  for (const k of Object.keys(usage)) usage[k].credits = usage[k].count * (per[k] ?? 1);
  const images = tasks.filter((t) => t.imageUrl && new Date(t.createdAt) >= monthStart).length;
  const prefs = (await db.get<{ emails?: EmailPrefs }>(`profile:${sc(u)}`)) ?? {};
  const { passHash: _p, ...safe } = u; void _p;
  return NextResponse.json({ ok: true, user: safe, usage, images, emails: prefs.emails ?? "all" });
}

export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { name?: string; phone?: string; lang?: string; emails?: EmailPrefs };
  if (typeof b.name === "string") u.name = b.name.trim().slice(0, 80);
  if (typeof b.phone === "string" && b.phone.replace(/\D/g, "").length >= 9) u.phone = b.phone.trim().slice(0, 30);
  if (b.lang === "ar" || b.lang === "en") u.lang = b.lang;
  await saveUser(u);
  if (b.emails && ["all", "important", "none"].includes(b.emails)) await db.set(`profile:${sc(u)}`, { emails: b.emails });
  return NextResponse.json({ ok: true });
}
