import { getUser, type User } from "./auth";
import { acct } from "./account-id";
import { db } from "./db";
import { pmap } from "./parallel";
import { marginPct, revenueSarOf } from "./margin";
import { getUsage, getUsageBreakdown, mediaCostKey, rankAccounts, USAGE_DIMS, type UsageBreakdown, type UsageDim } from "./usage";

/**
 * The two views of per-client AI usage (rules 2905-2909): the founder's ranking of every account by what its model calls
 * and renders cost us, and an owner's own month split by person, brand, agent, model and day. Both read the counters
 * `record` and `meterRender` write (src/lib/usage.ts); neither writes anything.
 */

/** A `?month=` the routes accept: `YYYY-MM`. Left out, the routes read this month (`monthKey()`). */
export const isMonth = (v: unknown): v is string => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

export type ClientRow = {
  account: string; email: string; name: string; plan: string;
  calls: number; modelUsd: number; mediaUsd: number; usd: number; marginPct: number | null;
};

/**
 * The founder console's "Clients by AI cost" (rule 2905): the month's ranking (one ZRANGE), then each ranked account's
 * record, model usage and render cost through `pmap`. An account in the ranking with no record any more (deleted between
 * the two reads) is left out.
 */
export async function clientRanking(month: string, limit = 100): Promise<ClientRow[]> {
  const ranked = await rankAccounts(month, limit);
  const rows = await pmap(ranked, async ({ account }): Promise<ClientRow | null> => {
    const [u, usage, media] = await Promise.all([getUser(account), getUsage(account, month), db.get<number>(mediaCostKey(account, month)).catch(() => 0)]);
    if (!u) return null;
    const mediaUsd = Math.max(0, Number(media ?? 0) || 0) / 1e6;
    const usd = usage.usd + mediaUsd;
    return { account, email: u.email, name: u.name ?? "", plan: u.plan, calls: usage.calls, modelUsd: usage.usd, mediaUsd, usd, marginPct: marginPct(revenueSarOf(u), usd) };
  });
  return rows.filter((r): r is ClientRow => r !== null).sort((a, b) => b.usd - a.usd);
}

/** One row of an owner's view: a value, its requests and its share of the month's requests (0-100, one decimal). */
export type ShareRow = { key: string; calls: number; share: number };
export type OwnerUsage = { month: string; total: { calls: number } } & Record<UsageDim | "agent", ShareRow[]>;

const share = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
const rowsOf = (slices: Record<string, { calls: number }>, total: number, order: "calls" | "key" = "calls"): ShareRow[] =>
  Object.entries(slices)
    .filter(([, s]) => s.calls > 0)
    .map(([key, s]) => ({ key, calls: s.calls, share: share(s.calls, total) }))
    .sort((a, b) => (order === "key" ? a.key.localeCompare(b.key) : b.calls - a.calls || a.key.localeCompare(b.key)));

/**
 * An owner's or admin's own month (rule 2907): requests, never money. What a call costs us is the founder's figure, not
 * the customer's; the customer pays in credits, which the billing page already shows. `account` is always `acct(u)`.
 */
export async function ownerUsage(u: User, month: string): Promise<OwnerUsage> {
  const account = acct(u);
  const [b, usage] = await Promise.all([getUsageBreakdown(account, month), getUsage(account, month)]);
  return ownerView(b, usage.calls, Object.fromEntries(Object.entries(usage.byAgent).map(([id, a]) => [id, { calls: a?.calls ?? 0 }])));
}

/** The pure half of `ownerUsage`, for tests: no dollar figure leaves it. */
export function ownerView(b: UsageBreakdown, calls: number, agents: Record<string, { calls: number }>): OwnerUsage {
  const out = { month: b.month, total: { calls }, agent: rowsOf(agents, calls) } as OwnerUsage;
  for (const d of USAGE_DIMS) out[d] = rowsOf(b[d], calls, d === "day" ? "key" : "calls");
  return out;
}
