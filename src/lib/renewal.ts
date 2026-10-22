import { addMonths, billingLocked, type Billing } from "./billing-state";
import { handPlanEnded, type HandPlan } from "./hand-plan";

/**
 * When a paid plan's monthly allowance renews (rule 2936, money review F2, founder decision 2026-10-22): on the plan's own
 * paid-period day, not on the 1st. Before, a plan set on the 20th got its allowance that day and again on the 1st, eleven
 * days later. Pure (Riyadh days, YYYY-MM-DD), so `src/lib/credits.ts`, the entitlement view and the billing page share it.
 *
 * The day of the month (`renewDay`): a Paymob subscription's own `billing.anchor`; else `renewAnchor`, the day the founder
 * set the plan by hand; else the day of a hand plan's paid-through day; else the 1st (the old calendar month).
 *
 * A new period's allowance comes only once that period is paid: its first day must be before the paid-through day
 * (`billing.paidThrough`, the day the next charge is due; `handPlan.paidThrough`, the last day paid). A plan with neither
 * (set by hand before paid-through days existed) renews every month as before.
 *
 * Stored shape, an expand (rule 679): `renewedOn` (the Riyadh day of the last renewal) and `renewAnchor` are new and
 * optional; `renewedAt` (YYYY-MM) is still written beside them, so old code reads a renewal this month as before. A record
 * with only `renewedAt` (the old calendar rule renewed it on or after that month's 1st) counts from the plan's last day on
 * or before that 1st: the 1st itself for a plan with no day of its own (unchanged), else the day in the month before. So
 * no period goes without an allowance; a plan whose day has passed this month renews once more on the first request after
 * the release, the refill the old rule would have given on the next 1st. Stable: it does not move with today.
 * Contract step (a later release): once every paid record has `renewedOn`, the `renewedAt` reading may go.
 */
export type RenewalRecord = {
  plan?: string;
  createdAt: string;
  renewedAt?: string;
  renewedOn?: string;
  renewAnchor?: number;
  billing?: Billing;
  handPlan?: HandPlan;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const monthDay = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 31;

/** The day of the month this plan's allowance renews on (1-31; a short month uses its last day). */
export function renewDay(u: RenewalRecord): number {
  if (u.billing && monthDay(u.billing.anchor)) return u.billing.anchor;
  if (monthDay(u.renewAnchor)) return u.renewAnchor;
  const p = u.handPlan?.paidThrough;
  return typeof p === "string" && DAY.test(p) ? Number(p.slice(8, 10)) : 1;
}

/** The Riyadh day of the last renewal (or the plan's start), read from `renewedOn` or, on the old shape, from `renewedAt`. */
export function lastRenewal(u: RenewalRecord, today: string): string {
  if (typeof u.renewedOn === "string" && DAY.test(u.renewedOn)) return u.renewedOn;
  const day = renewDay(u);
  const created = String(u.createdAt ?? "").slice(0, 7);
  const month = typeof u.renewedAt === "string" && MONTH.test(u.renewedAt) ? u.renewedAt : MONTH.test(created) ? created : today.slice(0, 7);
  const first = `${month}-01`;
  const on = addMonths(first, 0, day);
  return on > first ? addMonths(on, -1, day) : on;
}

/** The Riyadh day the next allowance is due. */
export const nextRenewal = (u: RenewalRecord, today: string): string => addMonths(lastRenewal(u, today), 1, renewDay(u));

/** The paid-through day that bounds the next period, or null for a plan with no end (the old hand-set shape). */
const paidUntil = (u: RenewalRecord): string | null => (u.billing ? u.billing.paidThrough : u.handPlan?.paidThrough ?? null);

/** The period starting on `next` is paid: it starts before the paid-through day, or the plan has none. */
const periodPaid = (u: RenewalRecord, next: string): boolean => {
  const until = paidUntil(u);
  return until === null || next < until;
};

/**
 * Whether the allowance renews now: a paid plan, not locked for an unpaid renewal (rule 712), not past a hand plan's
 * paid-through day (rule 1303), today on or after its renewal day, and that period paid.
 */
export function renewalDue(u: RenewalRecord, today: string): boolean {
  if (u.plan === "trial" || billingLocked(u.billing) || handPlanEnded(u, today)) return false;
  const next = nextRenewal(u, today);
  return today >= next && periodPaid(u, next);
}

/**
 * The day the plan's credits renew next, for the screens (today when a renewal is already due). Null for a trial, a locked
 * subscription, or a hand-set plan whose next period is not paid. A Paymob subscription that is not locked shows its
 * anchor day: its renewal charge falls due that day and the allowance follows the payment.
 */
export function creditsResetOn(u: RenewalRecord, today: string): string | null {
  if (u.plan === "trial" || billingLocked(u.billing) || handPlanEnded(u, today)) return null;
  const next = nextRenewal(u, today);
  return u.billing || periodPaid(u, next) ? (next < today ? today : next) : null;
}
