import { NextResponse } from "next/server";
import type { User } from "@/lib/auth";
import { allUsers } from "@/lib/schedule";
import { dueRoutines, runRoutine, type RoutineId } from "@/lib/routines";
import { AUTO_HANDOFF_CRON_ID, autoRunHandoff, dueHandoffs } from "@/lib/handoff-auto";
import { runCronBatch } from "@/lib/cron-batch";
import { sameSecret } from "@/lib/rate";
import { recordCronRun } from "@/lib/cron-heartbeat";
import { deadlineFor } from "@/lib/media/keys";
import { jobRef, runAsAccount, type JobRef } from "@/lib/job-account";

export const maxDuration = 300;

/** Every item carries the account it acts for, taken from the roster when it is listed (rule 2500). */
type Item = ({ kind: "routine"; user: User; id: RoutineId } | { kind: "handoff"; user: User; id: string; item: number }) & { ref: JobRef };

/**
 * The routines the owners turned on (src/lib/routines.ts), daily at 06:00 UTC, after the 05:00 daily job has renewed
 * credits. One item is one routine in one brand and makes at most one generation: 30-120 s with the reviewer, plus, for
 * a cross-reviewed type (Majed's monthly review), one cross-agent review call of at most 45 s. Items run four at a time,
 * no new item starts after 160 s, and the route re-invokes itself until everyone is served. Only routines that are on
 * and have not run in their week or month are items; the runner's own period check decides the rest, so a missed day is
 * caught up the next day. The batch's attempt count is per day, so the one that bounds charges a killed run leaves
 * behind is the runner's, per routine and period (`routinetry:`).
 *
 * The same cron runs Majed's auto-run (src/lib/handoff-auto.ts), for brands whose owner switched it on: at most ONE
 * handoff item per brand scope, whose cron id is `{scope}:auto_handoff`, so its day marker lets one auto-run a day per
 * brand across the chain's hops. Those items go first, so they start in the first wave.
 *
 * Every item, a routine or an auto-run, needs BATCH_RUN_MIN_MS (180 s) of this invocation left, measured from `deadline`,
 * before its hold and its charge; with less it answers "retry:late" at once and charges nothing. A late item makes the
 * batch hand the rest to a fresh invocation (src/lib/cron-batch.ts), so a brand late in the list is served the same day,
 * and the same deadline bounds each batch's cross-agent review.
 */
export async function GET(req: Request) {
  // 15 s under the platform's limit (`deadlineFor`), like every other route: since 2026-10-01 each batch's model calls end
  // by it (rule 336), and a call ending at the kill itself would leave no time for its refund.
  const deadline = deadlineFor(maxDuration);
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const users = await allUsers();
  const [routines, handoffs] = await Promise.all([dueRoutines(users), dueHandoffs(users)]);
  const items: Item[] = [...handoffs.map((h) => ({ kind: "handoff" as const, ...h, ref: jobRef(h.user) })), ...routines.map((r) => ({ kind: "routine" as const, ...r, ref: jobRef(r.user) }))];
  const report = await runCronBatch<Item>({
    job: "routines", period: new Date().toISOString().slice(0, 10), items,
    id: (x) => `${x.user.scope ?? x.user.email}:${x.kind === "routine" ? x.id : AUTO_HANDOFF_CRON_ID}`,
    run: (x) => runAsAccount(x.ref, (u) => (x.kind === "routine" ? runRoutine(u, x.id, deadline) : autoRunHandoff(u, x.id, x.item, deadline))),
    concurrency: 4, startBudgetMs: 160_000, markerTtlSeconds: 2 * 86400, req,
  });
  await recordCronRun("routines");
  return NextResponse.json({ ok: true, ...report });
}
