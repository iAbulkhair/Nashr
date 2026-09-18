import { db } from "./db";
import { PLAN_CREDITS, getUser, type Plan } from "./auth";
import { getBrand, listLite, TASK_COST, TASK_COUNT, IMAGE_COST } from "./brand";
import { getUsage } from "./usage";
import { pmap } from "./parallel";
import { EVENTS, activeCount, day, dayCount, firstEvent, isoWeek, lastActive, userEvents, type Event } from "./track";

/** Founder overview: growth, activation, engagement, revenue estimate, health. All from Redis; no external tool. */
export const PLAN_PRICE_SAR: Record<Plan, number> = { trial: 0, starter: 149, pro: 399, agency: 799, enterprise: 0 };

export type Overview = {
  generatedAt: string;
  users: { total: number; new1d: number; new7d: number; new30d: number; activated: number; activationRate: number | null; paying: number; trialActive: number; trialExpired: number; suspended: number };
  engagement: { dau: number; wau: number; mau: number; stickiness: number | null; retention7: number | null };
  funnel: { signups30: number; activated30: number; generated30: number; approved30: number; paid30: number };
  revenue: { mrrSar: number; planMix: Record<string, number>; arpuSar: number | null; creditsUsedMonth: number; modelCostUsd: number; grossMarginPct: number | null };
  events: { date: string; counts: Record<string, number> }[];
  features: Record<string, number>;
  health: { errors7d: number; errorsToday: number; modelCalls: number; avgCostPerCallUsd: number | null };
  recent: { email: string; name: string; plan: string; credits: number; createdAt: string; lastActive: string | null; activated: boolean; events: Record<string, number> }[];
};

export async function overview(): Promise<Overview> {
  const emails = await db.smembers("users:all");
  const now = Date.now();
  const users = (await pmap(emails, (e) => getUser(e))).filter((u): u is NonNullable<typeof u> => !!u);
  const ageDays = (iso: string) => (now - new Date(iso).getTime()) / 864e5;
  const brands = new Map<string, boolean>();
  (await pmap(users, (u) => getBrand(u.email))).forEach((b, i) => brands.set(users[i].email, !!b));
  const activated = [...brands.values()].filter(Boolean).length;
  const paying = users.filter((u) => u.plan !== "trial").length;
  const trialActive = users.filter((u) => u.plan === "trial" && new Date(u.trialEnds).getTime() > now).length;
  const trialExpired = users.filter((u) => u.plan === "trial" && new Date(u.trialEnds).getTime() <= now).length;
  const planMix: Record<string, number> = {};
  for (const u of users) planMix[u.plan] = (planMix[u.plan] ?? 0) + 1;
  const mrr = users.reduce((s, u) => s + (PLAN_PRICE_SAR[u.plan] ?? 0), 0);

  const d = day();
  const [dau, wau, mau] = await Promise.all([activeCount(`active:d:${d}`), activeCount(`active:w:${isoWeek()}`), activeCount(`active:m:${d.slice(0, 7)}`)]);
  // 7-day retention: users who signed up 7-30 days ago and were active this week
  const cohort = users.filter((u) => ageDays(u.createdAt) >= 7 && ageDays(u.createdAt) <= 30);
  const weekSet = new Set(await db.smembers(`active:w:${isoWeek()}`));
  const retained = cohort.filter((u) => weekSet.has(u.email)).length;

  // funnel over the last 30 days
  const recentUsers = users.filter((u) => ageDays(u.createdAt) <= 30);
  const firsts = await pmap(recentUsers, (u) => Promise.all([firstEvent(u.email, "generate"), firstEvent(u.email, "approve")]));
  const generated30 = firsts.filter((f) => f[0]).length, approved30 = firsts.filter((f) => f[1]).length;

  // events per day, last 14 days
  const events: Overview["events"] = [];
  const features: Record<string, number> = {};
  const days = Array.from({ length: 14 }, (_, k) => day(new Date(now - (13 - k) * 864e5)));
  // 14 days x 11 events used to be 154 sequential round trips.
  const grid = await pmap(days, (dd) => Promise.all(EVENTS.map((ev) => dayCount(dd, ev as Event))), 7);
  days.forEach((dd, k) => {
    const counts: Record<string, number> = {};
    EVENTS.forEach((ev, e) => { const n = grid[k][e]; if (n) { counts[ev] = n; features[ev] = (features[ev] ?? 0) + n; } });
    events.push({ date: dd, counts });
  });
  const errors7d = events.slice(-7).reduce((s, x) => s + (x.counts.error ?? 0), 0);
  const errorsToday = events[events.length - 1]?.counts.error ?? 0;

  // credits consumed this month across all workspaces (from tasks), model cost from usage totals
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).getTime();
  const perUser = await pmap(users, async (u) => (await listLite(u.email, new Date(monthStart))).reduce((s, t) => s + (TASK_COST[t.type] ?? 1) / (TASK_COUNT[t.type] ?? 1) + (t.image ? IMAGE_COST : 0), 0), 6);
  const creditsUsed = perUser.reduce((s, x) => s + x, 0);
  const total = await getUsage("_all");
  const usdToSar = 3.75;
  const grossMargin = mrr > 0 ? Math.round(((mrr - total.usd * usdToSar) / mrr) * 100) : null;

  const recent = await pmap([...users].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 25), async (u) => {
    const [last, evs] = await Promise.all([lastActive(u.email), userEvents(u.email)]);
    return { email: u.email, name: u.name, plan: u.plan, credits: u.credits, createdAt: u.createdAt, lastActive: last, activated: brands.get(u.email) ?? false, events: evs };
  }, 8);

  return {
    generatedAt: new Date().toISOString(),
    users: { total: users.length, new1d: users.filter((u) => ageDays(u.createdAt) <= 1).length, new7d: users.filter((u) => ageDays(u.createdAt) <= 7).length, new30d: recentUsers.length, activated, activationRate: users.length ? Math.round((activated / users.length) * 100) : null, paying, trialActive, trialExpired, suspended: users.filter((u) => u.suspended).length },
    engagement: { dau, wau, mau, stickiness: mau ? Math.round((dau / mau) * 100) : null, retention7: cohort.length ? Math.round((retained / cohort.length) * 100) : null },
    funnel: { signups30: recentUsers.length, activated30: recentUsers.filter((u) => brands.get(u.email)).length, generated30, approved30, paid30: recentUsers.filter((u) => u.plan !== "trial").length },
    revenue: { mrrSar: mrr, planMix, arpuSar: paying ? Math.round(mrr / paying) : null, creditsUsedMonth: Math.round(creditsUsed), modelCostUsd: total.usd, grossMarginPct: grossMargin },
    events,
    features,
    health: { errors7d, errorsToday, modelCalls: total.calls, avgCostPerCallUsd: total.calls ? Math.round((total.usd / total.calls) * 1000) / 1000 : null },
    recent,
  };
}

/** Spreadsheet apps run cells that start with = + - @ (or tab / CR) as formulas; user-supplied names must not. */
export const csvSafe = (v: string) => (/^[=+\-@\t\r]/.test(v) && !/^[+-]?\d[\d\s.-]*$/.test(v) ? `'${v}` : v); // plain phone numbers and negative numbers stay as they are

export function usersCsv(rows: { email: string; name: string; phone: string; plan: string; credits: number; trialEnds: string; createdAt: string; renewedAt?: string }[]) {
  const esc = (v: unknown) => `"${csvSafe(String(v ?? "")).replace(/"/g, '""')}"`;
  const head = ["email", "name", "phone", "plan", "credits", "trial_ends", "created_at", "renewed_at", "monthly_price_sar"].join(",");
  return [head, ...rows.map((r) => [r.email, r.name, r.phone, r.plan, r.credits, r.trialEnds.slice(0, 10), r.createdAt.slice(0, 10), r.renewedAt ?? "", PLAN_PRICE_SAR[r.plan as Plan] ?? 0].map(esc).join(","))].join("\n");
}
export { PLAN_CREDITS };
