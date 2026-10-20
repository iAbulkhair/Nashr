import type { User } from "./auth";
import { acct } from "./account-id";
import { resolveOnceHolds, type ClaimRefund } from "./credits";
import { weeklyKept } from "./schedule";
import { getHandoff } from "./handoffs";
import { RUN_STALE_MS, readRuns, type RunReceipt } from "./run-receipt";
import { recordActivity } from "./activity";
import { systemBy } from "./actor";
import { log } from "./log";
import { runClaim } from "./keys";

/**
 * The daily sweep of every paid-once hold of one account (rules 2473-2475 and 2480; spec
 * docs/superpowers/specs/2026-10-20-paid-cron-held-for-review-design.md section 2.2), once per account from the daily
 * cron, replacing the weekly-only sweep there:
 *
 * - `weekly:` claims as before (`weeklyKept`, rule 337): an ended week's hold is kept when its plan exists.
 * - `routine:` and `handoff:` claims (rules 2470-2471) whose hold is older than `RUN_STALE_MS` (no run of them can still
 *   be in flight): kept when the run delivered (the routine's receipt says `delivered`; the handoff item is `done`),
 *   refunded otherwise: a run killed after its charge that nobody ran again, or a held run the owner did not run.
 * - A kept claim whose receipt records credits it owes back (a short batch's share whose refund failed) gives them back
 *   in the same ledger save that drops the hold (`resolveOnceHolds` with a number), so they are never given twice.
 *
 * Each refund leaves a `run_refunded` row in its brand's activity log, and the owner gets one notice for the sweep.
 * Null when there is nothing to resolve.
 */
export async function sweepHolds(u: Pick<User, "email" | "paidOnce" | "lang">, now = Date.now()) {
  const weekly = (await weeklyKept(u, now)) ?? {};
  const settled = (at: string) => !(now - Date.parse(at) < RUN_STALE_MS);
  const runs = Object.entries(u.paidOnce ?? {}).filter(([claim, hold]) => /^(routine|handoff):/.test(claim) && settled(hold.at));
  // This week's Sunday-plan holds are not `weeklyKept`'s (it waits for the week to end); one whose run the cron held is
  // refunded now, as the held notice promises (rule 2474). The owner's Run later in the week is charged afresh.
  const thisWeek = Object.entries(u.paidOnce ?? {}).filter(([claim, hold]) => claim.startsWith("weekly:") && !(claim in weekly) && settled(hold.at)).map(([c]) => c);
  const claims = [...Object.keys(weekly), ...runs.map(([c]) => c), ...thisWeek];
  if (!claims.length) return null;
  // One round: every claim's receipt, and the handoff items the handoff claims name, each read from its hold's own scope.
  const [receipts, items] = await Promise.all([
    readRuns(claims),
    Promise.all(runs.map(async ([claim, hold]) => {
      const m = /^handoff:(.+):([^:]+):(\d+)$/.exec(claim);
      if (!m) return null;
      const h = await getHandoff(hold.scope, m[2]);
      return h?.items[Number(m[3])]?.status ?? null;
    })),
  ]);
  const receipt = new Map<string, RunReceipt | null>(claims.map((c, i) => [c, receipts[i] ?? null]));
  /** A delivered claim: kept, or the credits it owes back when its receipt records any. */
  const keep = (claim: string): true | number => {
    const owed = receipt.get(claim)?.owed;
    return typeof owed === "number" && Number.isFinite(owed) && owed > 0 ? Math.trunc(owed) : true;
  };
  const kept: Record<string, boolean | number> = {};
  for (const [claim, has] of Object.entries(weekly)) kept[claim] = has ? keep(claim) : false;
  runs.forEach(([claim], i) => {
    const delivered = claim.startsWith("routine:") ? receipt.get(claim)?.state === "delivered" : items[i] === "done";
    kept[claim] = delivered ? keep(claim) : false;
  });
  for (const claim of thisWeek) if (receipt.get(claim)?.state === "held") kept[claim] = false;
  if (!Object.keys(kept).length) return null;
  const r = await resolveOnceHolds(u.email, kept);
  if (r.refunded.length) await tell(u, r.refunded);
  return r;
}

/** One activity row per refund in its brand, and one notice for the sweep. Never throws: the credits are back already. */
async function tell(u: Pick<User, "email" | "paidOnce" | "lang">, refunded: ClaimRefund[]) {
  const at = new Date().toISOString();
  const ar = u.lang === "ar";
  const total = refunded.reduce((s, x) => s + x.credits, 0);
  try {
    const byScope = new Map<string, ClaimRefund[]>();
    for (const x of refunded) byScope.set(x.scope, [...(byScope.get(x.scope) ?? []), x]);
    const { notifyItem } = await import("./notifications");
    await Promise.all([
      ...[...byScope].map(([scope, xs]) => recordActivity(scope, xs.map((x) => ({ at, kind: "run_refunded" as const, agent: x.agent, by: systemBy("cron"), via: "cron" as const, credits: x.credits, outcome: x.claim.split(":")[0] + (x.partial ? ":partial" : "") })))),
      total > 0 ? notifyItem(acct(u as User), u.lang, {
        kind: "credits", href: "activity",
        title: ar ? `أعدنا ${total} كريدت لعمل مجدول لم يكتمل` : `We returned ${total} credits for scheduled work that did not finish`,
        body: ar ? "توقف تشغيل مجدول قبل أن يكتمل، أو لم يُعِد جزءاً من كلفته، فأعدنا الكريدت إلى رصيدك. التفاصيل في سجل النشاط." : "A scheduled run stopped before it finished, or did not give back part of its cost, so the credits are back in your balance. Details are in the activity log.",
      }, runClaim.sweepNotice(at.slice(0, 10)), 2) : null,
    ]);
  } catch (e) {
    log.error("hold sweep notice failed", e);
  }
}
