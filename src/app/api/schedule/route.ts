import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getSchedule, runDaily, runWeekly, saveSchedule } from "@/lib/schedule";

export const maxDuration = 300;

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, schedule: await getSchedule(sc(u)) });
}
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { weeklyPlan?: boolean; dailyBrief?: boolean };
  const patch: Record<string, boolean> = {};
  if (typeof b.weeklyPlan === "boolean") patch.weeklyPlan = b.weeklyPlan;
  if (typeof b.dailyBrief === "boolean") patch.dailyBrief = b.dailyBrief;
  return NextResponse.json({ ok: true, schedule: await saveSchedule(sc(u), patch) });
}
/** POST {run: "weekly"|"daily"} → run now */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { run?: string };
  if (b.run === "weekly") return NextResponse.json({ ok: true, result: await runWeekly(u) });
  if (b.run === "daily") return NextResponse.json({ ok: true, brief: await runDaily(u) });
  return NextResponse.json({ ok: false, error: "bad_run" }, { status: 400 });
}
