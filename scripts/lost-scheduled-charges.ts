// Lists scheduled work that was charged and never delivered before the claim-and-receipt release (rules 2470-2486,
// docs/system/flows.md section 97), so the founder can refund each owner by hand from the console: founder decision
// 2026-10-20, "refund by hand case by case, no scan that writes". This script never writes anything.
//
// Usage:  npx --no-install jiti scripts/lost-scheduled-charges.ts
// with the app's own KV_REST_API_URL / KV_REST_API_TOKEN already in the environment (set privately, never typed on a
// command line that is saved).
//
// What the store still remembers, and so the only window this can see:
//   - A routine's unsettled charges per period (`routinetry:`, kept 8 days for weekly routines and 35 for monthly ones):
//     each charge that was neither refunded nor refused counts one, and a period whose run was recorded (`routinelast:`
//     inside it) delivered one of them. The rest were charged with nothing delivered.
//   - A handoff item left `running` past its 300-second run lock (a run killed after it began). Whether that run reached
//     its charge cannot be told apart from the record; it is listed as "check", with the item's price.
// Anything the new release handles itself is skipped: a period or item with a run receipt or a claim hold is refunded by
// the daily sweep (`sweepHolds`), so listing it here would refund it twice. Older losses left no trace and cannot be
// listed. Prices are the type's base credits (`TASK_COST`); a batch on a higher model tier cost more, so check the
// account's activity before refunding.
//
// Output: one tab-separated line per finding (account, brand scope, kind, routine or handoff item, period, charges, credits
// each), for the founder's own terminal only, never pasted into a chat or a ticket. Exit 0 always; 2 when it cannot run.
import { pathToFileURL } from "node:url";
import { db, mgetChunked } from "../src/lib/db";
import { pmap } from "../src/lib/parallel";
import { globalKey } from "../src/lib/keys";
import type { User } from "../src/lib/auth";
import { listBrands, scopeFor } from "../src/lib/brands";
import { ROUTINES, periodOf, routineClaim, type RoutineId } from "../src/lib/routines";
import { HANDOFF_RUN_LOCK_S, getHandoffs, handoffClaim } from "../src/lib/handoffs";
import { TASK_COST, isTaskType } from "../src/lib/tasks";

export type LostCharge = { account: string; scope: string; kind: "routine" | "handoff"; what: string; period: string; charges: number; credits: number; sure: boolean };

/** The two periods a routine's markers can still cover, this one and the one before, each with the period after it. */
function periods(cadence: "weekly" | "monthly", now: Date): { period: string; next: string }[] {
  if (cadence === "weekly") {
    return [0, 7].map((back) => {
      const period = periodOf("weekly", new Date(now.getTime() - back * 864e5));
      return { period, next: periodOf("weekly", new Date(Date.parse(`${period}T00:00:00Z`) + 7 * 864e5)) };
    });
  }
  return [0, 1].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return { period: periodOf("monthly", d), next: periodOf("monthly", new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) };
  });
}

/** Every finding, for every brand of every account. Reads only. */
export async function lostCharges(now = new Date()): Promise<LostCharge[]> {
  const ids = await db.smembers(globalKey.usersAll());
  const users = (await mgetChunked<User>(ids.map((id) => `user:${id}`))).filter((u): u is User => !!u && typeof u.email === "string");
  const scopes = (await pmap(users, async (u) => (await listBrands(u.email)).map((b) => ({ account: u, scope: scopeFor(u.email, b.id) })), 20)).flat();
  const rows = await pmap(scopes, async ({ account, scope }) => {
    const out: LostCharge[] = [];
    const holds = account.paidOnce ?? {};
    // Routines: the attempt counters, the last runs and the new release's receipts, in one round per scope.
    const slots = ROUTINES.flatMap((r) => periods(r.cadence, now).map((p) => ({ r, ...p })));
    const [tries, lasts, receipts, hids] = await Promise.all([
      db.mget<number | string>(slots.map((s) => `routinetry:${scope}:${s.r.id}:${s.period}`)),
      db.mget<string>(ROUTINES.map((r) => `routinelast:${scope}:${r.id}`)),
      db.mget<unknown>(slots.map((s) => globalKey.runReceipt(routineClaim(scope, s.r.id as RoutineId, s.period)))),
      db.lrange(`handoffs:${scope}`, 0, -1),
    ]);
    const lastOf = new Map(ROUTINES.map((r, i) => [r.id, lasts[i]]));
    slots.forEach((s, i) => {
      const claim = routineClaim(scope, s.r.id as RoutineId, s.period);
      if (receipts[i] || claim in holds) return; // the daily sweep handles it
      const n = Math.max(0, Math.trunc(Number(tries[i] ?? 0)) || 0);
      const last = lastOf.get(s.r.id);
      const len = s.r.cadence === "weekly" ? 10 : 7;
      const delivered = !!last && last.slice(0, len) >= s.period && last.slice(0, len) < s.next;
      const lost = n - (delivered ? 1 : 0);
      if (lost > 0) out.push({ account: account.email, scope, kind: "routine", what: s.r.id, period: s.period, charges: lost, credits: TASK_COST[s.r.type], sure: true });
    });
    // Handoff items left running past their lock, with no claim hold or receipt of the new release.
    const hs = await getHandoffs(scope, hids);
    const items = hs.flatMap((h) => (h ? h.items.map((it, n) => ({ h, it, n })) : [])).filter(({ it }) => it.status === "running" && (!it.at || now.getTime() - Date.parse(it.at) > HANDOFF_RUN_LOCK_S * 1000));
    const recs = await db.mget<unknown>(items.map(({ h, n }) => globalKey.runReceipt(handoffClaim(scope, h.id, n))));
    items.forEach(({ h, it, n }, i) => {
      if (recs[i] || handoffClaim(scope, h.id, n) in holds || !isTaskType(it.type)) return;
      out.push({ account: account.email, scope, kind: "handoff", what: `${h.id}#${n}:${it.type}`, period: (it.at ?? "").slice(0, 10), charges: 1, credits: TASK_COST[it.type], sure: false });
    });
    return out;
  }, 20);
  return rows.flat();
}

async function main(): Promise<void> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("KV_REST_API_URL and KV_REST_API_TOKEN must be set (the app's own store).");
    process.exitCode = 2;
    return;
  }
  const rows = await lostCharges();
  console.log(["account", "scope", "kind", "what", "period", "charges", "credits each", "certainty"].join("\t"));
  for (const r of rows) console.log([r.account, r.scope, r.kind, r.what, r.period, r.charges, r.credits, r.sure ? "charged, not delivered" : "check: may not have reached its charge"].join("\t"));
  console.log(`${rows.length} finding(s). Read only: nothing was written. Refund from the console, checking each account's activity first.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
