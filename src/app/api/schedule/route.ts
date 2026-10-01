import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getSchedule, runDaily, runWeekly, saveSchedule, type Schedule } from "@/lib/schedule";
import { isRoutineId, type RoutineId } from "@/lib/routines";
import { byOf } from "@/lib/actor";
import { deadlineFor } from "@/lib/media/keys";
import { forbid } from "@/lib/roles";

export const maxDuration = 300;

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, schedule: await getSchedule(sc(u)) });
}
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Switches that make cron spend credits with nobody asking: admin and owner only (src/lib/roles.ts "schedule.write").
  const no = forbid(u, "schedule.write");
  if (no) return no;
  // A JSON null or array is not a patch; reading a field off null used to answer 500.
  const raw: unknown = await req.json().catch(() => ({}));
  const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as { weeklyPlan?: unknown; dailyBrief?: unknown; followUps?: unknown; routines?: unknown };
  const patch: Partial<Schedule> = {};
  if (typeof b.weeklyPlan === "boolean") patch.weeklyPlan = b.weeklyPlan;
  if (typeof b.dailyBrief === "boolean") patch.dailyBrief = b.dailyBrief;
  if (typeof b.followUps === "boolean") patch.followUps = b.followUps;
  // Routine switches: only ids of routines that exist, only booleans; anything else is dropped.
  if (b.routines && typeof b.routines === "object" && !Array.isArray(b.routines)) {
    const routines: Partial<Record<RoutineId, boolean>> = {};
    for (const [id, on] of Object.entries(b.routines)) if (isRoutineId(id) && typeof on === "boolean") routines[id] = on;
    if (Object.keys(routines).length) patch.routines = routines;
  }
  return NextResponse.json({ ok: true, schedule: await saveSchedule(sc(u), patch) });
}
/** POST {run: "weekly"|"daily"} → run now */
export async function POST(req: Request) {
  // A weekly "Run now" ends its model calls by this request's deadline (rule 336).
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { run?: string };
  // A login's own "Run now" (any role): its activity rows name that login (or the founder), not the cron.
  if (b.run === "weekly") return NextResponse.json({ ok: true, result: await runWeekly(u, await byOf(u), { deadline }) });
  if (b.run === "daily") return NextResponse.json({ ok: true, brief: await runDaily(u) });
  return NextResponse.json({ ok: false, error: "bad_run" }, { status: 400 });
}
