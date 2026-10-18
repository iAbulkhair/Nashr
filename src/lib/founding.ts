import { db } from "./db";
import { addDays, addMonths } from "./billing-state";
import { ksaDay } from "./partner-rules";
import { PLAN_PRICE_SAR, SELF_SERVE_PLANS, allowanceOf, type SelfServePlan } from "./pricing";
import { topupCredits } from "./topups";
import type { User } from "./auth";

/**
 * The founding offer and the price lock (rules 1700-1719, spec docs/specs/2026-10-13-founding-20-seats-price-lock.md,
 * PRD docs/PRD-Thakeen.md 11.2-11.3, founder decision 2026-10-13 "build it in code").
 *
 * - Founding seats: 20, taken at the moment a first plan payment asked for the founding offer is applied (the Paymob
 *   callback), never on a button press. The claim is one server-side step in Redis (`zaddCapped`), so two payments for
 *   the last seat can never both get it; the loser is an ordinary subscriber and the console log says so.
 * - Price lock: the plan's list price at the first payment, kept for 12 months for a founding seat and 6 months for the
 *   paying accounts after them, up to the first 100 paying accounts. The renewal charges the lower of the locked price
 *   and the current one (src/lib/billing.ts `chargeSavedCard`).
 * - Refund proposal: the 7-day guarantee's amount, shown to the founder; the refund itself stays the console's existing
 *   full refund, which ends the plan (rule 1300) and with it the seat and the lock.
 *
 * Everything automatic here is off while Paymob is off: no checkout and no callback run without `paymentProvider()` (src/lib/payments), and
 * the public counter answers closed. The founder console may grant or end a seat or a lock by hand at any time.
 * Stored on the account as two optional fields (expand step, rule 679): old code ignores them and keeps them on save.
 */

/** PRD 11.2: twenty founding seats. */
export const FOUNDING_SEATS = 20;
/** Pricing design 2026-09-29 item 7: the first 100 paying accounts keep their price. Unverified against PRD 11.2, which names no number for "after them". */
export const PRICE_LOCK_ACCOUNTS = 100;
/** PRD 11.2: a founding seat's monthly price is fixed for 12 months. */
export const FOUNDING_LOCK_MONTHS = 12;
/** PRD 11.2 «من بعدهم 6 أشهر»: the paying accounts after the founders, 6 months. */
export const LATER_LOCK_MONTHS = 6;
/** PRD 11.1: the sale starts 1 November 2026 (Riyadh day). Nothing is claimed automatically before it. */
export const SALE_START = "2026-11-01";
/** PRD 11.3: the guarantee runs 7 days after the first payment's Riyadh day (that day plus 7, inclusive; unverified). */
export const REFUND_WINDOW_DAYS = 7;

/** Sorted sets: member = account email, score = claim time in ms. The counts are their sizes. */
export const SEATS_KEY = "founding:seats";
export const LOCKS_KEY = "pricelock:accounts";

/** A founding seat on the account. `endedAt` set: the seat was ended (console or refund) and is never claimed again automatically. */
export type FoundingSeat = { at: string; by: string; paymentId?: string; endedAt?: string; endedBy?: string };
/**
 * A price lock on the account: the plan, its ex-VAT price in halalas, the first paid Riyadh day and the first day it no
 * longer applies. `paidHalalas` is what the first payment charged including VAT (the refund proposal's base).
 */
export type PriceLock = {
  plan: SelfServePlan;
  baseHalalas: number;
  from: string;
  until: string;
  months: number;
  founding: boolean;
  at: string;
  by: string;
  paidHalalas?: number;
  paymentId?: string;
  endedAt?: string;
  endedBy?: string;
};

const isPlan = (v: unknown): v is SelfServePlan => typeof v === "string" && (SELF_SERVE_PLANS as readonly string[]).includes(v);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const listBase = (plan: SelfServePlan) => Math.round(PLAN_PRICE_SAR[plan] * 100);

/** The sale has started on this Riyadh day. */
export const saleStarted = (day: string): boolean => day >= SALE_START;

/** A seat that counts: present and not ended. */
export const liveSeat = (u: Pick<User, "founding">): boolean => !!u.founding && !u.founding.endedAt;
/** A lock that counts: present, not ended, and its stored numbers are sane (a hand-edited record never lowers a price to 0). */
export function liveLock(u: Pick<User, "priceLock">): PriceLock | null {
  const l = u.priceLock;
  if (!l || l.endedAt || !isPlan(l.plan) || !isDay(l.from) || !isDay(l.until)) return null;
  if (!Number.isSafeInteger(l.baseHalalas) || l.baseHalalas <= 0) return null;
  return l;
}

/**
 * The ex-VAT renewal price in halalas for the paid period starting `periodStart` (the subscription's `paidThrough`), or
 * null when no lock applies: a live lock on this plan whose `until` is after the period's first day. Never above the
 * current list price: a price cut reaches a locked account too.
 */
export function lockedBaseHalalas(u: Pick<User, "priceLock">, plan: SelfServePlan, periodStart: string): number | null {
  const l = liveLock(u);
  if (!l || l.plan !== plan || periodStart < l.from || periodStart >= l.until) return null;
  return Math.min(l.baseHalalas, listBase(plan));
}

/** A lock starting on `from` for `months`, at the plan's list price today. */
export function newLock(input: { plan: SelfServePlan; from: string; founding: boolean; by: string; paidHalalas?: number; paymentId?: string }, now = Date.now()): PriceLock {
  const months = input.founding ? FOUNDING_LOCK_MONTHS : LATER_LOCK_MONTHS;
  return {
    plan: input.plan, baseHalalas: listBase(input.plan), from: input.from, until: addMonths(input.from, months), months,
    founding: input.founding, at: new Date(now).toISOString(), by: input.by,
    ...(input.paidHalalas !== undefined ? { paidHalalas: input.paidHalalas } : {}),
    ...(input.paymentId ? { paymentId: input.paymentId } : {}),
  };
}

export type RefundProposal = { lastDay: string; inWindow: boolean; usedCredits: number; deductionHalalas: number; amountHalalas: number };
/**
 * The 7-day guarantee's amount (PRD 11.3, spec "Refund calculation"): the price paid including VAT, minus the value of
 * the plan credits used since the payment, each valued at the ex-VAT price divided by the plan's monthly credits.
 * Nothing used: the full amount. Rounded down to a halala, never negative, never above what was paid. A proposal for
 * the founder to check, not a refund: the console's refund stays the full one (rule 1300) until Paymob's partial refund
 * is proven in test mode.
 */
export function refundProposal(i: { paidHalalas: number; baseHalalas: number; allowance: number; monthlyLeft: number; paidOn: string; today: string }): RefundProposal {
  const paid = Math.max(0, Math.trunc(i.paidHalalas) || 0);
  const allowance = Math.max(0, Math.trunc(i.allowance) || 0);
  const used = allowance ? Math.min(allowance, Math.max(0, allowance - Math.trunc(i.monthlyLeft || 0))) : 0;
  const value = allowance ? (used * Math.max(0, i.baseHalalas)) / allowance : 0;
  const amount = Math.max(0, Math.min(paid, Math.floor(paid - value)));
  const lastDay = addDays(i.paidOn, REFUND_WINDOW_DAYS);
  return { lastDay, inWindow: i.today >= i.paidOn && i.today <= lastDay, usedCredits: used, deductionHalalas: paid - amount, amountHalalas: amount };
}

/** The proposal for an account with a live lock that recorded its first payment, else null. */
export function refundProposalFor(u: User, today = ksaDay()): RefundProposal | null {
  const l = liveLock(u);
  if (!l || l.paidHalalas === undefined) return null;
  return refundProposal({ paidHalalas: l.paidHalalas, baseHalalas: l.baseHalalas, allowance: allowanceOf(u), monthlyLeft: (Number(u.credits) || 0) - topupCredits(u), paidOn: l.from, today });
}

/** Seats taken and accounts locked: two set sizes. */
export async function foundingCounts(): Promise<{ seats: number; locks: number }> {
  const [seats, locks] = await Promise.all([db.zcard(SEATS_KEY), db.zcard(LOCKS_KEY)]);
  return { seats, locks };
}

/**
 * The checkout may mark its intent as a founding one (the request only asks; this decides): the sale has started, a
 * seat is free now, and the account never had a seat and never paid online. The callback's atomic claim still decides.
 */
export async function foundingOfferOpen(u: Pick<User, "founding" | "billing" | "priceLock">, now = Date.now()): Promise<boolean> {
  if (!saleStarted(ksaDay(now)) || u.founding || u.billing || u.priceLock) return false;
  return (await db.zcard(SEATS_KEY)) < FOUNDING_SEATS;
}

export type ClaimOutcome = { seat: "claimed" | "full" | null; lock: number | null };
/**
 * On an applied first plan payment, inside the account's lock (src/lib/billing.ts `applyPaid`): claim the founding seat
 * when the intent asked for it, then the lock. A retried callback whose first run claimed but did not save finds its own
 * claim ("exists") and saves it. An account that ever had a seat or a lock gets nothing automatically again.
 */
export async function claimOnPayment(u: User, p: { founding: boolean; plan: SelfServePlan; paidHalalas: number; paymentId: string; day: string }, now = Date.now()): Promise<ClaimOutcome> {
  if (!saleStarted(p.day)) return { seat: null, lock: null };
  let seat: ClaimOutcome["seat"] = null;
  if (p.founding && !u.founding) {
    const r = await db.zaddCapped(SEATS_KEY, now, u.email, FOUNDING_SEATS);
    seat = r === "full" ? "full" : "claimed";
    if (seat === "claimed") u.founding = { at: new Date(now).toISOString(), by: "paymob", paymentId: p.paymentId };
  }
  if (u.priceLock) return { seat, lock: null };
  const founding = liveSeat(u);
  // A founding seat always carries its lock; anyone else only while one of the first 100 places is free.
  const r = await db.zaddCapped(LOCKS_KEY, now, u.email, founding ? Number.MAX_SAFE_INTEGER : PRICE_LOCK_ACCOUNTS);
  if (r === "full") return { seat, lock: null };
  u.priceLock = newLock({ plan: p.plan, from: p.day, founding, by: "paymob", paidHalalas: p.paidHalalas, paymentId: p.paymentId }, now);
  return { seat, lock: u.priceLock.months };
}

/**
 * A full refund ended the plan (src/lib/billing.ts `endPlanOnRefund`, rule 1300): the seat and the lock end with it,
 * inside the same lock. Answers whether anything ended; the caller frees both places afterwards (`freePlaces`).
 */
export function endOnRefund(u: User, by: string, now = Date.now()): boolean {
  const at = new Date(now).toISOString();
  let ended = false;
  if (liveSeat(u)) { u.founding = { ...u.founding!, endedAt: at, endedBy: by }; ended = true; }
  if (u.priceLock && !u.priceLock.endedAt) { u.priceLock = { ...u.priceLock, endedAt: at, endedBy: by }; ended = true; }
  return ended;
}

/** Free the account's seat and lock places (an ended seat or lock, a deleted account). Two commands, sent together. */
export async function freePlaces(email: string, which: { seat?: boolean; lock?: boolean } = { seat: true, lock: true }): Promise<void> {
  await Promise.all([which.seat ? db.zrem(SEATS_KEY, email) : null, which.lock ? db.zrem(LOCKS_KEY, email) : null]);
}

/** The public counter (GET /api/founding/seats): open only while the sale runs, payments are on and a seat is free. */
export async function publicSeats(paymentsOn: boolean, now = Date.now()): Promise<{ open: false } | { open: true; left: number; total: number }> {
  if (!paymentsOn || !saleStarted(ksaDay(now))) return { open: false };
  const left = FOUNDING_SEATS - (await db.zcard(SEATS_KEY));
  return left > 0 ? { open: true, left, total: FOUNDING_SEATS } : { open: false };
}

export type GrantAction = "grant_seat" | "end_seat" | "grant_lock" | "end_lock";
export const isGrantAction = (v: unknown): v is GrantAction => v === "grant_seat" || v === "end_seat" || v === "grant_lock" || v === "end_lock";
export type GrantError = "bad_plan" | "bad_from" | "seats_full" | "has_seat" | "no_seat" | "has_lock" | "no_lock";

/**
 * The founder's hand change, inside the account's lock (POST /api/admin/founding). A seat is claimed or freed in the same
 * set as a paid one, so the count stays true. A granted lock starts on `from` (default today, never in the future, at
 * most 400 days back) on `plan` (default the subscription's plan), for 12 months with a live seat and 6 without, and is
 * not capped at 100: the founder's hand is the exception.
 */
export async function applyGrant(u: User, action: GrantAction, input: { plan?: unknown; from?: unknown }, by: string, now = Date.now()): Promise<{ ok: true; free?: { seat?: boolean; lock?: boolean } } | { ok: false; error: GrantError }> {
  const at = new Date(now).toISOString();
  const today = ksaDay(now);
  if (action === "grant_seat") {
    if (liveSeat(u)) return { ok: false, error: "has_seat" };
    if ((await db.zaddCapped(SEATS_KEY, now, u.email, FOUNDING_SEATS)) === "full") return { ok: false, error: "seats_full" };
    u.founding = { at, by };
    return { ok: true };
  }
  if (action === "end_seat") {
    if (!liveSeat(u)) return { ok: false, error: "no_seat" };
    u.founding = { ...u.founding!, endedAt: at, endedBy: by };
    return { ok: true, free: { seat: true } };
  }
  if (action === "end_lock") {
    if (!u.priceLock || u.priceLock.endedAt) return { ok: false, error: "no_lock" };
    u.priceLock = { ...u.priceLock, endedAt: at, endedBy: by };
    return { ok: true, free: { lock: true } };
  }
  if (u.priceLock && !u.priceLock.endedAt) return { ok: false, error: "has_lock" };
  const plan = input.plan === undefined || input.plan === null || input.plan === "" ? u.billing?.plan : input.plan;
  if (!isPlan(plan)) return { ok: false, error: "bad_plan" };
  const from = input.from === undefined || input.from === null || input.from === "" ? today : input.from;
  if (!isDay(from) || from > today || from < addDays(today, -400)) return { ok: false, error: "bad_from" };
  await db.zaddCapped(LOCKS_KEY, now, u.email, Number.MAX_SAFE_INTEGER);
  u.priceLock = newLock({ plan, from, founding: liveSeat(u), by }, now);
  return { ok: true };
}

/** What the console and the owner's data download show of the offer: no internals beyond the account's own record. */
export function foundingView(u: Pick<User, "founding" | "priceLock">) {
  return {
    seat: u.founding ? { at: u.founding.at, by: u.founding.by, endedAt: u.founding.endedAt ?? null } : null,
    lock: u.priceLock ? { plan: u.priceLock.plan, sar: u.priceLock.baseHalalas / 100, from: u.priceLock.from, until: u.priceLock.until, months: u.priceLock.months, founding: u.priceLock.founding, endedAt: u.priceLock.endedAt ?? null } : null,
  };
}
