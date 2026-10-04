import type { User } from "./auth";
import { TOPUP_PACKS, TOPUP_VALID_DAYS, isTopupPack } from "./pricing";
// Import-free like pricing.ts: the day a payment is dated on is the Riyadh day, as for every recorded payment.
import { ksaDay } from "./partner-rules";

/**
 * Credit top-ups (spec section 6 rule 5, founder decisions of 2026-10-01 and 2026-10-02; rules 440-464): the arithmetic of the packs on
 * one account record, in memory. The ledger (src/lib/credits.ts) calls it under the per-user lock and saves the record;
 * `getUser` calls `settleTopups` on every read, so an expired pack is gone from the balance the moment it expires.
 *
 * The model. `User.credits` stays what it always was for every reader: the balance the owner can spend, so the 40-odd
 * places that show it or check it before a charge keep working unchanged. Top-up packs are lots on the record
 * (`User.topups`), each with what is `left` of it; the month's plan credits are the rest of the balance:
 *
 *   monthly part = credits − (credits left in live packs), never below 0.
 *
 * Invariants, restored by `settleTopups` whenever a record is read:
 *  - a pack is live until `expiresAt` (90 days from activation); then its unspent credits leave the balance;
 *  - 0 <= left <= credits for every pack, whole numbers;
 *  - the packs' credits left never exceed the balance. A writer that lowered the balance without knowing about packs
 *    (none should exist) is read as a spend in the documented order: the monthly part first, then packs by expiry.
 *
 * Order of spending: the monthly part first, then packs by earliest expiry (the oldest pack first). A charge returns a
 * receipt naming the packs it took from, and a refund puts credits back exactly where they came from, undoing the
 * charge from its last credit backwards. A refund owed to a pack that has since expired, been voided or been refunded
 * goes to the monthly part instead (founder decision of 2026-10-02, rule 461): the charge failed, so the customer gets
 * the credits back, as plan credits.
 *
 * Refund of unused credits (founder decision of 2026-10-02, rule 460): on the customer's request, before the pack
 * expires, the founder refunds the credits still left in a paid pack (`refundUnused`): they leave the balance at once,
 * the pack keeps a `refund` record and spends nothing more, and the amount is the credits left at the price per credit
 * actually paid, excluding VAT (`unusedRefundSar`). The pack stays on the record until it would have expired, so top-up
 * revenue counts what was kept of it (`topupRevenueSar`).
 *
 * Renewal resets only the monthly part (`setMonthly`): live packs survive it. Monthly credits never roll over.
 *
 * Imports only a type, src/lib/pricing.ts and src/lib/partner-rules.ts (both import-free), so the billing page and the
 * founder console can read the helpers without pulling server code into a bundle (tests/client-bundle.test.ts).
 *
 * A pack is a customer payment too (rule 454): the founder's "Add top-up" records it in `payments:{email}` under the
 * request's payment id (`paymentId`), through src/lib/partners.ts `addPaidTopup`, so a referred customer's top-up earns
 * the partner's commission like any payment, and voiding the pack voids that payment and its commission.
 */

/** One activated pack. Written only by the founder console (`addTopup`), changed only by the ledger. */
export type TopupLot = {
  /** Random, 16 hex characters. */
  id: string;
  /** The pack: one of TOPUP_PACKS. */
  credits: number;
  /** Credits of this pack not yet spent. */
  left: number;
  /** ISO time the founder activated it: the 90 days count from here. */
  at: string;
  /** ISO time its unspent credits leave the balance. */
  expiresAt: string;
  /** What the customer paid for it, SAR excluding VAT, as the founder recorded it. */
  paidSar: number;
  /** YYYY-MM-DD the payment was made, as the founder recorded it (the month top-up revenue counts it in). */
  paidOn: string;
  /** The payment reference the founder recorded (bank transfer, receipt number), "" when none. Never logged. */
  ref: string;
  /** Who activated it: the founder's email, or "key" for the console key. */
  by: string;
  /**
   * The founder's request id (`pay_` and hex, rule 454): a retried "Add top-up" with the same id finds this pack instead
   * of adding a second, and the pack's payment is recorded in `payments:{email}` under the same id when something was
   * paid. Absent on a pack added before payments were recorded with it.
   */
  paymentId?: string;
  /**
   * The refund of the credits that were still unused (rule 460), written once by `refundUnused` under the ledger lock.
   * A refunded pack holds no credits (`left` stays 0), takes no charge's refund (that goes to the monthly part) and
   * cannot be refunded again.
   */
  refund?: TopupRefund;
};

/**
 * A refund of a pack's unused credits (rule 460): `credits` the credits that were left and left the balance, `sar` what
 * the founder sends back for them, excluding VAT (`unusedRefundSar`), `on` the day of the transfer (YYYY-MM-DD, Riyadh),
 * `ref` its reference (never logged), `at` and `by` when and by whom it was recorded, `id` the console's request id
 * (`rf_` and hex) so a retry is recognised.
 */
export type TopupRefund = { credits: number; sar: number; on: string; ref: string; at: string; by: string; id?: string };

/**
 * Where a charge's credits came from, when any came from a pack: `monthly` from the month's plan credits, `lots` from
 * each pack in the order they were taken. A charge that touched no pack has no receipt, and its refund goes to the
 * monthly part, exactly as before top-ups existed.
 */
export type Receipt = { monthly: number; lots: { id: string; n: number }[] };

export const TOPUP_VALID_MS = TOPUP_VALID_DAYS * 864e5;
/** Most packs one account may hold at once: a guard against a typo or a double click, not a business rule. */
export const MAX_LIVE_TOPUPS = 50;
/** Largest amount the founder may record for one pack, SAR excluding VAT: only a guard against a typo. */
export const MAX_TOPUP_PAID_SAR = 100_000;
/** Longest payment reference kept. */
export const TOPUP_REF_MAX = 80;
/** How far back a payment date may be: a year. */
const PAID_ON_MAX_AGE_MS = 366 * 864e5;
/** The largest pack: no pack holds more credits than this, so no refund is for more. */
const MAX_PACK = Math.max(...TOPUP_PACKS);

const whole = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
const time = (iso: string): number => new Date(iso).getTime();

/** Live means not expired. A malformed time is not live: its credits leave rather than stay for ever. */
export const isLive = (l: Pick<TopupLot, "expiresAt">, now = Date.now()): boolean => time(l.expiresAt) > now;

/** The account's packs, earliest expiry first (then oldest activation, then id): the order they are spent in. */
export function lotsOf(u: Pick<User, "topups">): TopupLot[] {
  const lots = Array.isArray(u.topups) ? u.topups.filter((l) => !!l && typeof l === "object" && typeof l.id === "string") : [];
  return [...lots].sort((a, b) => time(a.expiresAt) - time(b.expiresAt) || time(a.at) - time(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Credits left in the account's packs (the record is assumed settled: `getUser` settles every read). */
export const topupCredits = (u: Pick<User, "topups">): number => lotsOf(u).reduce((s, l) => s + whole(l.left), 0);

/** The month's plan credits: the balance less what is left in the packs, never below 0. */
export const monthlyCredits = (u: Pick<User, "credits" | "topups">): number => Math.max(0, whole(u.credits) - topupCredits(u));

/**
 * Restore the invariants on a record just read, in memory (the next locked save writes it back): expired packs leave
 * with their unspent credits, every `left` is a whole number within its pack, a balance that is not a number becomes
 * the packs' credits (the monthly part is lost, as the ledger's repair always did), and packs that hold more than the
 * balance are trimmed, earliest expiry first. Returns whether anything changed.
 */
export function settleTopups(u: Pick<User, "credits" | "topups">, now = Date.now()): boolean {
  if (u.topups === undefined) return false;
  const before = JSON.stringify([u.credits, u.topups]);
  const all = lotsOf(u);
  const gone = all.filter((l) => !isLive(l, now));
  const live = all.filter((l) => isLive(l, now));
  // A refunded pack holds nothing: its unused credits left the balance with the refund (rule 460).
  for (const l of live) l.left = l.refund ? 0 : Math.min(whole(l.left), whole(l.credits));
  const held = live.reduce((s, l) => s + l.left, 0);
  if (!Number.isFinite(u.credits)) u.credits = held;
  else u.credits = Math.max(0, Math.trunc(u.credits) - gone.reduce((s, l) => s + Math.min(whole(l.left), whole(l.credits)), 0));
  let over = held - u.credits;
  for (const l of live) {
    if (over <= 0) break;
    const cut = Math.min(l.left, over);
    l.left -= cut;
    over -= cut;
  }
  if (live.length) u.topups = live;
  else delete u.topups;
  return JSON.stringify([u.credits, u.topups]) !== before;
}

/**
 * Take `n` credits off a settled record that holds at least `n`: the monthly part first, then packs by earliest
 * expiry. Returns the receipt when a pack was touched, else undefined.
 */
export function spendCredits(u: Pick<User, "credits" | "topups">, n: number): Receipt | undefined {
  const cost = whole(n);
  const monthly = Math.min(monthlyCredits(u), cost);
  let rest = cost - monthly;
  const lots: Receipt["lots"] = [];
  for (const l of lotsOf(u)) {
    if (rest <= 0) break;
    const take = Math.min(whole(l.left), rest);
    if (!take) continue;
    l.left = whole(l.left) - take;
    rest -= take;
    lots.push({ id: l.id, n: take });
  }
  u.credits = Math.max(0, whole(u.credits) - cost);
  return lots.length ? { monthly: monthly + rest, lots } : undefined;
}

/**
 * Give back `n` credits of a charge with this receipt, undoing it from its last credit backwards (the last pack taken
 * first, the monthly part last), so a partial refund leaves the record as if only the rest had been charged. What was
 * owed to a pack that is gone (expired or voided) or refunded goes to the monthly part instead (`toPlan`, founder
 * decision of 2026-10-02, rule 461): the charge failed, so its credits come back to the customer as plan credits, and
 * the pack itself never takes credits again. Anything beyond the receipt (a caller giving back more than it charged)
 * goes to the monthly part too, as every refund did before top-ups. A live pack that is already full drops what was owed
 * to it (`dropped`): that only happens to a second refund of the same charge.
 *
 * A charge is refunded in one call or not at all (`generateBatch`, `refundOnce` for media, `refundOnboard`): the receipt
 * is not consumed, so a second refund against it finds its packs already full and drops their share rather than give
 * a pack more than it was sold with.
 */
export function returnCredits(u: Pick<User, "credits" | "topups">, n: number, from: Receipt | undefined, now = Date.now()): { dropped: number; toPlan: number } {
  let rest = whole(n);
  let dropped = 0;
  let toPlan = 0;
  const base = whole(u.credits);
  let added = 0;
  if (from && Array.isArray(from.lots)) {
    const live = new Map(lotsOf(u).map((l) => [l.id, l]));
    for (const e of [...from.lots].reverse()) {
      if (rest <= 0) break;
      const k = Math.min(whole(e?.n), rest);
      rest -= k;
      const l = typeof e?.id === "string" ? live.get(e.id) : undefined;
      // Gone (expired, voided) or refunded: the credits come back as plan credits (rule 461).
      if (!l || l.refund || !isLive(l, now)) { toPlan += k; continue; }
      const put = Math.min(k, Math.max(0, whole(l.credits) - whole(l.left)));
      if (put) { l.left = whole(l.left) + put; added += put; }
      dropped += k - put;
    }
    const m = Math.min(whole(from.monthly), rest);
    rest -= m;
    added += m;
  }
  u.credits = base + added + toPlan + rest;
  return { dropped, toPlan };
}

/** Set the monthly part to `n` (renewal, a plan change): live packs keep every credit left in them. */
export function setMonthly(u: Pick<User, "credits" | "topups">, n: number): void {
  u.credits = whole(n) + topupCredits(u);
}

/**
 * Add `delta` to the monthly part (referral and share bonuses, the founder's "+ credits"). A negative delta takes from
 * the monthly part only and stops at 0 there: a pack's credits leave only by being spent, by expiring or by a void.
 */
export function addMonthly(u: Pick<User, "credits" | "topups">, delta: number): void {
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const current = Number.isFinite(u.credits) ? Math.trunc(u.credits) : 0;
  u.credits = Math.max(topupCredits(u), current + d);
}

/** A new pack, activated now: valid TOPUP_VALID_DAYS from `now`. */
export function newLot(input: { id: string; credits: number; paidSar: number; paidOn: string; ref: string; by: string; paymentId?: string }, now = Date.now()): TopupLot {
  return { id: input.id, credits: input.credits, left: input.credits, at: new Date(now).toISOString(), expiresAt: new Date(now + TOPUP_VALID_MS).toISOString(), paidSar: input.paidSar, paidOn: input.paidOn, ref: input.ref, by: input.by, ...(input.paymentId ? { paymentId: input.paymentId } : {}) };
}

/** What the founder sends to activate a pack, checked. */
export type TopupRequest = { credits: number; paidSar: number; paidOn: string; ref: string };
export type TopupParseError = "bad_pack" | "bad_paid" | "bad_date" | "bad_ref";

/**
 * Check the founder's "Add top-up" request (POST /api/admin/topups, action "add"): `credits` exactly one of TOPUP_PACKS;
 * `paidSar` the amount paid excluding VAT, a finite number from 0 to MAX_TOPUP_PAID_SAR, kept to the halala; `paidOn` a
 * real calendar date YYYY-MM-DD, at most a year back and not after today in Riyadh (`ksaDay`): the rule every recorded
 * payment follows (src/lib/partners.ts `recordPayment`, rule 459), so the pack's payment is never refused after the pack
 * went on; `ref` a string of at most TOPUP_REF_MAX characters once trimmed and stripped of control characters, or absent.
 * Nothing else in the body is read.
 */
export function parseTopup(raw: unknown, now = Date.now()): { ok: true; topup: TopupRequest } | { ok: false; error: TopupParseError } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "bad_pack" };
  const { credits, paidSar, paidOn, ref } = raw as Record<string, unknown>;
  if (!isTopupPack(credits)) return { ok: false, error: "bad_pack" };
  if (typeof paidSar !== "number" || !Number.isFinite(paidSar) || paidSar < 0 || paidSar > MAX_TOPUP_PAID_SAR) return { ok: false, error: "bad_paid" };
  if (typeof paidOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return { ok: false, error: "bad_date" };
  const day = Date.parse(`${paidOn}T00:00:00Z`);
  // A day that does not exist (2026-02-30) parses to another day, or not at all: refused, never moved.
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== paidOn) return { ok: false, error: "bad_date" };
  if (paidOn > ksaDay(now) || day < now - PAID_ON_MAX_AGE_MS) return { ok: false, error: "bad_date" };
  if (ref !== undefined && ref !== null && typeof ref !== "string") return { ok: false, error: "bad_ref" };
  const cleanRef = typeof ref === "string" ? ref.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (cleanRef.length > TOPUP_REF_MAX) return { ok: false, error: "bad_ref" };
  return { ok: true, topup: { credits, paidSar: Math.round(paidSar * 100) / 100, paidOn, ref: cleanRef } };
}

/**
 * Top-up revenue in `month` (YYYY-MM): what was paid for packs whose payment date is in that month, excluding VAT,
 * summed in halalas so the total is exact (counted by the payment date the founder enters: founder decision of
 * 2026-10-02). A refunded pack counts what was kept of it, its amount paid less the refund (rule 460). Kept apart from
 * MRR, which stays the plans' list prices. A voided pack is gone and does not count; neither does a pack of an account
 * deleted since (admin:log keeps the record of the payment).
 */
export function topupRevenueSar(users: readonly Pick<User, "topups">[], month: string): number {
  const halalas = (sar: unknown) => (typeof sar === "number" && Number.isFinite(sar) ? Math.round(sar * 100) : 0);
  const kept = (l: TopupLot) => Math.max(0, halalas(l.paidSar) - halalas(l.refund?.sar));
  const total = users.reduce((s, u) => s + lotsOf(u).filter((l) => typeof l.paidOn === "string" && l.paidOn.slice(0, 7) === month).reduce((t, l) => t + kept(l), 0), 0);
  return total / 100;
}

// ---- Refund of unused credits (founder decision of 2026-10-02, rule 460) ----

/**
 * What the customer gets back for a pack's unused credits, SAR excluding VAT: the credits left × the price per credit
 * actually paid (`paidSar / credits`, so a pack sold below list price refunds at what was paid), to the halala. VAT is
 * not collected on packs today; once it is, the VAT on this share is added on top.
 */
export function unusedRefundSar(l: Pick<TopupLot, "credits" | "left" | "paidSar">): number {
  const size = whole(l.credits);
  const left = Math.min(whole(l.left), size);
  const paid = typeof l.paidSar === "number" && Number.isFinite(l.paidSar) && l.paidSar > 0 ? Math.round(l.paidSar * 100) : 0;
  return size > 0 ? Math.round((left * paid) / size) / 100 : 0;
}

/** Packs still open on the account, not refunded: what the billing page and the profile list (rule 460). */
export const openLots = (u: Pick<User, "topups">): TopupLot[] => lotsOf(u).filter((l) => !l.refund);

/** A real calendar day YYYY-MM-DD, at most a year back and not after today in Riyadh: the rule of every recorded day. */
function recentDay(s: unknown, now: number): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const day = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== s) return false;
  return s <= ksaDay(now) && day >= now - PAID_ON_MAX_AGE_MS;
}

/** What the founder sends to refund a pack's unused credits, checked. */
export type RefundRequest = { credits: number; on: string; ref: string };
export type RefundParseError = "bad_credits" | "bad_date" | "bad_ref";

/**
 * Check the founder's "Refund unused" request (POST /api/admin/topups, action "refund"): `credits` the credits left that
 * the console showed and computed the amount from (a whole number from 1 to the largest pack), so the refund recorded is
 * the one the founder saw; `on` the day of the transfer, a real YYYY-MM-DD at most a year back and not after today in
 * Riyadh; `ref` its reference, required, at most TOPUP_REF_MAX characters once trimmed and stripped of control characters.
 * Nothing else in the body is read.
 */
export function parseTopupRefund(raw: unknown, now = Date.now()): { ok: true; refund: RefundRequest } | { ok: false; error: RefundParseError } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "bad_credits" };
  const { credits, on, ref } = raw as Record<string, unknown>;
  if (typeof credits !== "number" || !Number.isSafeInteger(credits) || credits < 1 || credits > MAX_PACK) return { ok: false, error: "bad_credits" };
  if (!recentDay(on, now)) return { ok: false, error: "bad_date" };
  const cleanRef = typeof ref === "string" ? ref.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!cleanRef || cleanRef.length > TOPUP_REF_MAX) return { ok: false, error: "bad_ref" };
  return { ok: true, refund: { credits, on, ref: cleanRef } };
}

export type RefundUnusedError = "topup_not_found" | "topup_refunded" | "topup_expired" | "topup_not_paid" | "nothing_left" | "left_changed" | "bad_date";

/**
 * Refund the unused credits of pack `id` on a settled record, in memory (rule 460). The caller holds the ledger lock and
 * saves the record before it records anything else (src/lib/partners.ts `refundPaidTopup`). Exactly the credits left in
 * the pack leave the balance, the pack's `left` becomes 0 and it keeps the refund. Credits a charge took from the pack
 * before the lock (an in-flight render) are not in `left`, so they are not refunded; if that charge fails, its refund
 * goes to the monthly part (`returnCredits`, rule 461).
 *
 * Refused: a pack not on the record (`topup_not_found`; expired and voided packs are gone from it, and the caller names
 * which from the payment record), one already refunded, one past its expiry, one given for nothing (`topup_not_paid`:
 * nothing to pay back; void it instead), one with nothing left, one whose credits left are not the `expected` the founder
 * was shown (`left_changed`, with the credits left and the amount now: a charge landed in between, so the amount is not
 * the one shown), and a transfer dated before the pack's payment (`bad_date`).
 */
export function refundUnused(
  u: Pick<User, "credits" | "topups">, id: string,
  input: { expected: number; on: string; ref: string; by: string; id?: string },
  now = Date.now(),
): { ok: true; lot: TopupLot; credits: number; sar: number } | { ok: false; error: RefundUnusedError; left?: number; sar?: number } {
  const lot = lotsOf(u).find((l) => l.id === id);
  if (!lot) return { ok: false, error: "topup_not_found" };
  if (lot.refund) return { ok: false, error: "topup_refunded" };
  if (!isLive(lot, now)) return { ok: false, error: "topup_expired" };
  if (!(typeof lot.paidSar === "number" && Number.isFinite(lot.paidSar) && lot.paidSar > 0)) return { ok: false, error: "topup_not_paid" };
  const balance = whole(u.credits);
  const left = Math.min(whole(lot.left), whole(lot.credits), balance);
  if (left <= 0) return { ok: false, error: "nothing_left" };
  const sar = unusedRefundSar({ credits: lot.credits, left, paidSar: lot.paidSar });
  if (left !== input.expected) return { ok: false, error: "left_changed", left, sar };
  if (typeof lot.paidOn === "string" && input.on < lot.paidOn) return { ok: false, error: "bad_date" };
  u.credits = balance - left;
  lot.left = 0;
  lot.refund = { credits: left, sar, on: input.on, ref: input.ref, at: new Date(now).toISOString(), by: input.by, ...(input.id ? { id: input.id } : {}) };
  return { ok: true, lot, credits: left, sar };
}

/**
 * What a charge refused for credits tells the model (the chat tools, MCP `generate_content`), so its reply names the way
 * out (rule 450). Top-ups are sold to paid plans only, so a trial is sent to subscribe.
 */
export const NO_CREDITS_HINT = "On a paid plan the owner can top up credits (packs used after the month's plan credits) or upgrade the plan on the Subscription page in the app; a trial subscribes there first.";

/** What the billing page shows of a pack. What was paid, the reference and who activated it stay with the founder. */
export type TopupView = Pick<TopupLot, "id" | "credits" | "left" | "at" | "expiresAt">;
export const topupView = (l: TopupLot): TopupView => ({ id: l.id, credits: l.credits, left: l.left, at: l.at, expiresAt: l.expiresAt });
/**
 * What GET /api/profile sends of a pack (rule 453): its size, the credits left in it and when they expire, nothing else.
 * The profile's credit card needs no more; the id, the activation time and every payment detail stay server side.
 */
export type TopupBalance = Pick<TopupLot, "credits" | "left" | "expiresAt">;
export const topupBalance = (l: TopupLot): TopupBalance => ({ credits: l.credits, left: l.left, expiresAt: l.expiresAt });

/**
 * The profile's credit card (rule 456): the balance as the month's plan credits (which reset on the 1st) and the credits
 * left in top-up packs (which do not), with each pack's credits left and expiry, the one that expires first first. The
 * packs never count for more than the balance, and nothing is below 0, whatever the values read.
 */
export function creditSplit(credits: number, packs: readonly TopupBalance[] | undefined): { plan: number; topup: number; packs: TopupBalance[] } {
  const list = (Array.isArray(packs) ? packs : [])
    .filter((l) => !!l && typeof l.expiresAt === "string")
    .map((l) => ({ credits: whole(l.credits), left: Math.min(whole(l.left), whole(l.credits)), expiresAt: l.expiresAt }))
    .filter((l) => l.left > 0)
    .sort((x, y) => time(x.expiresAt) - time(y.expiresAt));
  const balance = whole(credits);
  const topup = Math.min(balance, list.reduce((n, l) => n + l.left, 0));
  return { plan: balance - topup, topup, packs: list };
}
