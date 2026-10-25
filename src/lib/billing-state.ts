import { INTERVAL_MONTHS, readInterval, type BillingInterval, type SelfServePlan } from "./pricing";

/**
 * An account's online subscription (Paymob KSA, spec docs/superpowers/specs/2026-10-08-paymob-billing-design.md). It imports
 * only src/lib/pricing.ts (which imports nothing), so `src/lib/auth.ts` can read the lock without pulling the billing
 * code in. Written only by
 * src/lib/billing.ts under `withUserLock`; never taken from a request. The card token itself is never here: it lives in
 * `paymob:card:{email}`, which no page or API answer reads.
 */
export type BillingStatus = "active" | "past_due" | "locked";
export type Billing = {
  /** Who charges it: Paymob, or Geidea (rule 3900; expand: older builds read a Geidea subscription as no online subscription). */
  provider: "paymob" | "geidea";
  plan: SelfServePlan;
  status: BillingStatus;
  /** Riyadh day (YYYY-MM-DD) the paid period runs to. The renewal is due on that day. */
  paidThrough: string;
  /**
   * How often the subscription renews (rule 3533): "year" renews twelve months at a time at the yearly price. Optional
   * (expand, rule 679): absent reads as monthly through `billingInterval`, and only "year" is ever written, so a monthly
   * subscription keeps exactly the shape it had before. Older builds ignore it and renew monthly.
   */
  interval?: BillingInterval;
  /** Day of the month of the first payment: each renewal lands on it (clamped to short months), so the date never drifts. */
  anchor: number;
  /** Charge the saved card when `paidThrough` comes. The owner turns it off (cancel) or on (resume). */
  autoRenew: boolean;
  /** Failed renewal attempts since the last payment. */
  failures: number;
  /** Set by the first failed renewal of a period: the last Riyadh day of grace before the lock. */
  graceUntil?: string;
  /** The saved card as the page may show it. */
  card?: { brand: string; last4: string };
  /** The renewal charge in flight (our intent reference) and the day it was sent, so a pending charge is not sent twice. */
  pending?: { ref: string; day: string };
  /** The last Paymob transaction ids applied to this account (newest last, at most 12): a retried callback changes nothing. */
  txns: string[];
};

/** Days of grace after a renewal that could not be charged, retried once a day, before the account is locked. */
export const GRACE_DAYS = 7;

/** The subscription's interval: "year" only when stored as "year"; absent or anything else is monthly (rule 3533). */
export const billingInterval = (b: { interval?: unknown } | null | undefined): BillingInterval => (readInterval(b?.interval) === "year" ? "year" : "month");
/** Calendar months one paid period of the subscription covers: 1, or 12 for a yearly one. */
export const billingMonths = (b: { interval?: unknown } | null | undefined): number => INTERVAL_MONTHS[billingInterval(b)];

/** A locked subscription spends nothing, exactly like an ended trial (`trialOver` in src/lib/auth.ts). */
export const billingLocked = (b: Billing | null | undefined): boolean => !!b && (b.provider === "paymob" || b.provider === "geidea") && b.status === "locked";

/**
 * A checkout started before the account last changed owner (`ownerSince`, set by the M3 ownership transfer) carries the
 * previous owner's card: its card is never saved and never turns renewals on for the new owner (rule 2757). Provider-neutral: it reads only our own intent's `createdAt`. With no `ownerSince` the account never changed
 * hands and every intent stands; with one, an intent without a valid `createdAt` is refused (fail closed).
 */
export function intentOutdatesOwner(account: { ownerSince?: unknown }, intentCreatedAt: unknown): boolean {
  if (account.ownerSince === undefined || account.ownerSince === null) return false;
  const since = typeof account.ownerSince === "string" ? Date.parse(account.ownerSince) : NaN;
  if (!Number.isFinite(since)) return true;
  const at = typeof intentCreatedAt === "string" ? Date.parse(intentCreatedAt) : NaN;
  return !Number.isFinite(at) || at < since;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `day` plus `n` days, both YYYY-MM-DD. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
}

/**
 * The same day of the month `n` months after `day`, on `anchor` (1-31) when given, clamped to the month's last day: Jan 31
 * + 1 month is Feb 28 (29 in a leap year), and with anchor 31 the month after that is Mar 31 again, not Mar 28.
 */
export function addMonths(day: string, n: number, anchor?: number): string {
  const m = DAY.exec(day);
  if (!m) throw new Error("bad_day");
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  const y = Math.floor(total / 12), mo = total % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return `${y}-${pad(mo + 1)}-${pad(Math.min(anchor ?? Number(m[3]), last))}`;
}

/** At most this many months are ever counted ahead (two yearly payments of one plan stack to 24, a month first to 25). */
const SEAT_MONTHS_MAX = 36;

/**
 * Rule 4041: the months of the paid period still to run on `today`, for a seat bought mid-period. The months are the
 * subscription's own, on its anchor day (`addMonths(paidThrough, -k, anchor)`), and a started month counts in full: on
 * the anchor day itself the month starting that day counts and the one ending that day does not. 0 when the period is
 * due (`paidThrough` today or before): the renewal then charges the seat for its whole period.
 */
export function seatMonthsLeft(b: Pick<Billing, "paidThrough" | "anchor">, today: string): number {
  let n = 0;
  while (n < SEAT_MONTHS_MAX && addMonths(b.paidThrough, -n, b.anchor) > today) n++;
  return n;
}

/** The renewal is due: an active or past-due Paymob subscription whose paid month ends today or earlier (Riyadh days). */
export const paymobRenewalDue = (b: Billing | null | undefined, today: string): b is Billing =>
  !!b && (b.provider === "paymob" || b.provider === "geidea") && (b.status === "active" || b.status === "past_due") && b.paidThrough <= today;
