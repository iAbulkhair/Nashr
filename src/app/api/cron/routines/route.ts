import { NextResponse } from "next/server";
import { allUsers } from "@/lib/schedule";
import { dueRoutines, runRoutine } from "@/lib/routines";
import { runCronBatch } from "@/lib/cron-batch";
import { sameSecret } from "@/lib/rate";

export const maxDuration = 300;

/**
 * The routines the owners turned on (src/lib/routines.ts), daily at 06:00 UTC, after the 05:00 daily job has renewed
 * credits. One item is one routine in one brand and makes at most one generation (30-120 s with the reviewer), so items
 * run four at a time, no new item starts after 160 s, and the route re-invokes itself until everyone is served. Only
 * routines that are on and have not run in their week or month are items; the runner's own period check decides the
 * rest, so a missed day is caught up the next day. The batch's attempt count is per day, so the one that bounds charges
 * a killed run leaves behind is the runner's, per routine and period (`routinetry:`).
 */
export async function GET(req: Request) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const report = await runCronBatch({
    job: "routines", period: new Date().toISOString().slice(0, 10), items: await dueRoutines(await allUsers()), id: (x) => `${x.user.scope ?? x.user.email}:${x.id}`, run: (x) => runRoutine(x.user, x.id),
    concurrency: 4, startBudgetMs: 160_000, markerTtlSeconds: 2 * 86400, req,
  });
  return NextResponse.json({ ok: true, ...report });
}
