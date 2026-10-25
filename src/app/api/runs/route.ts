import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api-handler";
import { sc } from "@/lib/auth";
import { metersOf, runConv, METER_RUNS } from "@/lib/context-meter";
import { listRuns } from "@/lib/runs";
import { RUN_LOG } from "@/lib/v2-flags";
import { workRun } from "@/lib/work-view";

/**
 * The work view's read (v2 C9 + C13, rules 4775-4777): GET ?conv= → `{runs, meters}`, the caller's own newest runs as the
 * work view shows them (`workRun`: steps, states, tokens and scores, never words, model ids or rule ids) and each agent's
 * context meter in the thread `conv` (the default thread without it). With `conv`, only that thread's chat runs are
 * listed; without it, every kind. Read from the run log under `sc(u)`, one list read and one batch read; 404 while
 * RUN_LOG is off. Read-only, so a viewer login reads it too.
 */
export const GET = handler(
  { auth: "user", query: z.object({ conv: z.string().max(64).optional() }) },
  async ({ u, query: { conv } }) => {
    if (!RUN_LOG) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const runs = await listRuns(sc(u), METER_RUNS);
    const thread = runConv(conv).conv;
    const shown = conv === undefined ? runs : runs.filter((r) => r.kind === "chat" && r.conv === thread);
    return NextResponse.json({ ok: true, runs: shown.map(workRun), meters: metersOf(runs, conv) });
  },
);
