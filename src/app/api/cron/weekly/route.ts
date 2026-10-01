import { NextResponse } from "next/server";
import { allUsers, runWeekly } from "@/lib/schedule";
import { lastSundayUtc, runCronBatch } from "@/lib/cron-batch";
import { sameSecret } from "@/lib/rate";
import { deadlineFor } from "@/lib/media/keys";
import { systemBy } from "@/lib/actor";

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
    job: "weekly", period: lastSundayUtc(), items: await allUsers(), id: (u) => u.scope ?? u.email, run: (u) => runWeekly(u, systemBy("cron"), { deadline }),
    concurrency: 4, startBudgetMs: 160_000, markerTtlSeconds: 8 * 86400, req,
  });
  return NextResponse.json({ ok: true, ...report });
}
