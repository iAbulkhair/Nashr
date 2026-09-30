import { db } from "./db";
import { getUser, type AgencyDeal, type Plan } from "./auth";
import { SAR_PER_USD, allowanceOf, priceOf, seatLimit } from "./pricing";
import { getBrand, listLite, TASK_COST, TASK_COUNT, IMAGE_COST } from "./brand";
import { getUsage } from "./usage";
import { pmap } from "./parallel";
import { listBrands, scopeFor } from "./brands";
import { EVENTS, activeCount, day, dayCount, firstEvent, isoWeek, lastActive, userEvents, type Event } from "./track";
import { monthKey } from "./credits";
import { MEDIA_MODELS, type MediaModelId, type MediaProviderId } from "./media-catalog";
import { mk } from "./media/keys";

/**
 * Founder overview: growth, activation, engagement, revenue estimate, health. All from Redis; no external tool. Prices,
 * allowances and seats come from src/lib/pricing.ts (`priceOf`: the list price, or an Agency account's deal price).
 */

export type Overview = {
  generatedAt: string;
  users: { total: number; new1d: number; new7d: number; new30d: number; activated: number; activationRate: number | null; paying: number; trialActive: number; trialExpired: number; suspended: number };
  engagement: { dau: number; wau: number; mau: number; stickiness: number | null; retention7: number | null };
  funnel: { signups30: number; activated30: number; generated30: number; approved30: number; paid30: number };
  revenue: { mrrSar: number; planMix: Record<string, number>; arpuSar: number | null; creditsUsedMonth: number; modelCostUsd: number; grossMarginPct: number | null; renderCostUsd: number; renderByProvider: RenderSpend["byProvider"]; renderByModel: RenderSpend["byModel"] };
  events: { date: string; counts: Record<string, number> }[];
  features: Record<string, number>;
  health: { errors7d: number; errorsToday: number; modelCalls: number; avgCostPerCallUsd: number | null };
  recent: { email: string; name: string; plan: string; credits: number; createdAt: string; lastActive: string | null; activated: boolean; events: Record<string, number> }[];
};

/** What renders cost us in a month (spec 4.9). Provider and month totals are sums of the per-model counters. */
export type RenderSpend = {
  usd: number;
  /** kie credits it reported consuming (creditsConsumed), when it reported them. */
  kieCredits: number;
  byProvider: Record<MediaProviderId, { usd: number; jobs: number; failed: number }>;
  byModel: Record<MediaModelId, { jobs: number; failed: number; credits: number; usd: number }>;
};
const SPEND_FIELDS = ["jobs", "failed", "credits", "usd_micro"] as const;

/** Reads render:_all:{month}:m:{model}:{jobs|failed|credits|usd_micro} for every catalogue model, and kie_centicredits, at once. */
export async function renderSpend(month = monthKey()): Promise<RenderSpend> {
  const k = mk.spend(month);
  const n = async (key: string) => Number((await db.get<number>(key)) ?? 0) || 0;
  const [centi, rows] = await Promise.all([n(`${k}:kie_centicredits`), Promise.all(MEDIA_MODELS.map((m) => Promise.all(SPEND_FIELDS.map((f) => n(`${k}:m:${m.id}:${f}`)))))]);
  const byProvider = { fal: { usd: 0, jobs: 0, failed: 0 }, kie: { usd: 0, jobs: 0, failed: 0 }, higgsfield: { usd: 0, jobs: 0, failed: 0 } } as RenderSpend["byProvider"];
  const byModel = {} as RenderSpend["byModel"];
  // Sums stay in micro-dollars (integers) and are divided once, so the total is exactly the counters' sum.
  const micro: Record<MediaProviderId, number> = { fal: 0, kie: 0, higgsfield: 0 };
  MEDIA_MODELS.forEach((m, i) => {
    const [jobs, failed, credits, usdMicro] = rows[i];
    byModel[m.id] = { jobs, failed, credits, usd: usdMicro / 1e6 };
    const p = byProvider[m.provider];
    p.jobs += jobs; p.failed += failed; micro[m.provider] += usdMicro;
  });
  for (const p of Object.keys(micro) as MediaProviderId[]) byProvider[p].usd = micro[p] / 1e6;
  return { usd: (micro.fal + micro.kie + micro.higgsfield) / 1e6, kieCredits: centi / 100, byProvider, byModel };
}

export async function overview(): Promise<Overview> {
  const emails = await db.smembers("users:all");
  const now = Date.now();
  const users = (await pmap(emails, (e) => getUser(e))).filter((u): u is NonNullable<typeof u> => !!u);
  const ageDays = (iso: string) => (now - new Date(iso).getTime()) / 864e5;
  const brands = new Map<string, boolean>();
  (await pmap(users, (u) => getBrand(u.email))).forEach((b, i) => brands.set(users[i].email, !!b));
  const activated = [...brands.values()].filter(Boolean).length;
  // A suspended account neither pays nor counts towards MRR (docs/Admin_Console_Benchmark.md: MRR over unsuspended users).
  const live = users.filter((u) => !u.suspended);
  const paying = live.filter((u) => u.plan !== "trial").length;
  const trialActive = users.filter((u) => u.plan === "trial" && new Date(u.trialEnds).getTime() > now).length;
  const trialExpired = users.filter((u) => u.plan === "trial" && new Date(u.trialEnds).getTime() <= now).length;
  const planMix: Record<string, number> = {};
  for (const u of users) planMix[u.plan] = (planMix[u.plan] ?? 0) + 1;
  const mrr = live.reduce((s, u) => s + priceOf(u), 0);

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

  // Credits consumed this month across EVERY brand of every account, then model cost from usage totals. This read
  // `listLite(u.email)`, which is the default brand only — an extra brand's tasks live under `email#brandId` — so an
  // agency that spent 10 credits on its default brand and 1,500 across four others showed 10, and the gross margin
  // beside it was computed against a fraction of the real spend.
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).getTime();
  const scopes = (await pmap(users, async (u) => (await listBrands(u.email)).map((b) => scopeFor(u.email, b.id)), 6)).flat();
  const perScope = await pmap(scopes, async (scope) => (await listLite(scope, new Date(monthStart))).reduce((s, t) => s + (TASK_COST[t.type] ?? 1) / (TASK_COUNT[t.type] ?? 1) + (t.mediaCredits ?? (t.image ? IMAGE_COST : 0)), 0), 6);
  const creditsUsed = perScope.reduce((s, x) => s + x, 0);
  const [total, render] = await Promise.all([getUsage("_all"), renderSpend()]);
  // Renders are billed to us like model calls: a video can cost more than a month of text for the same account.
  const grossMargin = mrr > 0 ? Math.round(((mrr - (total.usd + render.usd) * SAR_PER_USD) / mrr) * 100) : null;

  const recent = await pmap([...users].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 25), async (u) => {
    const [last, evs] = await Promise.all([lastActive(u.email), userEvents(u.email)]);
    return { email: u.email, name: u.name, plan: u.plan, credits: u.credits, createdAt: u.createdAt, lastActive: last, activated: brands.get(u.email) ?? false, events: evs };
  }, 8);

  return {
    generatedAt: new Date().toISOString(),
    users: { total: users.length, new1d: users.filter((u) => ageDays(u.createdAt) <= 1).length, new7d: users.filter((u) => ageDays(u.createdAt) <= 7).length, new30d: recentUsers.length, activated, activationRate: users.length ? Math.round((activated / users.length) * 100) : null, paying, trialActive, trialExpired, suspended: users.filter((u) => u.suspended).length },
    engagement: { dau, wau, mau, stickiness: mau ? Math.round((dau / mau) * 100) : null, retention7: cohort.length ? Math.round((retained / cohort.length) * 100) : null },
    funnel: { signups30: recentUsers.length, activated30: recentUsers.filter((u) => brands.get(u.email)).length, generated30, approved30, paid30: recentUsers.filter((u) => u.plan !== "trial").length },
    revenue: { mrrSar: mrr, planMix, arpuSar: paying ? Math.round(mrr / paying) : null, creditsUsedMonth: Math.round(creditsUsed), modelCostUsd: total.usd, grossMarginPct: grossMargin, renderCostUsd: render.usd, renderByProvider: render.byProvider, renderByModel: render.byModel },
    events,
    features,
    health: { errors7d, errorsToday, modelCalls: total.calls, avgCostPerCallUsd: total.calls ? Math.round((total.usd / total.calls) * 1000) / 1000 : null },
    recent,
  };
}

/** Spreadsheet apps run cells that start with = + - @ (or tab / CR) as formulas; user-supplied names must not. */
export const csvSafe = (v: string) => (/^[=+\-@\t\r]/.test(v) && !/^[+-]?\d[\d\s.-]*$/.test(v) ? `'${v}` : v); // plain phone numbers and negative numbers stay as they are

/** One users-export row: the stored account fields the CSV reads (a `User` from `getUser` fits). */
export type CsvUserRow = { email: string; name: string; phone: string; plan: Plan; credits: number; trialEnds: string; createdAt: string; renewedAt?: string; deal?: AgencyDeal | null; seats?: number };

/**
 * The founder's users export. monthly_price_sar = `priceOf`, monthly_credits = `allowanceOf`, seats = `seatLimit`, and
 * deal = "credits@priceSar" for an Agency deal (empty otherwise). Every cell goes through `csvSafe`.
 */
export function usersCsv(rows: CsvUserRow[]) {
  const esc = (v: unknown) => `"${csvSafe(String(v ?? "")).replace(/"/g, '""')}"`;
  const head = ["email", "name", "phone", "plan", "credits", "trial_ends", "created_at", "renewed_at", "monthly_price_sar", "monthly_credits", "seats", "deal"].join(",");
  const deal = (r: CsvUserRow) => (r.deal ? `${r.deal.credits}@${r.deal.priceSar}` : "");
  return [head, ...rows.map((r) => [r.email, r.name, r.phone, r.plan, r.credits, r.trialEnds.slice(0, 10), r.createdAt.slice(0, 10), r.renewedAt ?? "", priceOf(r), allowanceOf(r), seatLimit(r), deal(r)].map(esc).join(","))].join("\n");
}
