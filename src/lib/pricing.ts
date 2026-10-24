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

// ---- Yearly billing (rules 3530-3549, flows.md section 108) ----

/** How often a self-serve plan is charged. A stored record without one is monthly (`readInterval`). */
export type BillingInterval = "month" | "year";
export const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];
/** Calendar months one paid period of each interval covers: `paidThrough` moves by this much per payment. */
export const INTERVAL_MONTHS: Readonly<Record<BillingInterval, number>> = { month: 1, year: 12 };
/**
 * An interval from a request body or a stored record: absent (undefined or null) reads as "month", the only interval that
 * existed before rule 3530, so an old subscription or intent is monthly; "month" and "year" read as themselves; anything
 * else is null, which every caller refuses (never guessed).
 */
export const readInterval = (v: unknown): BillingInterval | null =>
  v === undefined || v === null || v === "month" ? "month" : v === "year" ? "year" : null;

/*
 * >>> FOUNDER: FILL IN THE YEARLY PRICES HERE. <<<
 *
 * The yearly list price per self-serve plan, in whole SAR excluding VAT (like PLAN_PRICE_SAR), or null for "yearly is not
 * offered for this plan". Set 2026-10-24 by the founder: 2 months free on every plan (2,990 / 4,990 / 9,990 SAR a year,
 * rule 4035). That moved the cheapest credit to Business yearly ($0.148) and the ceiling to $0.0592, so the social and ads
 * chat drafts have a 2-credit minimum, an X refresh costs 2 credits and the chat hold rose (rules 4030-4039, task-costs.ts
 * `DRAFT_MIN_CREDITS`). With every entry null, nothing changes anywhere:
 * the pricing page shows no monthly/yearly switch, the billing page shows no yearly button, and the checkout refuses
 * `interval: "year"` (409 `yearly_not_offered`). Set EITHER the price (PLAN_YEARLY_PRICE_SAR) OR the months free
 * (PLAN_YEARLY_MONTHS_FREE) for a plan, never both: a plan with both is refused as not offered, so a typo never sells.
 * A price must be a whole number from 1 to 12 × the monthly price. Months free must be a whole number from 0 to
 * MAX_YEARLY_MONTHS_FREE; the yearly price is then the monthly price × (12 − months free). There is no default discount.
 * Setting one tightens the margin floor (`cheapestCreditUsd` counts the yearly credit) and makes tests/yearly-pricing.test.ts
 * rule 3530 fail on purpose: update that test in the same commit.
 */
export const PLAN_YEARLY_PRICE_SAR: Readonly<Record<SelfServePlan, number | null>> = { starter: null, pro: null, business: null };
/** The alternative input: months of the year given free. Null = not set. Read the FOUNDER note above. */
export const PLAN_YEARLY_MONTHS_FREE: Readonly<Record<SelfServePlan, number | null>> = { starter: 2, pro: 2, business: 2 };
/** The most months free a yearly price may give: only a guard against a typo, never a default. */
export const MAX_YEARLY_MONTHS_FREE = 6;

/**
 * The plan's yearly list price in SAR excluding VAT, or null when yearly is not offered for it: the founder's price, else
 * the monthly price × (12 − the founder's months free). Null for both set, a value that is not a whole number in range, a
 * price above twelve months, or a plan that is not self-serve. Every yearly amount on a page, at checkout and in a
 * renewal comes from here.
 */
export function yearlyPriceSar(plan: unknown): number | null {
  if (typeof plan !== "string" || !(SELF_SERVE_PLANS as readonly string[]).includes(plan)) return null;
  const p = plan as SelfServePlan;
  const set = PLAN_YEARLY_PRICE_SAR[p];
  const free = PLAN_YEARLY_MONTHS_FREE[p];
  if (set !== null && free !== null) return null;
  const max = PLAN_PRICE_SAR[p] * 12;
  if (set !== null) return Number.isSafeInteger(set) && set >= 1 && set <= max ? set : null;
  if (free !== null) return Number.isSafeInteger(free) && free >= 0 && free <= MAX_YEARLY_MONTHS_FREE ? PLAN_PRICE_SAR[p] * (12 - free) : null;
  return null;
}

/** Yearly billing is offered for this plan (its yearly price is set and valid). */
export const yearlyOffered = (plan: unknown): boolean => yearlyPriceSar(plan) !== null;
/** Any self-serve plan offers yearly: only then does the pricing page draw the monthly/yearly switch. */
export const anyYearlyOffered = (): boolean => SELF_SERVE_PLANS.some(yearlyOffered);

/** The list price of one period of `interval`, in SAR excluding VAT; null when that interval is not offered for the plan. */
export function intervalPriceSar(plan: SelfServePlan, interval: BillingInterval): number | null {
  return interval === "year" ? yearlyPriceSar(plan) : PLAN_PRICE_SAR[plan];
}

/**
 * A yearly price shown per month: the yearly price ÷ 12, rounded to the halala (2,990 → 249.17). Display only: nothing is
 * charged monthly on a yearly plan. Null when yearly is not offered.
 */
export function yearlyPerMonthSar(plan: unknown): number | null {
  const y = yearlyPriceSar(plan);
  return y === null ? null : Math.round((y * 100) / 12) / 100;
}
/** Credits granted each month (unused credits do not roll over). The trial's are granted once, at signup. */
export const PLAN_CREDITS: Readonly<Record<FixedPlan, number>> = { trial: 50, starter: 300, pro: 700, business: 1500 };
/** Seats per plan, the owner included (docs/superpowers/specs/2026-09-29-teams-design.md §5). `User.seats` overrides. */
export const PLAN_SEATS: Readonly<Record<FixedPlan, number>> = { trial: 3, starter: 1, pro: 3, business: 7 };
/** Upper bound of a founder seat override: it only guards against a typo. */
export const MAX_SEAT_OVERRIDE = 500;
/**
 * Active brands per plan, the default brand included (founder decision 2026-10-09, spec
 * docs/superpowers/specs/2026-10-09-admin-shell-and-brand-workspaces-design.md part B, rules 1390-1394). Archived brands
 * do not count. Agency starts at AGENCY_BRANDS and the founder sets the number per account (`User.brandCap`).
 */
export const PLAN_BRANDS: Readonly<Record<FixedPlan, number>> = { trial: 1, starter: 1, pro: 2, business: 5 };
export const AGENCY_BRANDS = 10;
/** Bounds of a founder brand override (`User.brandCap`): a whole number from 1 to 200. */
export const MAX_BRAND_CAP = 200;
export const isBrandCap = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_BRAND_CAP;

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

/** `billing.interval` is read by `priceOf` only (rule 3537); a record without it is monthly. */
type PlanOf = { plan: Plan; deal?: AgencyDeal | null; billing?: { interval?: unknown } | null };

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
 * when the deal respects the floor, else Business's 999. An unknown plan counts as 0. A yearly online subscription
 * (`billing.interval` "year", rule 3537) counts its yearly price per month (`yearlyPerMonthSar`) while that price is set.
 */
export function priceOf(u: PlanOf): number {
  if (isAgency(u.plan)) return validDeal(u.deal) ? u.deal.priceSar : PLAN_PRICE_SAR.business;
  if (!isFixedPlan(u.plan)) return 0;
  if (readInterval(u.billing?.interval) === "year") {
    const perMonth = yearlyPerMonthSar(u.plan);
    if (perMonth !== null) return perMonth;
  }
  return PLAN_PRICE_SAR[u.plan];
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

/**
 * How many brands the account may have active (rule 1390): the founder override when it is a valid cap (1-200), then
 * Agency → AGENCY_BRANDS; a fixed plan → PLAN_BRANDS[plan]; anything else → 1. A stored override out of range is
 * ignored, never trusted.
 */
export function brandCapFor(u: { plan: Plan; brandCap?: number }): number {
  if (isBrandCap(u.brandCap)) return u.brandCap;
  if (isAgency(u.plan)) return AGENCY_BRANDS;
  return isFixedPlan(u.plan) ? PLAN_BRANDS[u.plan] : 1;
}

/**
 * The cheapest public plan whose monthly credits cover `credits` (Razan's calculator on /pricing, rule 1885): the
 * self-serve plans in price order, then "agency" for anything above Business (an Agency deal starts at AGENCY_MIN and is
 * sized by contract). Zero, a negative number or NaN needs no plan and reads as the cheapest, Starter.
 */
export function smallestPlanFor(credits: number): PublicTier {
  const need = Number.isFinite(credits) ? credits : 0;
  const byPrice = [...SELF_SERVE_PLANS].sort((a, b) => PLAN_PRICE_SAR[a] - PLAN_PRICE_SAR[b]);
  return byPrice.find((p) => PLAN_CREDITS[p] >= need) ?? "agency";
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

type YearlyPrices = Readonly<Record<SelfServePlan, number | null>>;
/** Each self-serve plan's yearly price as offered now (`yearlyPriceSar`), null where yearly is not offered. */
export const yearlyPrices = (): YearlyPrices => ({ starter: yearlyPriceSar("starter"), pro: yearlyPriceSar("pro"), business: yearlyPriceSar("business") });

/**
 * The cheapest self-serve credit in USD: min over SELF_SERVE_PLANS of creditRevenueUsd (Business, ≈ $0.1776, today). A
 * plan with a yearly price also counts its yearly credit, the yearly net price ÷ 12 ÷ its monthly credits (rule 3538), so
 * a yearly discount lowers the floor instead of slipping under it. With no yearly price set this is unchanged.
 */
export function cheapestCreditUsd(prices: Prices = PLAN_PRICE_SAR, credits: Prices = PLAN_CREDITS, includesVat: boolean = PRICES_INCLUDE_VAT, yearly: YearlyPrices = yearlyPrices()): number {
  return Math.min(...SELF_SERVE_PLANS.flatMap((p) => {
    const monthly = creditRevenueUsd(p, prices, credits, includesVat);
    const y = yearly[p];
    return y === null ? [monthly] : [monthly, netPriceSar(y, includesVat) / 12 / SAR_PER_USD / credits[p]];
  }));
}

/** The most one credit may cost us: (1 − MARGIN_FLOOR) × cheapestCreditUsd() ≈ $0.07104 today ($0.0618 VAT-inclusive). */
export function maxCostPerCreditUsd(prices: Prices = PLAN_PRICE_SAR, credits: Prices = PLAN_CREDITS, includesVat: boolean = PRICES_INCLUDE_VAT, yearly: YearlyPrices = yearlyPrices()): number {
  return (1 - MARGIN_FLOOR) * cheapestCreditUsd(prices, credits, includesVat, yearly);
}

// ---- Chat (pricing phase 2, rules 308-316) ----

/**
 * Chat messages per plan (spec section 2, founder decision 2026-09-29). A message is one turn the owner sends, however
 * many model calls and tools it takes; a turn that failed or never reached the model is not counted. Paid plans get this
 * many every UTC calendar month; the trial's are granted once for the whole trial. Shared by every seat and brand of the
 * account (teams spec section 5). Generation from chat keeps charging credits as before: this is the conversation only.
 */
export const CHAT_ALLOWANCE: Readonly<Record<FixedPlan, number>> = { trial: 30, starter: 250, pro: 650, business: 1300 };
/** Upper bound of a founder chat override (`User.chatAllowance`): it only guards against a typo. */
export const MAX_CHAT_OVERRIDE = 100_000;

/** A founder override is a whole number from 0 (chat stopped for this account) to MAX_CHAT_OVERRIDE. */
export const isChatOverride = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_CHAT_OVERRIDE;

/**
 * The account's chat messages for the period: the founder override when it is valid (an Agency deal's chat allowance
 * goes there, as a deal's seats go through `User.seats`); then Agency → Business's 1,300; a fixed plan → CHAT_ALLOWANCE;
 * anything else → 0, never NaN.
 */
export function chatAllowanceOf(u: { plan: Plan; chatAllowance?: number }): number {
  if (isChatOverride(u.chatAllowance)) return u.chatAllowance;
  if (isAgency(u.plan)) return CHAT_ALLOWANCE.business;
  return isFixedPlan(u.plan) ? CHAT_ALLOWANCE[u.plan] : 0;
}

/**
 * The most one chat message may cost us in model calls, in USD. Checked in code before every model call of a turn
 * (src/lib/chat-budget.ts): a call's output is capped to what is left, and the tool loop ends when too little is left for
 * a useful answer. Without it a turn could make five calls of 8,000 output tokens (≈ $1+ on Opus).
 *
 * $0.35 on Opus 5 (founder decision 2026-10-01); $0.14 since chat moved to Sonnet 5.5 (founder decision 2026-10-02).
 * Sonnet 5.5's rates are Opus 5's divided by 2.5 and so is this ceiling, so a message gets the same tokens as before and
 * the worst full allowance costs 2.5 times less (docs/system/costs.md section 4.1). `chatOverflowHold()` follows: 3 since
 * yearly billing lowered the ceiling to $0.0592 (2 before, rule 4033).
 */
export const CHAT_TURN_MAX_USD = 0.14;

/**
 * The most a message past the allowance can cost the owner, when they turned "continue on credits" on: the ceiling above
 * at the floor rate, rounded up (3 today, 2 before yearly billing at 2 months free, rule 4033). The balance must cover it before the turn (nothing is taken then); after the
 * reply the message is billed its metered cost at the floor rate, never more than this (src/lib/credits.ts
 * `settleChatOverflow`). `ceilingUsd` is a chat model's own ceiling when it is not the default's (src/lib/models/credits.ts
 * `chatHoldFor`: Opus 5.5's $0.28 gives 5); without it, the default chat model's.
 */
export const chatOverflowHold = (maxCostUsd: number = maxCostPerCreditUsd(), ceilingUsd: number = CHAT_TURN_MAX_USD): number => Math.ceil(ceilingUsd / maxCostUsd);

// ---- Brands (rules 245-247) ----

/**
 * Credits to onboard a second or later brand (any scope but the default). The first brand is free. Shown before the
 * owner confirms, charged before the model runs, refunded when the brand is not saved. Covers a typical ≈ $0.57 run at
 * the floor (tests/pricing-floor.test.ts).
 */
export const ONBOARD_EXTRA_BRAND_COST = 9;
export const onboardCost = (brandId: string | undefined): number => ((brandId ?? "default") === "default" ? 0 : ONBOARD_EXTRA_BRAND_COST);

// ---- Top-ups (spec section 6 rule 5, rules 440-459) ----

/**
 * The credit packs an owner can buy on top of the plan (founder decision 2026-10-01): 1 SAR a credit excluding VAT, packs
 * of 100 / 300 / 1,000, valid 90 days from activation, spent only after the month's plan credits (src/lib/topups.ts). No
 * payment gateway yet: the billing page opens WhatsApp support and the founder console activates the pack by hand
 * (POST /api/admin/topups). Every page, the console and tests/topups.test.ts read the packs from here.
 */
export const TOPUP_SAR_PER_CREDIT = 1;
export const TOPUP_PACKS: readonly number[] = [100, 300, 1000];
/** Days a pack's credits stay valid, counted from the moment the founder activates it. */
export const TOPUP_VALID_DAYS = 90;
/** A pack size from a request body: one of TOPUP_PACKS exactly. */
export const isTopupPack = (v: unknown): v is number => typeof v === "number" && TOPUP_PACKS.includes(v);
/** A pack's list price in SAR, excluding VAT. */
export const topupPriceSar = (credits: number): number => credits * TOPUP_SAR_PER_CREDIT;
/** Who may buy a pack: every paid plan, Agency included. A trial sees the packs as available after subscribing. */
export const topupsSold = (plan: Plan): boolean => plan !== "trial";

/**
 * "1,500": Latin digits with a comma, the site's style in both languages. Not a locale formatter: those are reserved
 * for dates (tests/date-locale.test.ts), and the output must be the same on the server and in every browser.
 */
export const formatCount = (n: number): string => {
  const [whole, frac] = String(n).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
};

// ---- The first-month discount (rules 393-395, src/lib/partners.ts) ----

/**
 * One 15% discount on the first paid month per account: from a partner's code, or the offer on the trial's last day.
 * Never both, never a second month (docs/superpowers/specs/2026-10-01-affiliates-design.md).
 */
export const FIRST_MONTH_DISCOUNT_PCT = 15;
/**
 * The first month's price after the discount, in whole riyals and excluding VAT like every price here: the list price
 * less 15%, rounded to the nearest riyal (Starter 254.15 → 254). The discount is taken before VAT, and VAT is then
 * computed on this discounted price (the founder's decision of 2026-10-01, rule 409). Payments are activated by hand,
 * so this is the amount the billing page quotes on WhatsApp (plus VAT) and the founder console expects.
 */
export const firstMonthPriceSar = (plan: SelfServePlan): number => Math.round((PLAN_PRICE_SAR[plan] * (100 - FIRST_MONTH_DISCOUNT_PCT)) / 100);

// ---- Meeting follow-up (Reem B2b, rules 604-606, src/lib/secretary-meeting.ts `proposeFromText`) ----

/**
 * Credits one transcript run costs: one extraction call over up to MEETING_TEXT_MAX characters. 1 while its estimate stays
 * under `maxCostPerCreditUsd()` (tests/pricing-floor.test.ts, `meetingExtractUsd`); 2 if it ever does not. Typed notes
 * (up to MEETING_NOTES_MAX characters) are free, limited to 20 a day.
 */
export const MEETING_TRANSCRIPT_COST = 1;
/** The longest transcript, in characters (about 7,000 Arabic words). Longer is refused before anything is charged. */
export const MEETING_TEXT_MAX = 40_000;
/** The longest typed notes, in characters. */
export const MEETING_NOTES_MAX = 4_000;
