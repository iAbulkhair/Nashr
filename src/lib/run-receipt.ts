import { db } from "./db";
import { globalKey } from "./keys";

/**
 * Run receipts for paid scheduled work (rules 2476-2479, spec docs/superpowers/specs/2026-10-20-paid-cron-held-for-review-design.md
 * section 2.3). OpenDots marks a background run whose lease ran out `interrupted` and never retries it on its own; Thakeen
 * does the same with one receipt per claim (`weekly:{scope}:{week}`, `routine:{scope}:{id}:{period}`):
 *
 * - `started`, written before the charge, under the run's own lock;
 * - `delivered`, with the task ids, in the same round as the run's commit (inside the batch's refund guard);
 * - `refunded`, when the batch failed and gave its charge back;
 * - `held`, when a later attempt finds `started` older than `RUN_STALE_MS`: the platform killed the run after it began.
 *   A held run is not run again by a cron: the owner is told once and runs it (`resume`), with the same claim, so the
 *   charge it may have taken is reused (`chargeOnce`) and never taken twice. The daily sweep refunds a held run's charge
 *   when nobody ran it (src/lib/hold-sweep.ts).
 *
 * `owed`: credits a delivered batch should have given back (a short batch's share, rule 2276) whose refund could not be
 * written; the daily sweep gives them back from the claim's hold before keeping it (rule 2480).
 *
 * The key is built from the claim, which code builds from the caller's own scope, never from a request.
 */
export type RunState = "started" | "delivered" | "refunded" | "held";
export type RunReceipt = { state: RunState; at: string; tasks?: string[]; owed?: number };
/** Every route that charges a scheduled batch ends within 300 s: a `started` receipt older than this is a killed run. */
export const RUN_STALE_MS = 10 * 60e3;
/**
 * What `beginRun` decided. `go`: run now (the receipt says `started`). `delivered`: this claim already delivered.
 * `in_flight`: a run of it began less than `RUN_STALE_MS` ago. `held_now`: an earlier run of it was killed, and this call
 * marked it held (the caller tells the owner, once). `held`: it was already held.
 */
export type RunGate = "go" | "delivered" | "in_flight" | "held_now" | "held";

const key = (claim: string) => globalKey.runReceipt(claim);
const iso = (ms: number) => new Date(ms).toISOString();

/** The receipt of one claim, or null. */
export const readRun = (claim: string) => db.get<RunReceipt>(key(claim));
/** The receipts of several claims in one round trip, in order. */
export const readRuns = (claims: string[]) => (claims.length ? db.mget<RunReceipt>(claims.map(key)) : Promise.resolve([]));

/**
 * Before a scheduled run's charge, under the run's own lock. `resume` is the owner's explicit Run of a held run: it may
 * start over `held` or over a stale `started`, never over `delivered` or a run still in flight. A cron never resumes.
 */
export async function beginRun(claim: string, ttlS: number, o: { resume?: boolean; now?: number } = {}): Promise<RunGate> {
  const now = o.now ?? Date.now();
  const cur = await readRun(claim);
  if (cur?.state === "delivered") return "delivered";
  if (cur?.state === "started") {
    // A malformed time reads as old: NaN is never "recent".
    if (now - Date.parse(cur.at) < RUN_STALE_MS) return "in_flight";
    if (!o.resume) {
      await db.set(key(claim), { ...cur, state: "held", at: iso(now) } satisfies RunReceipt, ttlS);
      return "held_now";
    }
  } else if (cur?.state === "held" && !o.resume) return "held";
  await db.set(key(claim), { state: "started", at: iso(now) } satisfies RunReceipt, ttlS);
  return "go";
}

/** The run delivered these tasks: written in the commit's round, so a retry after it runs nothing. */
export const deliverRun = (claim: string, ttlS: number, tasks: string[]) => db.set(key(claim), { state: "delivered", at: iso(Date.now()), tasks: tasks.slice(0, 50) } satisfies RunReceipt, ttlS);
/** The batch failed and gave its charge back: a later attempt may run again. */
export const refundedRun = (claim: string, ttlS: number) => db.set(key(claim), { state: "refunded", at: iso(Date.now()) } satisfies RunReceipt, ttlS);
/** The batch was refused before any charge: no trace, so the next attempt runs as if this one never began. */
export const clearRun = (claim: string) => db.del(key(claim));

/**
 * Credits a delivered batch owes back (rule 2480): its partial refund could not be written. Added to the receipt for the
 * daily sweep; never throws (it is the fallback of a failed refund). A claim without a receipt (a handoff item) gets one
 * that holds only what is owed.
 */
export async function oweRun(claim: string, n: number, ttlS: number): Promise<void> {
  if (!Number.isSafeInteger(n) || n <= 0) return;
  try {
    const cur = await readRun(claim);
    const base: RunReceipt = cur ?? { state: "delivered", at: iso(Date.now()) };
    await db.set(key(claim), { ...base, owed: Math.max(0, Math.trunc(base.owed ?? 0)) + n } satisfies RunReceipt, ttlS);
  } catch {
    // The batch's own log line names the failed refund; nothing more can be done here.
  }
}
