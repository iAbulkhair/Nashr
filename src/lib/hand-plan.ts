import { addDays, addMonths, type Billing } from "./billing-state";

/**
 * A plan the founder set by hand (POST /api/admin/plan) and the Riyadh day it is paid through (rules 1242-1245, 360
 * study G-013). Import free apart from the date helpers, so `src/lib/credits.ts` and the console can read it.
 *
 * Stored shape, an expand (rule 679): `User.handPlan` is new and optional. A record without it (every plan set by hand
 * before this release) keeps the old behaviour: the month's credits refill every month with no end. Old code ignores
 * the field and keeps it through its saves. Contract step (a later release, the founder's call): once every hand-set
 * paid account has a paid-through day, a hand-set plan without one may stop refilling.
 */
export type HandPlan = {
  /** Riyadh day (YYYY-MM-DD), inclusive: the monthly refill runs while today is on or before it, then stops. */
  paidThrough: string;
  /** Who set it (the founder's email or "key") and when (ISO). */
  by: string;
  at: string;
};

/** Furthest a paid-through day may be set ahead: a yearly Agency contract plus a month of slack. */
export const HAND_PAID_MAX_DAYS = 400;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The default paid-through day for a plan set by hand today: one calendar month, like a Paymob payment. */
export const defaultPaidThrough = (today: string): string => addMonths(today, 1);

/**
 * A paid-through day from the console: a real calendar day from `today` to `HAND_PAID_MAX_DAYS` ahead. Anything else
 * (another format, 2026-02-30, the past, too far) is refused.
 */
export function parsePaidThrough(v: unknown, today: string): { ok: true; day: string } | { ok: false } {
  if (typeof v !== "string" || !DAY.test(v)) return { ok: false };
  const t = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v) return { ok: false };
  if (v < today || v > addDays(today, HAND_PAID_MAX_DAYS)) return { ok: false };
  return { ok: true, day: v };
}

/**
 * The hand-set plan's paid month is over: no Paymob subscription (that one has its own `paidThrough`), a paid-through
 * day on the record, and `today` (Riyadh) after it. A record without `handPlan` never ends here (the old shape).
 */
export const handPlanEnded = (u: { handPlan?: HandPlan; billing?: Billing }, today: string): boolean =>
  !u.billing && !!u.handPlan && typeof u.handPlan.paidThrough === "string" && DAY.test(u.handPlan.paidThrough) && today > u.handPlan.paidThrough;
