import { after } from "next/server";
import { db } from "./db";
import { appOrigin } from "./origin";
import { pmap } from "./parallel";
import { log } from "./log";
import { globalKey } from "./keys";

/**
 * Runs a per-user cron job so that EVERY user is served, whatever the count.
 * - bounded concurrency instead of one user after another
 * - a "done" marker per (job, period, user): a user is never processed twice in a period
 * - one failing user never stops the others; a user is retried at most twice
 * - a start budget: no new user is started once the function is close to its time limit
 * - when users remain, the route calls itself again (same bearer secret) until the list is empty, on `appOrigin()`: behind
 *   the Hostinger proxy `req.url` is the internal address, which the hop cannot reach (rule 904)
 */
export type BatchReport = { job: string; period: string; chain: number; total: number; alreadyDone: number; processed: number; failed: number; remaining: number; chained: boolean; results: Record<string, string> };

/**
 * What a run answers when it refused only because this invocation had too little time left for it (its deadline check,
 * before any charge). Like any "retry" it keeps its attempt and its day open; unlike the others it hands the rest to a
 * fresh invocation.
 */
export const RETRY_LATE = "retry:late";

const MAX_ATTEMPTS = 2;

export async function runCronBatch<T>(o: {
  job: string; period: string; items: T[]; id: (t: T) => string; run: (t: T) => Promise<string>;
  concurrency: number; /** stop starting new users after this many ms (function limit minus the longest single run) */ startBudgetMs: number;
  markerTtlSeconds: number; req: Request; maxChain?: number;
}): Promise<BatchReport> {
  const t0 = Date.now();
  const url = new URL(o.req.url);
  const chain = Math.max(0, Number(url.searchParams.get("chain") ?? 0) || 0);
  const mark = (t: T) => `crondone:${o.job}:${o.period}:${o.id(t)}`;
  const tries = (t: T) => `crontry:${o.job}:${o.period}:${o.id(t)}`;

  // The two markers are independent, so they are read together. One after the other cost every item two sequential
  // HTTP round trips, and that scan runs again on each of the chain's hops.
  const state = await pmap(o.items, async (t) => {
    const [done, attempts] = await Promise.all([db.get(mark(t)), db.get<number>(tries(t))]);
    return { t, done: !!done, attempts: Number(attempts ?? 0) };
  });
  const pending = state.filter((s) => !s.done && s.attempts < MAX_ATTEMPTS).map((s) => s.t);
  const results: Record<string, string> = {};
  let next = 0, processed = 0, failed = 0, retryLater = 0, late = 0;

  await Promise.all(Array.from({ length: Math.min(o.concurrency, pending.length) }, async () => {
    while (next < pending.length && Date.now() - t0 < o.startBudgetMs) {
      const t = pending[next++];
      // The attempt is recorded BEFORE the work, not after it fails. A platform timeout kills the invocation without
      // throwing anything, so a run that had already charged credits and called the model left no trace at all: no
      // done-marker, no attempt, nothing. The next hop — and every daily catch-up after it — saw an untouched user
      // and charged again, without bound. Counting starts rather than caught failures bounds that at MAX_ATTEMPTS.
      const attempt = await db.incrby(tries(t), 1);
      await db.set(tries(t), attempt, o.markerTtlSeconds); // incrby alone leaves the counter without an expiry
      try {
        const r = await o.run(t);
        results[o.id(t)] = r;
        // "retry" means the work never began (someone else holds the lock), so it must not consume an attempt.
        if (r.startsWith("retry")) { retryLater++; if (r === RETRY_LATE) late++; await db.set(tries(t), attempt - 1, o.markerTtlSeconds); continue; }
        await db.set(mark(t), r.slice(0, 80), o.markerTtlSeconds);
        processed++;
      } catch (e) {
        failed++;
        results[o.id(t)] = "error:" + (e instanceof Error ? e.message : "x").slice(0, 120);
        log.error(`cron ${o.job} failed for ${o.id(t)}`, e);
      }
    }
  }));

  const notStarted = pending.length - next;
  const remaining = notStarted + failed + retryLater;
  // Chain for users that never started or failed. A user that answered "retry" because someone else holds its lock or
  // the model is paused would just spin the chain; the next scheduled run or the daily catch-up picks it up. "retry:late"
  // is different: the work was refused only because this invocation had too little time left, and a fresh one starts it
  // in its first wave. So it chains too, when this hop did run something (the time went to work, not to the listing
  // before the first item: a hop that ran nothing would find the next one just as late).
  const chained = (notStarted + failed > 0 || (late > 0 && processed + failed > 0)) && chain < (o.maxChain ?? 30);
  if (chained) {
    url.searchParams.set("chain", String(chain + 1));
    const next = `${appOrigin()}${url.pathname}${url.search}`;
    const headers = { authorization: o.req.headers.get("authorization") ?? "" };
    // Hand the rest to a fresh invocation. Only the request needs to leave; the new run reports for itself.
    const kick = () => fetch(next, { headers, signal: AbortSignal.timeout(8000) }).then(() => undefined, () => undefined);
    // `after` needs a request scope; outside one (scripts, tests) fire the request directly, as judge.ts does.
    try { after(kick); } catch { void kick(); }
  }
  const report = { job: o.job, period: o.period, chain, total: o.items.length, alreadyDone: state.filter((s) => s.done).length, processed, failed, remaining, chained, results };
  // Rule 2384: the founder's view of this hop, counts only (no address, scope or result text), beside the heartbeat.
  const held = Object.values(results).filter((r) => r === "held").length;
  await db.set(globalKey.cronReport(o.job), { at: new Date().toISOString(), period: o.period, chain, total: report.total, alreadyDone: report.alreadyDone, processed, failed, held, remaining } satisfies CronReport, REPORT_TTL_S).catch((e) => log.error("cron report failed", e));
  return report;
}

/** The last hop of a per-user cron job, as the founder's overview shows it (rule 2384). Counts only. */
export type CronReport = { at: string; period: string; chain: number; total: number; alreadyDone: number; processed: number; failed: number; held: number; remaining: number };
const REPORT_TTL_S = 14 * 86400;

/** Date (UTC) of the most recent Sunday: the weekly plan period, stable through the Monday and Tuesday catch-up runs. */
export function lastSundayUtc(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
