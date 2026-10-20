import { NextResponse } from "next/server";
import { allUsers, runWeekly } from "@/lib/schedule";
import { lastSundayUtc, runCronBatch } from "@/lib/cron-batch";
import { sameSecret } from "@/lib/rate";
import { recordCronRun } from "@/lib/cron-heartbeat";
import { deadlineFor } from "@/lib/media/keys";
import { systemBy } from "@/lib/actor";
import { jobRef, runAsAccount } from "@/lib/job-account";

export const maxDuration = 300;

/**
 * Weekly plan for every eligible workspace. One plan takes 30-120 s (generate, review), so users run four
 * at a time, no new user starts after 160 s, and the route re-invokes itself until everyone is served.
 * The daily cron also calls this on Monday and Tuesday to catch up anyone Sunday missed.
 */
export async function GET(req: Request) {
  // The invocation's one deadline: each plan's model calls end by it (rule 336), so a plan started at 160 s still ends,
  // or throws and is refunded, before the platform's kill at 300 s.
  const deadline = deadlineFor(maxDuration);
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const report = await runCronBatch({
    // Each entry carries its account from the listing and is read again before its plan and its charge (rule 2506).
    job: "weekly", period: lastSundayUtc(), items: (await allUsers()).map((u) => ({ u, ref: jobRef(u) })), id: (x) => x.u.scope ?? x.u.email,
    run: (x) => runAsAccount(x.ref, (u) => runWeekly(u, systemBy("cron"), { deadline })),
    concurrency: 4, startBudgetMs: 160_000, markerTtlSeconds: 8 * 86400, req,
  });
  await recordCronRun("weekly");
  return NextResponse.json({ ok: true, ...report });
}
