import { NextResponse } from "next/server";
import { accountOfScope } from "@/lib/auth";
import { runCronBatch } from "@/lib/cron-batch";
import { sameSecret } from "@/lib/rate";
import { recordCronRun } from "@/lib/cron-heartbeat";
import { deadlineFor } from "@/lib/media/keys";
import { runAsAccount, type JobRef } from "@/lib/job-account";
import { leaveQueue, queueScopes } from "@/lib/queue";
import { tickScope } from "@/lib/plan-run";
import { v2On } from "@/lib/v2-switch";

export const maxDuration = 300;

type Item = { scope: string; ref: JobRef };

/**
 * The durable queue's tick (Thakeen v2 phase 2, C7, rules 4655-4669): kicked by Reem's 15-minute tick while `QUEUE` is
 * on, with a daily fallback in crons.json. Off in this release: it answers `{ ok: true, off: true }` and reads nothing.
 *
 * The items are the scopes in the platform set `qscopes`, which only `enqueue` and a resumed plan add to: scopes from our
 * own records, never from the request. Each carries the account its scope belongs to (`accountOfScope`), and its work
 * runs through `runAsAccount`, which reads that account again and skips a deleted, suspended or archived one before any
 * write or charge. One item runs at most one job (`tickScope`), four scopes at a time, none started after 160 s, and the
 * batch hands what is left to a fresh invocation. The period is the 10-minute slot, so a scope is served once per tick.
 */
export async function GET(req: Request) {
  const deadline = deadlineFor(maxDuration);
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  if (!v2On("QUEUE")) return NextResponse.json({ ok: true, off: true });
  const items: Item[] = (await queueScopes()).flatMap((scope) => {
    const account = accountOfScope(scope);
    return account ? [{ scope, ref: { account, scope } }] : [];
  });
  const report = await runCronBatch<Item>({
    job: "queue",
    period: new Date().toISOString().slice(0, 15),
    items,
    id: (x) => x.scope,
    run: (x) =>
      runAsAccount(x.ref, (u) => tickScope(u, deadline)).then(async (out) => {
        // A workspace the job may no longer act for leaves the set; its jobs stay until the account's wipe.
        if (out.startsWith("skip:account") || out === "skip:scope_mismatch" || out === "skip:brand_inactive")
          await leaveQueue(x.scope);
        return out;
      }),
    concurrency: 4,
    startBudgetMs: 160_000,
    markerTtlSeconds: 3600,
    req,
  });
  await recordCronRun("queue");
  return NextResponse.json({ ok: true, ...report });
}
