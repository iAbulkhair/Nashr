/**
 * The single plan table: every plan's list price, monthly credits and seats, the Agency deal floor, the 60% margin
 * floor and the credits an added brand's onboarding costs. No other file may hold a price, an allowance, a seat count
 * or a floor: the pricing page, the billing page, the founder console, renewals, MRR and the floor test all read them
 * from here (docs/superpowers/specs/2026-09-29-pricing-design.md).
 *
 * This module imports NOTHING on purpose. Client components (the pricing page, the start wizard, the brands panel),
 * i18n.ts, app-i18n.ts, help.ts, site.ts and the pages-*.ts copy read it, so an import here would carry whatever it
 * pulls into the browser bundle (tests/client-bundle.test.ts, rule 249). auth.ts re-exports Plan, AgencyDeal, PLANS,
 * isPlan, PLAN_CREDITS, PLAN_SEATS and seatLimit, so existing `@/lib/auth` imports keep working.
 *
 * Pinned by tests/pricing.test.ts (rules 242-244: the tables, the account helpers, renewal and the deal floor) and
 * tests/pricing-floor.test.ts (rule 241: every task type, priced by src/lib/task-costs.ts, stays under the margin floor).
 */

export type Plan = "trial" | "starter" | "pro" | "business" | "agency";
/** Plans with a fixed allowance, price and seat count. Agency is priced by its deal. */
export type FixedPlan = Exclude<Plan, "agency">;
/** "starter" | "pro" | "business": a list price and a pay link. */
export type SelfServePlan = Exclude<FixedPlan, "trial">;
/** The pricing page's cards, in order. */
export type PublicTier = SelfServePlan | "agency";

/** Every plan an account can be on. Never "enterprise": that retired name is mapped to "agency" on read (`planFromStore`). */
export const PLANS: readonly Plan[] = ["trial", "starter", "pro", "business", "agency"];
export const SELF_SERVE_PLANS: readonly SelfServePlan[] = ["starter", "pro", "business"];
export const PUBLIC_TIERS: readonly PublicTier[] = ["starter", "pro", "business", "agency"];
/** Membership test for a plan name from a request body. Not `in`: that walks the prototype chain (see `isTaskType`). */
export const isPlan = (v: unknown): v is Plan => typeof v === "string" && (PLANS as readonly string[]).includes(v);
/**
 * A stored plan value as the runtime plan: "enterprise" (retired) reads as "agency"; any other unknown value reads as
 * "trial", which fails closed (a trial is never renewed and never counted as paying). Used by `getUser`, the only
 * reader of `user:{email}`; the next locked save writes the mapped value back.
 */
export const planFromStore = (v: unknown): Plan => (v === "enterprise" ? "agency" : isPlan(v) ? v : "trial");

// Keyed by FixedPlan on purpose: `PLAN_CREDITS[u.plan]` does not compile for a `Plan`, which forces every caller
// through allowanceOf / priceOf / seatLimit, the helpers that know what an Agency account gets.
/** Monthly list price in SAR, excluding VAT (the site's wording, pending the accountant: see PRICES_INCLUDE_VAT). */
export const PLAN_PRICE_SAR: Readonly<Record<FixedPlan, number>> = { trial: 0, starter: 299, pro: 499, business: 999 };
/** Credits granted each month (unused credits do not roll over). The trial's are granted once, at signup. */
export const PLAN_CREDITS: Readonly<Record<FixedPlan, number>> = { trial: 50, starter: 300, pro: 700, business: 1500 };
/** Seats per plan, the owner included (docs/superpowers/specs/2026-09-29-teams-design.md §5). `User.seats` overrides. */
export const PLAN_SEATS: Readonly<Record<FixedPlan, number>> = { trial: 3, starter: 1, pro: 3, business: 7 };
/** Upper bound of a founder seat override: it only guards against a typo. */
export const MAX_SEAT_OVERRIDE = 500;

/**
 * An Agency contract. Written only by POST /api/admin/plan (the founder console) under `withUserLock`, never taken from
 * any other request. A deal's seats live in `User.seats` (one seat source), not here.
 */
export type AgencyDeal = { credits: number; priceSar: number; setAt: string; setBy: string };
export type DealInput = Pick<AgencyDeal, "credits" | "priceSar">;
/** The least a deal may be: the Business plan's price and credits, so a deal is never cheaper per credit than Business. */
export const AGENCY_MIN: Readonly<DealInput> = { priceSar: PLAN_PRICE_SAR.business, credits: PLAN_CREDITS.business };
export const MAX_DEAL_CREDITS = 100_000;
export const MAX_DEAL_PRICE_SAR = 1_000_000;

const inRange = (n: unknown, min: number, max: number): n is number => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;

/**
 * True when a deal is at or above the Business rate: both integers, priceSar >= 999, credits >= 1500, within the MAX
 * bounds, and priceSar × 1500 >= credits × 999. Integer cross-multiplication on purpose: a rounded 0.67 SAR-per-credit
 * literal would refuse a deal at exactly the Business rate.
 */
export function dealRespectsFloor(priceSar: number, credits: number): boolean {
  return (
    inRange(priceSar, AGENCY_MIN.priceSar, MAX_DEAL_PRICE_SAR) &&
    inRange(credits, AGENCY_MIN.credits, MAX_DEAL_CREDITS) &&
    priceSar * AGENCY_MIN.credits >= credits * AGENCY_MIN.priceSar
  );
}

/**
 * Parse a deal from a request body. Not a plain object, a value that is not an integer, or one outside 1..MAX →
 * "bad_deal"; a well-formed deal below the Business rate → "below_floor". Only `credits` and `priceSar` are read.
 * `null` (clear the deal) is the caller's to handle before calling this: here it is "bad_deal".
 */
export function parseDeal(raw: unknown): { ok: true; deal: DealInput } | { ok: false; error: "bad_deal" | "below_floor" } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "bad_deal" };
  const { credits, priceSar } = raw as Record<string, unknown>;
  if (!inRange(credits, 1, MAX_DEAL_CREDITS) || !inRange(priceSar, 1, MAX_DEAL_PRICE_SAR)) return { ok: false, error: "bad_deal" };
  if (!dealRespectsFloor(priceSar, credits)) return { ok: false, error: "below_floor" };
  return { ok: true, deal: { credits, priceSar } };
}

const own = (o: object, k: unknown): boolean => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const isFixedPlan = (v: unknown): v is FixedPlan => own(PLAN_CREDITS, v);
/** "agency", or the retired "enterprise" on a record that did not come through `getUser`. */
const isAgency = (v: unknown): boolean => v === "agency" || v === "enterprise";
/** A stored deal counts only while it still respects the floor; anything else falls back to Business. */
const validDeal = (d: unknown): d is AgencyDeal =>
  typeof d === "object" && d !== null && dealRespectsFloor((d as AgencyDeal).priceSar, (d as AgencyDeal).credits);

type PlanOf = { plan: Plan; deal?: AgencyDeal | null };

/**
 * Monthly allowance. Fixed plans: PLAN_CREDITS[plan]. Agency: the deal's credits when the deal respects the floor, else
 * Business's 1,500. An unknown plan grants nothing (0), never NaN.
 */
export function allowanceOf(u: PlanOf): number {
  if (isAgency(u.plan)) return validDeal(u.deal) ? u.deal.credits : PLAN_CREDITS.business;
  return isFixedPlan(u.plan) ? PLAN_CREDITS[u.plan] : 0;
}

/**
 * Monthly list price in SAR (MRR, margin, the users CSV). Fixed plans: PLAN_PRICE_SAR[plan]. Agency: the deal's price
 * when the deal respects the floor, else Business's 999. An unknown plan counts as 0.
 */
export function priceOf(u: PlanOf): number {
  if (isAgency(u.plan)) return validDeal(u.deal) ? u.deal.priceSar : PLAN_PRICE_SAR.business;
  return isFixedPlan(u.plan) ? PLAN_PRICE_SAR[u.plan] : 0;
}

/**
 * The account's seat limit, owner included: the founder override when it is a positive number (floored); then Agency
 * → Business's 7; a fixed plan → PLAN_SEATS[plan]; anything else → 1.
 */
export function seatLimit(u: { plan: Plan; seats?: number }): number {
  if (typeof u.seats === "number" && Number.isFinite(u.seats) && u.seats >= 1) return Math.floor(u.seats);
  if (isAgency(u.plan)) return PLAN_SEATS.business;
  return isFixedPlan(u.plan) ? PLAN_SEATS[u.plan] : 1;
}

// ---- The margin floor (rule 241, tests/pricing-floor.test.ts) ----

export const SAR_PER_USD = 3.75;
export const VAT_RATE = 0.15;
/**
 * false while the site says prices exclude VAT (pending the accountant). true makes the floor use price ÷ 1.15, which
 * lowers the ceiling from $0.0710 to $0.0618 per credit and fails the tightest types. Never rendered.
 */
export const PRICES_INCLUDE_VAT = false;
/** At least 60% of the cheapest self-serve credit is margin: what one credit may cost us is at most 40% of it. */
export const MARGIN_FLOOR = 0.6;

type Prices = Readonly<Record<SelfServePlan, number>>;

/** A list price net of VAT when prices include it. */
export function netPriceSar(listSar: number, includesVat: boolean = PRICES_INCLUDE_VAT): number {
  return includesVat ? listSar / (1 + VAT_RATE) : listSar;
}

/** USD one credit brings in on a self-serve plan: net price ÷ SAR_PER_USD ÷ credits. */
export function creditRevenueUsd(plan: SelfServePlan, prices: Prices = PLAN_PRICE_SAR, credits: Prices = PLAN_CREDITS, includesVat: boolean = PRICES_INCLUDE_VAT): number {
  return netPriceSar(prices[plan], includesVat) / SAR_PER_USD / credits[plan];
}

/** The cheapest self-serve credit in USD: min over SELF_SERVE_PLANS of creditRevenueUsd (Business, ≈ $0.1776, today). */
export function cheapestCreditUsd(prices: Prices = PLAN_PRICE_SAR, credits: Prices = PLAN_CREDITS, includesVat: boolean = PRICES_INCLUDE_VAT): number {
  return Math.min(...SELF_SERVE_PLANS.map((p) => creditRevenueUsd(p, prices, credits, includesVat)));
}

/** The most one credit may cost us: (1 − MARGIN_FLOOR) × cheapestCreditUsd() ≈ $0.07104 today ($0.0618 VAT-inclusive). */
export function maxCostPerCreditUsd(prices: Prices = PLAN_PRICE_SAR, credits: Prices = PLAN_CREDITS, includesVat: boolean = PRICES_INCLUDE_VAT): number {
  return (1 - MARGIN_FLOOR) * cheapestCreditUsd(prices, credits, includesVat);
}

// ---- Brands (rules 245-247) ----

/**
 * Credits to onboard a second or later brand (any scope but the default). The first brand is free. Shown before the
 * owner confirms, charged before the model runs, refunded when the brand is not saved. Covers a typical ≈ $0.57 run at
 * the floor (tests/pricing-floor.test.ts).
 */
export const ONBOARD_EXTRA_BRAND_COST = 9;
export const onboardCost = (brandId: string | undefined): number => ((brandId ?? "default") === "default" ? 0 : ONBOARD_EXTRA_BRAND_COST);

/**
 * "1,500": Latin digits with a comma, the site's style in both languages. Not a locale formatter: those are reserved
 * for dates (tests/date-locale.test.ts), and the output must be the same on the server and in every browser.
 */
export const formatCount = (n: number): string => {
  const [whole, frac] = String(n).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
};
