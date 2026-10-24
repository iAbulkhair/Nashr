import { db } from "./db";
import { isSuspended } from "./suspension";
import { getUser, type AgencyDeal, type Plan, type User } from "./auth";
import { SAR_PER_USD, allowanceOf, chatAllowanceOf, priceOf, seatLimit } from "./pricing";
import { getBrand, listLite, TASK_COST, TASK_COUNT, IMAGE_COST } from "./brand";
import { getUsage, type ModelUsage } from "./usage";
import { pmap } from "./parallel";
import { listBrands, scopeFor } from "./brands";
import { EVENTS, activeCount, day, dayCount, firstEvent, isoWeek, lastActive, userEvents, type Event } from "./track";
import { monthKey } from "./credits";
import { MEDIA_MODELS, type MediaModelId, type MediaProviderId } from "./media-catalog";
import { mk } from "./media/keys";
import { topupRevenueSar } from "./topups";
import { cronStatuses, type CronStatus } from "./cron-heartbeat";
import { marginView, type MarginView } from "./margin";
import { markFairUse } from "./fair-use";
import { globalKey } from "./keys";
import { acct } from "./account-id";

/**
 * Founder overview: growth, activation, engagement, revenue estimate, health. All from Redis; no external tool. Prices,
 * allowances and seats come from src/lib/pricing.ts (`priceOf`: the list price, or an Agency account's deal price).
 */

export type Overview = {
  generatedAt: string;
  users: { total: number; new1d: number; new7d: number; new30d: number; activated: number; activationRate: number | null; paying: number; trialActive: number; trialExpired: number; suspended: number };
  engagement: { dau: number; wau: number; mau: number; stickiness: number | null; retention7: number | null };
  funnel: { signups30: number; activated30: number; generated30: number; approved30: number; paid30: number };
  /** `topupSarMonth`: what packs paid for this month brought in, SAR excluding VAT (src/lib/topups.ts); never part of MRR. */
  revenue: { mrrSar: number; topupSarMonth: number; planMix: Record<string, number>; arpuSar: number | null; creditsUsedMonth: number; modelCostUsd: number; grossMarginPct: number | null; renderCostUsd: number; renderByProvider: RenderSpend["byProvider"]; renderByModel: RenderSpend["byModel"] };
  events: { date: string; counts: Record<string, number> }[];
  features: Record<string, number>;
  health: { errors7d: number; errorsToday: number; modelCalls: number; avgCostPerCallUsd: number | null };
  /** The last finished run of each cron and whether it is late (src/lib/cron-heartbeat.ts, rule 1014); empty when the store could not be read. */
  crons: CronStatus[];
  /**
   * This month's cost per model and per provider (`getUsage("_all")`, global counters, founder only): calls and USD per catalog
   * model ("other" for any id outside the catalog) and per provider, the requests the gateway failed that were re-sent to
   * Anthropic, and the customer picks the router refused, keyed "{purpose}:{reason}". Only entries with a count.
   */
  modelUsage: { month: string; models: Record<string, ModelUsage>; providers: Record<string, ModelUsage>; fallbacks: number; rejectedPicks: Record<string, number> };
  recent: { email: string; name: string; plan: string; credits: number; createdAt: string; lastActive: string | null; activated: boolean; events: Record<string, number> }[];
  /** Sign-ups that never finished onboarding (rules 1474, 1475): how many, and the newest `STALLED_MAX` of them. */
  stalled: { total: number; rows: Stalled[] };
  /**
   * Rule 1533: this month's paying accounts under the margin floor (src/lib/margin.ts), live, lowest first, and the last
   * daily alert run's counts. Null when the counters could not be read (the rest of the overview still answers).
   */
  margin: MarginView | null;
};

/**
 * A sign-up that stopped before onboarding (rule 1474): the account is at least `STALLED_AFTER_H` hours old, not suspended,
 * and has no brand file. `reason`: `email_unverified` when the address was never proved (the owner may never have seen
 * the code), else `no_brand` (verified, then stopped). Team members are not in `users:all`, so they never show here.
 */
export type Stalled = { email: string; name: string; phone: string; plan: string; createdAt: string; reason: "email_unverified" | "no_brand" };
export const STALLED_AFTER_H = 24;
export const STALLED_MAX = 50;
/** Pure: the stalled sign-ups among `users`, newest first, at most `STALLED_MAX` rows, and how many there are in all. */
export function stalledSignups(users: Pick<User, "email" | "name" | "phone" | "plan" | "createdAt" | "suspended" | "emailVerifiedAt">[], hasBrand: (email: string) => boolean, now: number): { total: number; rows: Stalled[] } {
  const all = users
    .filter((u) => !isSuspended(u) && !hasBrand(u.email) && now - new Date(u.createdAt).getTime() >= STALLED_AFTER_H * 36e5)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return {
    total: all.length,
    rows: all.slice(0, STALLED_MAX).map((u) => ({ email: u.email, name: u.name, phone: u.phone, plan: u.plan, createdAt: u.createdAt, reason: u.emailVerifiedAt ? "no_brand" : "email_unverified" })),
  };
}

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
  const emails = await db.smembers(globalKey.usersAll());
  const now = Date.now();
  const users = (await pmap(emails, (e) => getUser(e))).filter((u): u is NonNullable<typeof u> => !!u);
  const ageDays = (iso: string) => (now - new Date(iso).getTime()) / 864e5;
  const brands = new Map<string, boolean>();
  (await pmap(users, (u) => getBrand(acct(u)))).forEach((b, i) => brands.set(users[i].email, !!b));
  const activated = [...brands.values()].filter(Boolean).length;
  // A suspended account neither pays nor counts towards MRR (docs/Admin_Console_Benchmark.md: MRR over unsuspended users).
  const live = users.filter((u) => !isSuspended(u));
  const paying = live.filter((u) => u.plan !== "trial").length;
  const trialActive = users.filter((u) => u.plan === "trial" && new Date(u.trialEnds).getTime() > now).length;
  const trialExpired = users.filter((u) => u.plan === "trial" && new Date(u.trialEnds).getTime() <= now).length;
  const planMix: Record<string, number> = {};
  for (const u of users) planMix[u.plan] = (planMix[u.plan] ?? 0) + 1;
  const mrr = live.reduce((s, u) => s + priceOf(u), 0);
  // Top-ups are one-off payments, not recurring: shown next to MRR, never added to it (rule 448). Every account counts,
  // suspended or not: the money was received.
  const topupSarMonth = topupRevenueSar(users, monthKey());

  const d = day();
  const [dau, wau, mau] = await Promise.all([activeCount(`active:d:${d}`), activeCount(`active:w:${isoWeek()}`), activeCount(`active:m:${d.slice(0, 7)}`)]);
  // 7-day retention: users who signed up 7-30 days ago and were active this week
  const cohort = users.filter((u) => ageDays(u.createdAt) >= 7 && ageDays(u.createdAt) <= 30);
  const weekSet = new Set(await db.smembers(`active:w:${isoWeek()}`));
  // The active sets hold account ids, as `track` writes them (rule 3821).
  const retained = cohort.filter((u) => weekSet.has(acct(u))).length;

  // funnel over the last 30 days
  const recentUsers = users.filter((u) => ageDays(u.createdAt) <= 30);
  const firsts = await pmap(recentUsers, (u) => Promise.all([firstEvent(acct(u), "generate"), firstEvent(acct(u), "approve")]));
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
  const scopes = (await pmap(users, async (u) => (await listBrands(acct(u))).map((b) => scopeFor(acct(u), b.id)), 6)).flat();
  const perScope = await pmap(scopes, async (scope) => (await listLite(scope, new Date(monthStart))).reduce((s, t) => s + (TASK_COST[t.type] ?? 1) / (TASK_COUNT[t.type] ?? 1) + (t.mediaCredits ?? (t.image ? IMAGE_COST : 0)), 0), 6);
  const creditsUsed = perScope.reduce((s, x) => s + x, 0);
  const [total, render, crons, margin] = await Promise.all([getUsage("_all"), renderSpend(), cronStatuses().catch((): CronStatus[] => []), marginView(users).then((v) => ({ ...v, under: markFairUse(v.under, users, v.month) })).catch(() => null)]);
  // Renders are billed to us like model calls: a video can cost more than a month of text for the same account.
  const grossMargin = mrr > 0 ? Math.round(((mrr - (total.usd + render.usd) * SAR_PER_USD) / mrr) * 100) : null;

  const recent = await pmap([...users].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 25), async (u) => {
    const [last, evs] = await Promise.all([lastActive(u.email), userEvents(acct(u))]);
    return { email: u.email, name: u.name, plan: u.plan, credits: u.credits, createdAt: u.createdAt, lastActive: last, activated: brands.get(u.email) ?? false, events: evs };
  }, 8);

  return {
    stalled: stalledSignups(users, (e) => brands.get(e) ?? false, now),
    margin,
    generatedAt: new Date().toISOString(),
    users: { total: users.length, new1d: users.filter((u) => ageDays(u.createdAt) <= 1).length, new7d: users.filter((u) => ageDays(u.createdAt) <= 7).length, new30d: recentUsers.length, activated, activationRate: users.length ? Math.round((activated / users.length) * 100) : null, paying, trialActive, trialExpired, suspended: users.filter((u) => isSuspended(u)).length },
    engagement: { dau, wau, mau, stickiness: mau ? Math.round((dau / mau) * 100) : null, retention7: cohort.length ? Math.round((retained / cohort.length) * 100) : null },
    funnel: { signups30: recentUsers.length, activated30: recentUsers.filter((u) => brands.get(u.email)).length, generated30, approved30, paid30: recentUsers.filter((u) => u.plan !== "trial").length },
    revenue: { mrrSar: mrr, topupSarMonth, planMix, arpuSar: paying ? Math.round(mrr / paying) : null, creditsUsedMonth: Math.round(creditsUsed), modelCostUsd: total.usd, grossMarginPct: grossMargin, renderCostUsd: render.usd, renderByProvider: render.byProvider, renderByModel: render.byModel },
    events,
    features,
    crons,
    health: { errors7d, errorsToday, modelCalls: total.calls, avgCostPerCallUsd: total.calls ? Math.round((total.usd / total.calls) * 1000) / 1000 : null },
    modelUsage: { month: total.month, models: total.models, providers: total.providers, fallbacks: total.fallbacks, rejectedPicks: total.rejectedPicks },
    recent,
  };
}

/** Spreadsheet apps run cells that start with = + - @ (or tab / CR) as formulas; user-supplied names must not. */
export const csvSafe = (v: string) => (/^[=+\-@\t\r]/.test(v) && !/^[+-]?\d[\d\s.-]*$/.test(v) ? `'${v}` : v); // plain phone numbers and negative numbers stay as they are

/** One users-export row: the stored account fields the CSV reads (a `User` from `getUser` fits). */
export type CsvUserRow = { email: string; name: string; phone: string; plan: Plan; credits: number; trialEnds: string; createdAt: string; renewedAt?: string; deal?: AgencyDeal | null; seats?: number; chatAllowance?: number };

/**
 * The founder's users export. monthly_price_sar = `priceOf`, monthly_credits = `allowanceOf`, chat_allowance =
 * `chatAllowanceOf` (the founder override, else the plan's messages: per month, or for the whole trial), seats =
 * `seatLimit`, and deal = "credits@priceSar" for an Agency deal (empty otherwise). Every cell goes through `csvSafe`.
 */
export function usersCsv(rows: CsvUserRow[]) {
  const esc = (v: unknown) => `"${csvSafe(String(v ?? "")).replace(/"/g, '""')}"`;
  const head = ["email", "name", "phone", "plan", "credits", "trial_ends", "created_at", "renewed_at", "monthly_price_sar", "monthly_credits", "chat_allowance", "seats", "deal"].join(",");
  const deal = (r: CsvUserRow) => (r.deal ? `${r.deal.credits}@${r.deal.priceSar}` : "");
  return [head, ...rows.map((r) => [r.email, r.name, r.phone, r.plan, r.credits, r.trialEnds.slice(0, 10), r.createdAt.slice(0, 10), r.renewedAt ?? "", priceOf(r), allowanceOf(r), chatAllowanceOf(r), seatLimit(r), deal(r)].map(esc).join(","))].join("\n");
}

/**
 * What one chat message cost this month, for the founder console (rule 316): the month's chat model cost over every
 * message the account sent, inside the allowance and past it on credits. Inside, the RAW count (`ChatStatus.counted`),
 * never `used`: `used` is clamped to the allowance, so after the founder lowered it mid-month (400 sent, now 100
 * allowed) dividing by `used` would show four times the real cost. Null when nothing was sent, never a division by 0;
 * rounded to 1/100 of a cent. On a trial `counted` is the whole trial's while the cost is this month's, so across a
 * month boundary it reads low.
 */
export function chatUsdPerMessage(chatUsd: number, s: { counted: number; overflow: { used: number } }): number | null {
  const n = Math.max(0, s.counted) + Math.max(0, s.overflow.used);
  const usd = Number.isFinite(chatUsd) ? Math.max(0, chatUsd) : 0;
  return n > 0 ? Math.round((usd / n) * 1e4) / 1e4 : null;
}
