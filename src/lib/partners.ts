import { cookies } from "next/headers";
import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { getLogin, getUser, normalizeEmail, saveUser, sessionCookie, validEmail, type Plan, type User } from "./auth";
import { addTopup, voidTopup, withUserLock } from "./credits";
import { lotsOf, refundUnused, type RefundRequest, type RefundUnusedError, type TopupLot, type TopupRefund, type TopupRequest } from "./topups";
import { pmap } from "./parallel";
import { dropCookie, readCookie } from "./cookie-names";
import { onRoster } from "./team";
import { rewardReferrer } from "./referral";
import { lifecyclePlan } from "./lifecycle";
import { FIRST_MONTH_DISCOUNT_PCT, SELF_SERVE_PLANS, firstMonthPriceSar, type SelfServePlan } from "./pricing";
import {
  CUSTOMER_LABEL_PREFIX, PARTNER_COOKIE, PARTNER_COOKIE_DAYS, balances, bankConfirmed, codeProblem, commissionAfterRefund, commissionDecision, commissionSar, fromHalalas, toHalalas,
  PARTNER_TERMS_VERSION, earlyOfferLastDay, ksaDay, maskIban, normalizeCode, optionalTax, parsePartnerCookie, payoutProblem, referralStatus, suggestCode,
  taxFlags, taxNumberOf, taxTotals, validAmount, validCountry, validDay, validIban,
  type Attribution, type Bank, type Commission, type LedgerRow, type NotCounted, type Payout, type ReferralStatus,
  PARTNER_COUNTRIES,
} from "./partner-rules";

/**
 * The partner programme and the 15% first-month discount, store side (docs/superpowers/specs/2026-10-01-affiliates-design.md).
 * The rules themselves are pure and live in src/lib/partner-rules.ts.
 *
 * Keys (all built from a normalized email or a validated code, never from free text):
 * - `partner:{email}` the approved partner: name, code, approval, bank details (IBAN in full: founder console only).
 * - `partnercode:{CODE}` → partner email. Unique; claimed under `lock:partners`.
 * - `partners:all` every partner email. `partner:refs:{email}` the customers attributed to that partner.
 * - `partner:ledger:{email}` hash: `c:{paymentId}` a commission (the customer's label, never the email), `p:{payoutId}`
 *   a payout. Changed only under `lock:partner:{email}`, so two payouts can never both pass the balance check.
 * - `payments:{email}` hash of the customer's recorded payments (the founder's record, the source of truth for commissions).
 *   A top-up pack's payment is one of them (`topup`, rule 454), recorded by the console's "Add top-up" only.
 * - `affiliate-applications` (list, the public form) and `affiliate:decisions` (hash, application id → approve/reject).
 *
 * The customer side lives on the account record (`User.referredBy`, `firstMonthOffer`, `firstPaidOn`, `partnerCode`),
 * always written under `withUserLock`.
 */

export type { Bank };
/**
 * The partner's agreement to the programme terms (rule 415), carried onto the partner record at approval: from the
 * application (`via: "application"`, the date and version the applicant ticked) or, for an applicant who agreed outside
 * the form, the founder's explicit statement (`via: "founder"`, who and when, at the current version), which is logged.
 */
export type TermsConsent = { at: string; version: string; via: "application" | "founder"; by?: string };
/** `hadAccount`: the address already had an owner account at approval; when false, whoever signed up with it later holds it. */
export type Partner = { email: string; name: string; code: string; approvedAt: string; approvedBy: string; appId?: string; hadAccount?: boolean; terms?: TermsConsent; bank?: Bank };
export type FirstMonthOffer = NonNullable<User["firstMonthOffer"]>;
export type Payment = {
  id: string; amountSar: number; plan: Plan; date: string; reference: string; recordedAt: string; recordedBy: string;
  /** The first-month discount this payment used, and the discounted list price the founder was shown. */
  offer?: FirstMonthOffer["kind"]; expectedSar?: number;
  commission?: { partner: string; sar: number }; notCounted?: NotCounted;
  voidedAt?: string; voidedBy?: string; voidReason?: string;
  /**
   * A top-up pack's payment (rule 454): the pack's id on the account and its credits. Written only by `addPaidTopup`
   * (the console's "Add top-up"), never from a request body; such a payment never uses the first-month offer, and it is
   * voided with its pack (`voidPaidTopup`) while the pack is live.
   */
  topup?: { lot: string; credits: number };
  /**
   * The refund of a top-up pack's unused credits recorded against this payment (rule 460), written once by
   * `refundPaidTopup`: the credits refunded, the amount sent back (SAR excluding VAT), the transfer's day and reference,
   * when and by whom. The partner's commission on the payment is reduced in proportion (`settle`, `commissionAfterRefund`).
   */
  refund?: { credits: number; sar: number; date: string; reference: string; at: string; by: string };
};
/**
 * A public application. `consentAt` and `termsVersion`: when the applicant agreed to the programme terms and which
 * version (`PARTNER_TERMS_VERSION`, rule 414); missing on applications sent before consent was asked.
 */
export type Application = { id: string; name: string; email: string; phone: string; channel: string; audience: string; lang: "ar" | "en"; at: string; consentAt?: string; termsVersion?: string; /** Where the applicant lives (rule 1470); absent before 2026-10-12. */ country?: string };
export type Decision = { status: "approved" | "rejected"; code?: string; at: string; by: string };

const partnerKey = (email: string) => `partner:${email}`;
const codeKey = (code: string) => `partnercode:${code}`;
const PARTNERS = "partners:all";
const refsKey = (email: string) => `partner:refs:${email}`;
const ledgerKey = (email: string) => `partner:ledger:${email}`;
/** The account's recorded payments (a hash by payment id). Exported for the Paymob refund (src/lib/billing.ts). */
export const paymentsKey = (email: string) => `payments:${email}`;
export const APPLICATIONS = "affiliate-applications";
const DECISIONS = "affiliate:decisions";

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("hex")}`;
/**
 * What a partner sees instead of a customer's name or email: the first six characters of the random `ref` drawn when the
 * account was attributed, so a partner cannot confirm a guessed address by recomputing it. An attribution written before
 * refs existed (none in production: the programme ships with them) falls back to a hash of the address.
 */
export const customerLabel = (u: Pick<User, "email" | "referredBy">) =>
  CUSTOMER_LABEL_PREFIX + (u.referredBy?.ref ?? createHash("sha256").update(`nashr-partner-ref:${u.email}`).digest("hex")).slice(0, 6).toUpperCase();
const newRef = () => randomBytes(6).toString("hex");
/** An application stored before applications carried an id: a stable id from its email and time. */
export const applicationId = (a: { id?: string; email?: string; at?: string }) => a.id ?? `app_${createHash("sha256").update(`${a.email ?? ""}|${a.at ?? ""}`).digest("hex").slice(0, 16)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Run `fn` under an owned Redis lock (waits up to ~3 s). Releasing never frees a lock someone took after ours expired. */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let token: string | null = null;
  for (let i = 0; i < 60 && !token; i++) {
    token = await db.lockOwned(key, 10);
    if (!token) await sleep(50);
  }
  if (!token) throw new Error("partner_lock_timeout");
  try {
    return await fn();
  } finally {
    await db.unlockOwned(key, token).catch(() => {});
  }
}
/** Every change to one partner's ledger or record. */
export const withPartnerLock = <T,>(email: string, fn: () => Promise<T>) => withLock(`lock:partner:${email}`, fn);
/** Approvals: the code registry is checked and claimed under one lock. */
const withRegistryLock = <T,>(fn: () => Promise<T>) => withLock("lock:partners", fn);

export const getPartner = (email: string) => db.get<Partner>(partnerKey(normalizeEmail(email)));
/** The partner holding a code, or null. The code is validated before any key is built from it. */
export async function partnerByCode(raw: unknown): Promise<Partner | null> {
  const code = normalizeCode(raw);
  if (codeProblem(code)) return null;
  const email = await db.get<string>(codeKey(code));
  if (!email) return null;
  const p = await getPartner(email);
  return p && p.code === code ? p : null;
}

// ---- Partner links and signup ----

/** The cookie a partner link sets: first-party, httpOnly, 30 days, Secure as every session cookie (auth.ts `sessionCookie`). */
export const partnerCookie = () => sessionCookie(PARTNER_COOKIE_DAYS * 86400);
/** The valid code in the visitor's partner cookie and the time of the click that set it, or null. */
export async function cookieRef(): Promise<{ code: string; clickMs?: number } | null> {
  return parsePartnerCookie(readCookie(await cookies(), PARTNER_COOKIE));
}

/** `at`: when the account was attributed, the link's click time when the code came from a partner link. */
export type SignupPartner = { partner: Partner; via: Attribution["via"]; at?: string } | null;
/**
 * Which partner a new account belongs to. A code typed at signup wins over the link cookie; a typed code that is not a
 * partner's answers "bad" (the form says so and nothing is created). Without a typed code, the cookie's code if it is
 * still a partner's (an unknown or stale cookie is ignored). The 30 days run from the click on the partner's link when
 * the code that counts is the link's (the /p/ redirect fills it into the form, so a "typed" code equal to the cookie's
 * is the link's), else from signup.
 */
export async function signupPartner(typed: unknown): Promise<SignupPartner | "bad"> {
  const code = normalizeCode(typed);
  const fromCookie = await cookieRef();
  const viaLink = (partner: Partner): SignupPartner =>
    ({ partner, via: "link", ...(fromCookie?.clickMs ? { at: new Date(fromCookie.clickMs).toISOString() } : {}) });
  if (code) {
    const partner = await partnerByCode(code);
    if (!partner) return "bad";
    return fromCookie?.code === code ? viaLink(partner) : { partner, via: "code" };
  }
  const partner = fromCookie ? await partnerByCode(fromCookie.code) : null;
  return partner ? viaLink(partner) : null;
}

/**
 * Right after the account is created: attribute it to its partner (never the partner's own address) with the 15%
 * first-month offer, and, when this address was approved as a partner before it had an account, show it the partner page.
 * The link cookie is spent either way. True when the account was attributed.
 */
export async function afterSignup(email: string, found: SignupPartner): Promise<boolean> {
  const e = normalizeEmail(email);
  const own = await getPartner(e);
  const attribute = !!found && found.partner.email !== e;
  let done = false;
  if (attribute || own) {
    done = await withUserLock(e, async (u) => {
      let attributed = false;
      if (attribute && !u.referredBy) {
        const now = new Date().toISOString();
        u.referredBy = { partner: found!.partner.email, code: found!.partner.code, at: found!.at ?? now, via: found!.via, ref: newRef() };
        if (!u.firstMonthOffer) u.firstMonthOffer = { kind: "partner", pct: FIRST_MONTH_DISCOUNT_PCT, at: now };
        attributed = true;
      }
      if (own) u.partnerCode = own.code;
      await saveUser(u);
      return attributed;
    });
    if (done) await db.sadd(refsKey(found!.partner.email), e);
  }
  const jar = await cookies();
  if (readCookie(jar, PARTNER_COOKIE)) dropCookie(jar, PARTNER_COOKIE);
  return done;
}

/** An unverified owner corrected the address they signed up with: the partner's referral set names the new one (add first, remove last). */
export async function movePartnerRef(partner: string, from: string, to: string): Promise<void> {
  const key = refsKey(normalizeEmail(partner));
  await db.sadd(key, to);
  await db.srem(key, from);
}

export type ClaimError = "bad_partner_code" | "self_referral" | "already_attributed" | "already_paid";
/**
 * The billing page's partner-code field: an account still on its trial, never attributed and never paid, takes a
 * partner's code, and the code's 15% first-month offer replaces an unused early-partner offer, running or ended (rule
 * 410). Still one offer per account, so discounts never stack, and the customer gets the discount the public terms
 * promise with the code: no end date, rather than an early offer that could end inside the code's 30-day window while
 * the partner still earns on the payment.
 */
export async function claimPartnerCode(u: User, raw: unknown): Promise<{ ok: true; code: string } | { ok: false; error: ClaimError }> {
  const partner = await partnerByCode(raw);
  if (!partner) return { ok: false, error: "bad_partner_code" };
  if (partner.email === u.email) return { ok: false, error: "self_referral" };
  const [a, b] = await Promise.all([onRoster(u.email, partner.email), onRoster(partner.email, u.email)]);
  if (a || b) return { ok: false, error: "self_referral" };
  const res = await withUserLock(u.email, async (x): Promise<ClaimError | null> => {
    if (x.referredBy) return "already_attributed";
    if (x.plan !== "trial" || x.firstPaidOn) return "already_paid";
    const at = new Date().toISOString();
    x.referredBy = { partner: partner.email, code: partner.code, at, via: "code", ref: newRef() };
    if (x.firstMonthOffer?.kind !== "partner") x.firstMonthOffer = { kind: "partner", pct: FIRST_MONTH_DISCOUNT_PCT, at };
    await saveUser(x);
    return null;
  });
  if (res) return { ok: false, error: res };
  await db.sadd(refsKey(partner.email), u.email);
  return { ok: true, code: partner.code };
}

// ---- The first-month offer ----

type OfferHolder = Pick<User, "firstMonthOffer" | "firstPaidOn" | "trialEnds">;
/**
 * The last Riyadh day an offer can be used, or null when it never ends: the early-partner offer ends 7 days after the
 * trial's last day (rule 410); a partner code's offer has no end date.
 */
export const offerLastDay = (u: Pick<User, "trialEnds">, offer: Pick<FirstMonthOffer, "kind">): string | null =>
  offer.kind === "early" ? earlyOfferLastDay(u.trialEnds) : null;
/** The account's first-month offer while no recorded payment took it and it has no first payment, whatever the date. */
const unusedOffer = (u: OfferHolder): FirstMonthOffer | null =>
  u.firstMonthOffer && !u.firstMonthOffer.usedAt && !u.firstPaidOn ? u.firstMonthOffer : null;
/**
 * The account's first-month offer that can still be used today, or null: one per account, whichever came first, unused,
 * and for the early-partner offer not past its last day (rule 410). An expired offer is neither shown nor applied.
 */
export const openOffer = (u: OfferHolder, now: number = Date.now()): FirstMonthOffer | null => {
  const offer = unusedOffer(u);
  const last = offer ? offerLastDay(u, offer) : null;
  return offer && (!last || ksaDay(now) <= last) ? offer : null;
};
/** The cron's moment: the day-3 trial note is due (src/lib/lifecycle.ts `lifecyclePlan`), whether or not mail is set up. */
export const earlyOfferDue = (u: User, now: number = Date.now()) =>
  !u.firstMonthOffer && !u.firstPaidOn && lifecyclePlan(u, now).some(([k, due]) => k === "day3" && due);
/**
 * The billing page grants the early-partner offer to a trial with none yet from the start of its last 24 hours through
 * the offer's last day (7 days after the trial's last day, rule 410): the cron's moment, and a missed run made up while
 * the offer could still be used. Never once that day has passed: an offer that would already be expired is not granted.
 */
export const lastDayOfferOwed = (u: User, now: number = Date.now()) => {
  const left = new Date(u.trialEnds).getTime() - now;
  return u.plan === "trial" && !u.firstMonthOffer && !u.firstPaidOn && left <= 24 * 36e5 && ksaDay(now) <= earlyOfferLastDay(u.trialEnds);
};
/** Grant the early-partner offer when `due` still holds under the lock. True when it was granted now. */
export async function grantEarlyOffer(email: string, due: (u: User) => boolean): Promise<boolean> {
  return withUserLock(email, async (u) => {
    if (!due(u)) return false;
    u.firstMonthOffer = { kind: "early", pct: FIRST_MONTH_DISCOUNT_PCT, at: new Date().toISOString() };
    await saveUser(u);
    return true;
  });
}
/** The discounted first month of each self-serve plan (src/lib/pricing.ts), for the billing page and the console. */
export const offerPrices = (): Record<SelfServePlan, number> =>
  Object.fromEntries(SELF_SERVE_PLANS.map((p) => [p, firstMonthPriceSar(p)])) as Record<SelfServePlan, number>;

// ---- Payments (founder console) and commissions ----

/** `topup`: set only by `addPaidTopup` (the payments route builds its input field by field and never passes it). */
export type PaymentInput = { id?: unknown; amountSar: unknown; plan: unknown; date: unknown; reference?: unknown; topup?: { lot: string; credits: number } };
export type PaymentError = "bad_amount" | "bad_plan" | "bad_date" | "bad_id" | "not_found";
const PAID_PLANS: readonly Plan[] = ["starter", "pro", "business", "agency"];
/** Today in Riyadh: payments and payouts are dated by the founder's calendar. */
const today = () => ksaDay();
/**
 * The first day among the payments that stand. `plan`: plan payments only, leaving out top-up packs' payments (`topup`).
 * The account's first payment day (`User.firstPaidOn`) and the first-month offer are the plan's (rule 454): a pack
 * recorded before the plan's first payment neither sets that day nor closes the offer, so the plan payment recorded after
 * it, backdated or not, still takes the offer.
 */
const firstLiveDay = (all: Record<string, Payment>, opts: { plan?: boolean } = {}) =>
  Object.values(all).filter((p) => !p.voidedAt && !(opts.plan && p.topup)).map((p) => p.date).sort()[0] as string | undefined;
/**
 * The day the partner's 30-day attribution check and 4-month window are measured from: the plan's first payment that
 * stands; only when none stands (the plan was activated with no payment recorded) the first top-up payment, so a paying
 * customer's pack is never left without a decision. Recording the plan payment later moves the start to it (`settle`).
 */
const windowStartDay = (all: Record<string, Payment>) => firstLiveDay(all, { plan: true }) ?? firstLiveDay(all);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A pack's refund (src/lib/topups.ts `TopupRefund`) as its payment records it (rule 462). */
const paymentRefund = (r: TopupRefund): NonNullable<Payment["refund"]> => ({ credits: r.credits, sar: r.sar, date: r.on, reference: r.ref, at: r.at, by: r.by });

/**
 * Re-take every commission decision of one customer from the payments that stand, and make the partner's ledger match
 * (rules 396-397). Runs under the customer's lock after any payment is recorded or voided, so a backdated payment or a
 * voided first payment moves every other payment's answer with the first payment day. Order: the payment records first
 * (each marked with the commission it carries), then the ledger under the partner's lock, compared with the rows that are
 * actually there. A request that failed halfway is repaired by the next one, and every ledger row has a payment that can
 * void it. Returns the payments as written and the ids whose answer changed (besides `changedId`).
 */
async function settle(e: string, u: User, all: Record<string, Payment>, now: string, changedId: string): Promise<{ payments: Record<string, Payment>; reclassified: string[] }> {
  const at = u.referredBy;
  const firstPaidOn = windowStartDay(all);
  let decide: (p: Payment) => { ok: true } | { ok: false; reason: NotCounted } = () => ({ ok: false, reason: "no_partner" });
  if (at && firstPaidOn) {
    const [partner, sameTeam] = await Promise.all([getPartner(at.partner), Promise.all([onRoster(e, at.partner), onRoster(at.partner, e)]).then((x) => x.some(Boolean))]);
    decide = (p) => commissionDecision({ customer: e, attribution: at, partnerExists: !!partner, sameTeam, firstPaidOn, paymentDate: p.date });
  }
  // A pack's refund its payment does not carry yet (a refund that stopped between its two writes, rule 465) is copied
  // from the pack first, so no request ever takes a commission on money that was paid back.
  const packRefunds = new Map(lotsOf(u).flatMap((l) => (l.refund ? [[l.id, l.refund] as const] : [])));
  const next: Record<string, Payment> = {};
  for (const stored of Object.values(all)) {
    const r = !stored.voidedAt && !stored.refund && stored.topup ? packRefunds.get(stored.topup.lot) : undefined;
    const p: Payment = r ? { ...stored, refund: paymentRefund(r) } : stored;
    if (p.voidedAt || !at) { next[p.id] = p; continue; }
    const rest: Payment = { ...p };
    delete rest.commission;
    delete rest.notCounted;
    const d = decide(p);
    // A refund of a pack's unused credits takes its share off the commission, once: the refund is one record on the
    // payment and this is re-derived from it every time (rule 460). A payment refunded in full keeps no commission.
    const sar = p.refund ? commissionAfterRefund(p.amountSar, p.refund.sar) : commissionSar(p.amountSar);
    next[p.id] = !d.ok ? { ...rest, notCounted: d.reason } : p.refund && sar <= 0 ? { ...rest, notCounted: "refunded" } : { ...rest, commission: { partner: at.partner, sar } };
  }
  const changed = Object.values(next).filter((p) => !same(p, all[p.id]) || p.id === changedId);
  await Promise.all(changed.map((p) => db.hset(paymentsKey(e), p.id, p)));
  const reclassified = changed.filter((p) => p.id !== changedId && !same(p.commission ?? p.notCounted, all[p.id]?.commission ?? all[p.id]?.notCounted)).map((p) => p.id);
  if (at) {
    const label = customerLabel(u);
    await withPartnerLock(at.partner, async () => {
      const ledger = await db.hgetall<LedgerRow>(ledgerKey(at.partner));
      const writes: [string, LedgerRow][] = [];
      for (const p of Object.values(next)) {
        const row = ledger[`c:${p.id}`];
        const live = row?.kind === "commission" && !row.voidedAt ? row : null;
        if (!p.voidedAt && p.commission) {
          // The base is what the customer kept paying: the amount less a refund of unused top-up credits (rule 460).
          const refundSar = p.refund ? Math.min(p.amountSar, p.refund.sar) : 0;
          const baseSar = fromHalalas(toHalalas(p.amountSar) - toHalalas(refundSar));
          if (!live || live.sar !== p.commission.sar || live.baseSar !== baseSar) writes.push([`c:${p.id}`, { kind: "commission", id: p.id, label, paymentDate: p.date, baseSar, sar: p.commission.sar, at: now, ...(refundSar ? { refundSar } : {}) }]);
        } else if (live) writes.push([`c:${p.id}`, { ...live, voidedAt: now }]);
      }
      await Promise.all(writes.map(([f, v]) => db.hset(ledgerKey(at.partner), f, v)));
    });
  }
  return { payments: next, reclassified };
}
const cleanText = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/**
 * Record a payment the founder received (SAR, excluding VAT: the commission base is the amount before VAT, rule 409).
 * Under the customer's lock: the plan's first payment (a top-up pack's payment never counts as one) uses the account's
 * first-month offer when it is dated on or after the
 * day the offer was granted and, for the early-partner offer, on or before its last day (rule 410: the day the money
 * arrived counts, so a payment made in time and recorded later still uses it); then every payment's commission is
 * re-taken (`settle`): 15% to the partner's ledger when the account is attributed, paid on or after attribution and within
 * its 30 days, inside the 4-month window and not a self or team referral. The id may come from the console, so a retried
 * request records nothing twice.
 */
export async function recordPayment(email: string, input: PaymentInput, by: string): Promise<{ ok: true; payment: Payment; already?: boolean; reclassified?: string[] } | { ok: false; error: PaymentError }> {
  if (!validAmount(input.amountSar)) return { ok: false, error: "bad_amount" };
  if (typeof input.plan !== "string" || !PAID_PLANS.includes(input.plan as Plan)) return { ok: false, error: "bad_plan" };
  // A payment is dated the day the money arrived: a real day, not after today in Riyadh.
  if (!validDay(input.date) || input.date > today()) return { ok: false, error: "bad_date" };
  if (input.id !== undefined && !(typeof input.id === "string" && /^pay_[a-f0-9]{8,32}$/.test(input.id))) return { ok: false, error: "bad_id" };
  const e = normalizeEmail(email);
  if (!(await getUser(e))) return { ok: false, error: "not_found" };
  const id = (input.id as string | undefined) ?? newId("pay");
  const amountSar = input.amountSar, plan = input.plan as Plan, date = input.date;
  const res = await withUserLock(e, async (u) => {
    const all = await db.hgetall<Payment>(paymentsKey(e));
    if (all[id]) return { ok: true as const, payment: all[id], already: true };
    const live = Object.values(all).filter((p) => !p.voidedAt);
    const topup = input.topup ? { lot: String(input.topup.lot), credits: Math.max(0, Math.trunc(Number(input.topup.credits)) || 0) } : undefined;
    const pay: Payment = { id, amountSar, plan, date, reference: cleanText(input.reference, 80), recordedAt: new Date().toISOString(), recordedBy: by, ...(topup ? { topup } : {}) };
    const offer = unusedOffer(u);
    const last = offer ? offerLastDay(u, offer) : null;
    // The first-month discount is a plan's first month: a top-up pack's payment never takes it, and a pack's payment
    // recorded earlier does not count as the plan's first payment (rule 454).
    const livePlan = live.filter((p) => !p.topup);
    if (offer && !topup && livePlan.length === 0 && date >= ksaDay(new Date(offer.at).getTime()) && (!last || date <= last)) {
      pay.offer = offer.kind;
      if ((SELF_SERVE_PLANS as readonly string[]).includes(plan)) pay.expectedSar = firstMonthPriceSar(plan as SelfServePlan);
      u.firstMonthOffer = { ...offer, usedAt: pay.recordedAt, paymentId: id };
    }
    const { payments, reclassified } = await settle(e, u, { ...all, [id]: pay }, pay.recordedAt, id);
    const first = firstLiveDay(payments, { plan: true });
    if (first) u.firstPaidOn = first;
    else delete u.firstPaidOn;
    await saveUser(u);
    return { ok: true as const, payment: payments[id], ...(reclassified.length ? { reclassified } : {}) };
  });
  // The credits referral (src/lib/referral.ts, rules 557-558): the first payment that stands, plan or top-up, pays the
  // referrer once. Outside this account's lock (the referrer's credits take the referrer's); a retry (`already`) runs it
  // again, so a request that stopped here is completed, and the claim inside makes any later run a no-op.
  if (res.ok && !res.payment.voidedAt) await rewardReferrer(e).catch((err) => console.error("referral reward failed", err instanceof Error ? err.message : "error"));
  return res;
}

/**
 * Void a payment (refunded, or entered by mistake). Every commission of the customer is re-taken (`settle`): this one's is
 * voided in the partner's ledger, and the others follow the new first payment day. When no other plan payment stands,
 * the account is back to unpaid: its first payment day goes, and the first-month offer this payment used is open again
 * (packs' payments that still stand keep neither, rule 454).
 * A top-up pack's payment whose pack is still live is refused here (`topup_live`, rule 455): it is voided with its pack
 * ("Void" in the console's Top-ups block, `voidPaidTopup`, which passes `withPack`), so a pack never keeps its credits
 * after its payment went, nor the other way round. Once the pack has expired, its payment is voided like any other.
 */
export async function voidPayment(email: string, id: unknown, by: string, reason: unknown, opts: { withPack?: boolean } = {}): Promise<{ ok: true; payment: Payment; reclassified?: string[] } | { ok: false; error: "not_found" | "topup_live" }> {
  const e = normalizeEmail(email);
  if (typeof id !== "string" || !/^pay_[a-f0-9]{8,32}$/.test(id) || !(await getUser(e))) return { ok: false, error: "not_found" };
  return withUserLock(e, async (u) => {
    const all = await db.hgetall<Payment>(paymentsKey(e));
    const p = all[id];
    if (!p) return { ok: false as const, error: "not_found" as const };
    if (p.voidedAt) return { ok: true as const, payment: p };
    if (p.topup && !opts.withPack && lotsOf(u).some((l) => l.id === p.topup!.lot)) return { ok: false as const, error: "topup_live" as const };
    const voided: Payment = { ...p, voidedAt: new Date().toISOString(), voidedBy: by, voidReason: cleanText(reason, 200) || undefined };
    const { payments, reclassified } = await settle(e, u, { ...all, [id]: voided }, voided.voidedAt!, id);
    const first = firstLiveDay(payments, { plan: true });
    if (first) u.firstPaidOn = first;
    else delete u.firstPaidOn;
    if (u.firstMonthOffer?.paymentId === id && !first) u.firstMonthOffer = { kind: u.firstMonthOffer.kind, pct: u.firstMonthOffer.pct, at: u.firstMonthOffer.at };
    await saveUser(u);
    return { ok: true as const, payment: payments[id], ...(reclassified.length ? { reclassified } : {}) };
  });
}

// ---- Top-up packs and their payments (rules 454-455) ----

export type PaidTopupError = "bad_id" | "payment_voided" | "topup_needs_paid_plan" | "too_many_topups" | "not_found" | Exclude<PaymentError, "not_found">;
export type PaidTopup = { ok: true; lot: TopupLot; before: number; credits: number; already: boolean; payment: Payment | null; reclassified?: string[] };

/**
 * The console's "Add top-up" (POST /api/admin/topups, rule 454): the pack goes on the account and, when something was
 * paid, its payment is recorded in `payments:{email}` through `recordPayment`, the same path and the same commission
 * decision as any payment (`settle`): a referred customer's top-up dated inside the partner's window earns 15% of the
 * amount before VAT. "Add top-up" is the one entry point for a pack's payment: the founder never records a top-up in the
 * Payments panel, which records plan payments only.
 *
 * Exactly once: the console sends one payment id per request (`pay_` and hex) and keeps it until the request succeeds.
 * The pack carries it (`addTopup` finds the pack again on a retry instead of adding one) and the payment is recorded
 * under it (`recordPayment` records nothing twice, and the partner's ledger has one row per payment id). A request that
 * failed between the two steps is completed by its retry. An id already used by a plan payment, or by a top-up payment
 * that was voided since, is refused before anything is written. A payment `recordPayment` refuses takes the pack it just
 * added off again (`parseTopup` checks the same rules first, so this is only a guard). A pack recorded with nothing paid
 * records no payment.
 */
export async function addPaidTopup(email: string, input: TopupRequest & { paymentId?: unknown }, by: string): Promise<PaidTopup | { ok: false; error: PaidTopupError }> {
  if (input.paymentId !== undefined && !(typeof input.paymentId === "string" && /^pay_[a-f0-9]{8,32}$/.test(input.paymentId))) return { ok: false, error: "bad_id" };
  const e = normalizeEmail(email);
  const id = (input.paymentId as string | undefined) ?? newId("pay");
  const prior = (await db.hgetall<Payment>(paymentsKey(e)))[id];
  if (prior && !prior.topup) return { ok: false, error: "bad_id" };
  if (prior?.voidedAt) return { ok: false, error: "payment_voided" };
  const added = await addTopup(e, { credits: input.credits, paidSar: input.paidSar, paidOn: input.paidOn, ref: input.ref, by, paymentId: id });
  if (!added.ok) return { ok: false, error: added.error === "topup_not_found" ? "not_found" : added.error };
  const { lot } = added;
  let payment: Payment | null = null;
  let reclassified: string[] | undefined;
  // A retry that finds its pack refunded since still records the payment: `settle` copies the pack's refund onto it.
  if (lot.paidSar > 0 && added.plan) {
    const rec = await recordPayment(e, { id, amountSar: lot.paidSar, plan: added.plan, date: lot.paidOn, reference: lot.ref, topup: { lot: lot.id, credits: lot.credits } }, by);
    if (!rec.ok) {
      if (rec.error !== "not_found" && !added.already) await voidTopup(e, lot.id);
      return { ok: false, error: rec.error };
    }
    payment = rec.payment;
    reclassified = rec.reclassified;
  }
  return { ok: true, lot, before: added.before, credits: added.credits, already: !!added.already, payment, ...(reclassified?.length ? { reclassified } : {}) };
}

/**
 * The console's "Void" on a pack (rule 455): its payment is voided first (`voidPayment` with `withPack`: the partner's
 * commission on it goes too), then the pack and its unspent credits leave the balance (`voidTopup`). In that order, a
 * request that failed halfway is completed by its retry: a voided payment voids again as a no-op, and the pack is still
 * there to remove. A pack with no recorded payment (nothing paid) only leaves.
 */
export async function voidPaidTopup(email: string, lotId: string, by: string, reason: unknown): Promise<{ ok: true; lot: TopupLot; before: number; credits: number; removed: number; payment: Payment | null; reclassified?: string[] } | { ok: false; error: "topup_not_found" | "not_found" }> {
  const e = normalizeEmail(email);
  const u = await getUser(e);
  if (!u) return { ok: false, error: "not_found" };
  const lot = lotsOf(u).find((l) => l.id === lotId);
  if (!lot) return { ok: false, error: "topup_not_found" };
  let payment: Payment | null = null;
  let reclassified: string[] | undefined;
  if (lot.paymentId) {
    const v = await voidPayment(e, lot.paymentId, by, reason, { withPack: true });
    if (v.ok) { payment = v.payment; reclassified = v.reclassified; }
  }
  const done = await voidTopup(e, lotId);
  if (!done.ok) return { ok: false, error: "topup_not_found" };
  return { ok: true, lot: done.lot, before: done.before, credits: done.credits, removed: done.removed ?? 0, payment, ...(reclassified?.length ? { reclassified } : {}) };
}

export type RefundTopupError = RefundUnusedError | "topup_voided" | "not_found" | "not_refunded" | "payment_missing";
export type RefundedTopup = {
  ok: true; lot: TopupLot; before: number; credits: number; refunded: { credits: number; sar: number };
  payment: Payment | null; commissionBefore?: number; reclassified?: string[];
  /** A retry of a refund already recorded in full (same request id, or "Finish refund" on a finished one): nothing changed. */
  already?: boolean;
  /** A refund that stopped after the credits left and before its payment was marked: this request finished it. */
  completed?: boolean;
};
/** "Refund unused" (the credits shown, the transfer's day and reference), or "Finish refund" on a pack already refunded. */
export type RefundTopupInput = (RefundRequest & { id?: string; finish?: false }) | { finish: true; id?: string };

/**
 * The console's "Refund unused" on a live pack (founder decision of 2026-10-02, rule 460): the customer asked for the
 * money of the credits still unused, before the pack expires, and the founder transfers it by hand. One critical section
 * under the account's ledger lock, so a charge racing the refund either lands before it (and its credits are not
 * refunded) or after it (and finds them gone): `refundUnused` takes exactly the credits left out of the pack and the
 * balance and the record is saved first; then the refund is recorded on the pack's payment and `settle` re-takes the
 * partner's commission on it, reduced by commission × refunded / paid (`commissionAfterRefund`), once.
 *
 * Refused (nothing changed): 404 `topup_not_found` for a pack that never was on the account, 409 `topup_expired` once it
 * expired, `topup_voided` once its payment was voided, `topup_refunded` once refunded (a retry with the same request
 * id instead answers `already`), `topup_not_paid` for a pack given for nothing, `nothing_left`, and `left_changed` when
 * the credits left are not the ones the founder was shown.
 *
 * Finishing (rule 465): a refund that stopped between its two writes (the credits gone, the payment not marked) is
 * finished by the next "refund" request for that pack, and the console offers it as "Finish refund" (`finish: true`, no
 * credits, day or reference: they are the pack's), which answers `completed`, `already` when there was nothing left to
 * do, or 409 `not_refunded` on a pack never refunded. Any later payment change on the account finishes it too (`settle`
 * copies the pack's refund onto its payment). A pack whose "Add top-up" stopped before its payment was recorded
 * (`paymentId` set, no payment) has that payment recorded here, as "Add top-up" would have, with the refund on it, so
 * the partner keeps the commission on the share kept and the pack's day still counts for the partner's windows; on an
 * account no longer on a paid plan this is refused (409 `payment_missing`: retry "Add top-up" first).
 */
export async function refundPaidTopup(email: string, lotId: string, input: RefundTopupInput, by: string, now = Date.now()): Promise<RefundedTopup | { ok: false; error: RefundTopupError; left?: number; sar?: number }> {
  const e = normalizeEmail(email);
  if (!(await getUser(e))) return { ok: false, error: "not_found" };
  return withUserLock(e, async (u): Promise<RefundedTopup | { ok: false; error: RefundTopupError; left?: number; sar?: number }> => {
    const all = await db.hgetall<Payment>(paymentsKey(e));
    const lot = lotsOf(u).find((l) => l.id === lotId);
    const stored = (lot?.paymentId ? all[lot.paymentId] : undefined) ?? Object.values(all).find((p) => p.topup?.lot === lotId);
    if (!lot) {
      // Gone from the account: say why, from the pack's payment.
      if (!stored) return { ok: false, error: "topup_not_found" };
      return { ok: false, error: stored.refund ? "topup_refunded" : stored.voidedAt ? "topup_voided" : "topup_expired" };
    }
    if (stored?.voidedAt) return { ok: false, error: "topup_voided" };
    // The pack's payment as "Add top-up" records it, when that request stopped before recording it (rule 465).
    const missing = !stored && !!lot.paymentId && lot.paidSar > 0;
    if (missing && !PAID_PLANS.includes(u.plan)) return { ok: false, error: "payment_missing" };
    const pay: Payment | undefined = stored ?? (missing
      ? { id: lot.paymentId!, amountSar: lot.paidSar, plan: u.plan, date: lot.paidOn, reference: cleanText(lot.ref, 80), recordedAt: lot.at, recordedBy: lot.by, topup: { lot: lot.id, credits: lot.credits } }
      : undefined);
    const credits = Number.isFinite(u.credits) ? Math.max(0, Math.trunc(u.credits)) : 0;
    const iso = new Date(now).toISOString();
    /** Mark the payment refunded as the pack says, and re-take the commission on it. */
    const markPayment = async (r: TopupRefund) => {
      if (!pay) return { payment: null as Payment | null };
      const marked: Payment = { ...pay, refund: paymentRefund(r) };
      const { payments, reclassified } = await settle(e, u, { ...all, [pay.id]: marked }, iso, pay.id);
      return { payment: payments[pay.id], ...(reclassified.length ? { reclassified } : {}) };
    };
    if (lot.refund) {
      const r = lot.refund;
      const refunded = { credits: r.credits, sar: r.sar };
      if (pay && !stored?.refund) {
        const m = await markPayment(r);
        return { ok: true, lot, before: credits, credits, refunded, commissionBefore: stored?.commission?.sar, ...m, completed: true };
      }
      if (input.finish || (input.id && r.id === input.id)) return { ok: true, lot, before: credits, credits, refunded, payment: pay ?? null, already: true };
      return { ok: false, error: "topup_refunded" };
    }
    if (input.finish) return { ok: false, error: "not_refunded" };
    const done = refundUnused(u, lotId, { expected: input.credits, on: input.on, ref: input.ref, by, ...(input.id ? { id: input.id } : {}) }, now);
    if (!done.ok) return { ok: false, error: done.error, ...(done.left !== undefined ? { left: done.left, sar: done.sar } : {}) };
    // The credits leave first: once this is saved, no charge can spend them, whatever happens to the next write.
    await saveUser(u);
    const m = await markPayment(done.lot.refund!);
    return { ok: true, lot: done.lot, before: credits, credits: u.credits, refunded: { credits: done.credits, sar: done.sar }, commissionBefore: stored?.commission?.sar, ...m };
  });
}

/**
 * The packs of an account whose refund is not on their payment yet (rule 465): the console offers "Finish refund" on
 * them. One read of the account's payments.
 */
export async function unfinishedRefunds(u: Pick<User, "email" | "topups">): Promise<string[]> {
  const refunded = lotsOf(u).filter((l) => l.refund && l.paymentId && l.paidSar > 0);
  if (!refunded.length) return [];
  const all = await db.hgetall<Payment>(paymentsKey(normalizeEmail(u.email)));
  return refunded.filter((l) => { const p = all[l.paymentId!]; return !p || (!p.voidedAt && !p.refund); }).map((l) => l.id);
}

/** The founder console's payment card for one account. */
export async function paymentsView(email: string) {
  const e = normalizeEmail(email);
  const [u, all] = await Promise.all([getUser(e), db.hgetall<Payment>(paymentsKey(e))]);
  if (!u) return null;
  const payments = Object.values(all).sort((a, b) => (a.date === b.date ? (a.recordedAt < b.recordedAt ? 1 : -1) : a.date < b.date ? 1 : -1));
  const offer = openOffer(u);
  const unused = unusedOffer(u);
  // `until`: the offer's last day (the early-partner offer's, rule 410). `expired`: unused and past it, so a payment
  // recorded now uses it only when dated on or before `until`.
  const until = u.firstMonthOffer ? offerLastDay(u, u.firstMonthOffer) : null;
  return {
    // `livePacks`: the ids of the account's live top-up packs, so the panel offers "Void" on a top-up payment only once
    // its pack is gone (rule 455).
    payments, livePacks: lotsOf(u).map((l) => l.id), firstPaidOn: u.firstPaidOn ?? null, offer: u.firstMonthOffer ?? null, open: !!offer, until, expired: !!unused && !offer,
    expected: offer ? offerPrices() : null,
    referredBy: u.referredBy ? { ...u.referredBy, status: referralStatus(u.referredBy.at, u.firstPaidOn) } : null,
  };
}

// ---- Applications and partners (founder console) ----

export async function listApplications(): Promise<(Omit<Application, "consentAt" | "termsVersion"> & { consentAt: string | null; termsVersion: string | null; decision: Decision | null; suggested: string })[]> {
  const [rows, decisions] = await Promise.all([db.lrange(APPLICATIONS, 0, 499), db.hgetall<Decision>(DECISIONS)]);
  return rows.flatMap((r) => {
    try {
      const a = JSON.parse(r) as Partial<Application>;
      const id = applicationId(a);
      return [{
        id, name: a.name ?? "", email: a.email ?? "", phone: a.phone ?? "", channel: a.channel ?? "", audience: a.audience ?? "", lang: a.lang === "en" ? "en" as const : "ar" as const, at: a.at ?? "",
        consentAt: a.consentAt ?? null, termsVersion: a.termsVersion ?? null, ...(typeof a.country === "string" ? { country: a.country } : {}),
        decision: decisions[id] ?? null, suggested: suggestCode(a.name ?? "", a.email ?? ""),
      }];
    } catch {
      return [];
    }
  });
}

/** The stored application with this id, or null (the same 500 the console lists). */
async function applicationById(appId: string): Promise<Partial<Application> | null> {
  for (const r of await db.lrange(APPLICATIONS, 0, 499)) {
    try {
      const a = JSON.parse(r) as Partial<Application>;
      if (applicationId(a) === appId) return a;
    } catch { /* a malformed row is skipped, as in listApplications */ }
  }
  return null;
}

export type ApproveError = "bad_code" | "reserved_code" | "bad_email" | "member_login" | "already_partner" | "code_taken" | "no_consent";
/**
 * Approve a partner: claim the code (unique among partners and the credits-referral codes) and link it to the
 * applicant's email. The account need not exist yet: whoever signs up with that address later gets the partner page
 * (`afterSignup`). A member login cannot be a partner: it has no account of its own to be paid through.
 * No partner without a recorded agreement to the terms (rule 415): the consent is taken from the application (same
 * email, consent date and version stored), or the founder states that the applicant agreed outside the form
 * (`consentOutOfBand: true`, recorded with who and when, and logged by the route); otherwise `no_consent`.
 */
export async function approvePartner(input: { email: unknown; name?: unknown; code: unknown; appId?: unknown; consentOutOfBand?: unknown }, by: string): Promise<{ ok: true; partner: Partner } | { ok: false; error: ApproveError }> {
  const code = normalizeCode(input.code);
  const problem = codeProblem(code);
  if (problem) return { ok: false, error: problem };
  const email = normalizeEmail(typeof input.email === "string" ? input.email : "");
  if (!validEmail(email)) return { ok: false, error: "bad_email" };
  const login = await getLogin(email);
  if (login?.kind === "member") return { ok: false, error: "member_login" };
  const appId = typeof input.appId === "string" && /^app_[a-f0-9]{8,32}$/.test(input.appId) ? input.appId : undefined;
  const now = new Date().toISOString();
  const app = appId ? await applicationById(appId) : null;
  const terms: TermsConsent | null =
    app?.consentAt && app.termsVersion && normalizeEmail(app.email ?? "") === email ? { at: app.consentAt, version: app.termsVersion, via: "application" }
      : input.consentOutOfBand === true ? { at: now, version: PARTNER_TERMS_VERSION, via: "founder", by }
        : null;
  if (!terms) return { ok: false, error: "no_consent" };
  const res = await withRegistryLock(async (): Promise<Partner | ApproveError> => {
    const [existing, holder, credits] = await Promise.all([getPartner(email), db.get<string>(codeKey(code)), db.get<string>(`ref:${code}`)]);
    if (existing) return "already_partner";
    if (holder || credits) return "code_taken";
    const partner: Partner = { email, name: cleanText(input.name, 80) || (login?.kind === "owner" ? login.user.name : ""), code, approvedAt: now, approvedBy: by, hadAccount: login?.kind === "owner", ...(appId ? { appId } : {}), terms };
    await Promise.all([
      db.set(partnerKey(email), partner),
      db.set(codeKey(code), email),
      db.sadd(PARTNERS, email),
      appId ? db.hset(DECISIONS, appId, { status: "approved", code, at: now, by } satisfies Decision) : null,
    ]);
    return partner;
  });
  if (typeof res === "string") return { ok: false, error: res };
  if (login?.kind === "owner") await withUserLock(email, async (u) => { u.partnerCode = code; await saveUser(u); });
  return { ok: true, partner: res };
}

export async function rejectApplication(appId: unknown, by: string): Promise<boolean> {
  if (typeof appId !== "string" || !/^app_[a-f0-9]{8,32}$/.test(appId)) return false;
  await db.hset(DECISIONS, appId, { status: "rejected", at: new Date().toISOString(), by } satisfies Decision);
  return true;
}

export type PayoutError = "not_found" | "bad_id" | "bad_date" | "bad_amount" | "bad_vat" | "bad_wht" | "below_minimum" | "over_balance" | "bank_unconfirmed";
/**
 * Mark a bank transfer paid (rule 398). Only a payable balance (SAR 200 or more) is paid down, never past it, and only to
 * bank details the founder confirmed after their last change, under the partner's lock. The id may come from the console,
 * so a double press or a retry records the transfer once. `vatSar` (VAT paid on top to a VAT-registered partner) and
 * `whtSar` (withholding tax Thakeen bore) are optional and recorded for the books only (rule 412): the partner receives
 * the full commission, so neither changes the balance or the payable check.
 */
export async function recordPayout(email: string, input: { id?: unknown; amountSar: unknown; vatSar?: unknown; whtSar?: unknown; date: unknown; reference?: unknown }, by: string): Promise<{ ok: true; payout: Payout; already?: boolean } | { ok: false; error: PayoutError }> {
  const e = normalizeEmail(email);
  if (input.id !== undefined && !(typeof input.id === "string" && /^po_[a-f0-9]{8,32}$/.test(input.id))) return { ok: false, error: "bad_id" };
  if (!validDay(input.date) || input.date > today()) return { ok: false, error: "bad_date" };
  const vat = optionalTax(input.vatSar), wht = optionalTax(input.whtSar);
  if (!vat.ok) return { ok: false, error: "bad_vat" };
  if (!wht.ok) return { ok: false, error: "bad_wht" };
  if (!(await getPartner(e))) return { ok: false, error: "not_found" };
  const date = input.date;
  const id = (input.id as string | undefined) ?? newId("po");
  return withPartnerLock(e, async () => {
    const [ledger, p] = await Promise.all([db.hgetall<LedgerRow>(ledgerKey(e)), getPartner(e)]);
    const prior = ledger[`p:${id}`];
    if (prior?.kind === "payout") return { ok: true as const, payout: prior, already: true };
    if (!p) return { ok: false as const, error: "not_found" as const };
    if (!bankConfirmed(p.bank)) return { ok: false as const, error: "bank_unconfirmed" as const };
    const problem = payoutProblem(Object.values(ledger), input.amountSar);
    if (problem) return { ok: false as const, error: problem };
    const payout: Payout = {
      kind: "payout", id, sar: input.amountSar as number, ...(vat.sar ? { vatSar: vat.sar } : {}), ...(wht.sar ? { whtSar: wht.sar } : {}),
      date, reference: cleanText(input.reference, 80), at: new Date().toISOString(), by,
    };
    await db.hset(ledgerKey(e), `p:${id}`, payout);
    return { ok: true as const, payout };
  });
}

/** Void a payout entered by mistake (rule 398): kept on record, its amount is back in the balance. Under the partner's lock. */
export async function voidPayout(email: string, id: unknown, by: string, reason: unknown): Promise<{ ok: true; payout: Payout } | { ok: false; error: "not_found" }> {
  const e = normalizeEmail(email);
  if (typeof id !== "string" || !/^po_[a-f0-9]{8,32}$/.test(id)) return { ok: false, error: "not_found" };
  return withPartnerLock(e, async () => {
    const row = (await db.hgetall<LedgerRow>(ledgerKey(e)))[`p:${id}`];
    if (row?.kind !== "payout") return { ok: false as const, error: "not_found" as const };
    if (row.voidedAt) return { ok: true as const, payout: row };
    const voided: Payout = { ...row, voidedAt: new Date().toISOString(), voidedBy: by, voidReason: cleanText(reason, 200) || undefined };
    await db.hset(ledgerKey(e), `p:${id}`, voided);
    return { ok: true as const, payout: voided };
  });
}

/**
 * The founder confirms the partner's bank details after checking them with the partner out of band (by phone, from the
 * application). `savedAt` names the version the founder saw: details changed since then are not confirmed.
 */
export async function confirmBank(email: string, savedAt: unknown, by: string): Promise<{ ok: true } | { ok: false; error: "not_found" | "no_bank" | "changed" }> {
  const e = normalizeEmail(email);
  return withPartnerLock(e, async () => {
    const p = await getPartner(e);
    if (!p) return { ok: false as const, error: "not_found" as const };
    if (!p.bank) return { ok: false as const, error: "no_bank" as const };
    if (p.bank.savedAt !== savedAt) return { ok: false as const, error: "changed" as const };
    await db.set(partnerKey(e), { ...p, bank: { ...p.bank, confirmedAt: new Date().toISOString(), confirmedBy: by } } satisfies Partner);
    return { ok: true as const };
  });
}

const byNewest = <T extends { at: string }>(a: T, b: T) => (a.at < b.at ? 1 : -1);

/**
 * Every partner for the founder: code, referrals, balances, commissions, payouts and bank details in full, whether the
 * bank details are confirmed, and whether the partner's account was created after the approval (the address was then
 * claimed by whoever signed up with it first: confirm the person before paying). A commission shows its customer's email
 * while that customer is still a referral; a deleted customer shows only the label. `tax`: the flags the founder checks
 * before a transfer (VAT-registered, outside Saudi Arabia, rule 412), and the VAT paid and withholding borne so far.
 * `terms`: the partner's recorded agreement to the programme terms (rule 415), null when none was recorded.
 */
export async function listPartners() {
  const emails = await db.smembers(PARTNERS);
  const [records, owners, refSets, ledgers] = await Promise.all([
    db.mget<Partner>(emails.map(partnerKey)),
    db.mget<User>(emails.map((e) => `user:${e}`)),
    pmap(emails, (e) => db.smembers(refsKey(e))),
    pmap(emails, (e) => db.hgetall<LedgerRow>(ledgerKey(e))),
  ]);
  const refEmails = [...new Set(refSets.flatMap((r) => r.slice(0, 500)))];
  const refUsers = refEmails.length ? await db.mget<User>(refEmails.map((r) => `user:${r}`)) : [];
  const byLabel = new Map(refUsers.flatMap((u) => (u?.referredBy ? [[`${u.referredBy.partner}|${customerLabel(u)}`, u.email] as const] : [])));
  return emails.flatMap((e, i) => {
    const p = records[i];
    if (!p) return [];
    const rows = Object.values(ledgers[i]);
    const owner = owners[i];
    return [{
      email: p.email, name: p.name, code: p.code, approvedAt: p.approvedAt, terms: p.terms ?? null, bank: p.bank ?? null, bankConfirmed: bankConfirmed(p.bank),
      accountAfterApproval: !!owner && (p.hadAccount === undefined ? owner.createdAt > p.approvedAt : !p.hadAccount), hasAccount: !!owner, referrals: refSets[i].length,
      ...balances(rows),
      tax: { ...taxFlags(p.bank), ...taxTotals(rows) },
      commissions: rows.filter((r): r is Commission => r.kind === "commission").sort(byNewest).slice(0, 100)
        .map((c) => ({ ...c, customer: byLabel.get(`${e}|${c.label}`) ?? null })),
      payouts: rows.filter((r): r is Payout => r.kind === "payout").sort(byNewest),
    }];
  }).sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1));
}

// ---- The partner's own page ----

export type PartnerReferral = { label: string; signedUpOn: string; status: ReferralStatus; months: number };
/**
 * What a partner sees: their code, their referrals with no customer name or email (`customerLabel`), the ledger and their
 * bank details masked. Null when this account is not a partner.
 */
export async function partnerDashboard(email: string, now: number = Date.now()) {
  const e = normalizeEmail(email);
  const partner = await getPartner(e);
  if (!partner) return null;
  const [refs, ledger] = await Promise.all([db.smembers(refsKey(e)), db.hgetall<LedgerRow>(ledgerKey(e))]);
  const rows = Object.values(ledger);
  const commissions = rows.filter((r): r is Commission => r.kind === "commission");
  const users = await db.mget<User>(refs.slice(0, 500).map((r) => `user:${r}`));
  const referrals: PartnerReferral[] = users.flatMap((u) => {
    if (!u?.referredBy || u.referredBy.partner !== e) return [];
    const label = customerLabel(u);
    const months = new Set(commissions.filter((c) => c.label === label && !c.voidedAt).map((c) => c.paymentDate.slice(0, 7))).size;
    return [{ label, signedUpOn: u.createdAt.slice(0, 10), status: referralStatus(u.referredBy.at, u.firstPaidOn, now), months }];
  }).sort((a, b) => (a.signedUpOn < b.signedUpOn ? 1 : -1));
  return {
    code: partner.code, name: partner.name,
    bank: partner.bank ? {
      holder: partner.bank.holder, iban: maskIban(partner.bank.iban), country: partner.bank.country ?? null, taxNumber: partner.bank.taxNumber ?? null, vatRegistered: !!partner.bank.vatRegistered,
      savedAt: partner.bank.savedAt, confirmed: bankConfirmed(partner.bank),
    } : null,
    referrals,
    ...balances(rows),
    commissions: commissions.sort(byNewest).slice(0, 200).map((c) => ({ label: c.label, paymentDate: c.paymentDate, baseSar: c.baseSar, sar: c.sar, voided: !!c.voidedAt })),
    // The VAT Thakeen paid on top is the partner's own money and shows; the withholding Thakeen bore is its own cost.
    payouts: rows.filter((r): r is Payout => r.kind === "payout").sort(byNewest).map((p) => ({ date: p.date, sar: p.sar, vatSar: p.vatSar ?? 0, reference: p.reference, voided: !!p.voidedAt })),
  };
}

export type BankError = "not_partner" | "bad_holder" | "bad_iban" | "bad_country" | "country_closed" | "bad_tax_number" | "vat_number_required";
export type BankInput = { holder?: unknown; iban?: unknown; country?: unknown; taxNumber?: unknown; vatRegistered?: unknown };
/**
 * The partner's own payout details (rule 411): account holder, any country's valid IBAN, the country the partner lives
 * in, an optional VAT or tax registration number and, separately, whether the partner is VAT-registered (only `true`
 * counts; it needs the number). Never logged; the partner gets the IBAN back masked. Every save clears the founder's
 * confirmation, so no payout is marked paid to details nobody checked with the partner.
 */
export async function saveBank(email: string, input: BankInput): Promise<{ ok: true; bank: { holder: string; iban: string; country: string; taxNumber: string | null; vatRegistered: boolean } } | { ok: false; error: BankError }> {
  const holder = cleanText(input.holder, 80);
  if (holder.length < 2) return { ok: false, error: "bad_holder" };
  const iban = validIban(input.iban);
  if (!iban) return { ok: false, error: "bad_iban" };
  const country = validCountry(input.country);
  if (!country) return { ok: false, error: "bad_country" };
  // Saudi Arabia only for now (rule 1471), like the application.
  if (!PARTNER_COUNTRIES.includes(country)) return { ok: false, error: "country_closed" };
  const taxNumber = taxNumberOf(input.taxNumber);
  if (taxNumber === "bad") return { ok: false, error: "bad_tax_number" };
  const vatRegistered = input.vatRegistered === true;
  if (vatRegistered && !taxNumber) return { ok: false, error: "vat_number_required" };
  const e = normalizeEmail(email);
  const res = await withPartnerLock(e, async () => {
    const p = await getPartner(e);
    if (!p) return false;
    const bank: Bank = { holder, iban, country, ...(taxNumber ? { taxNumber } : {}), ...(vatRegistered ? { vatRegistered } : {}), savedAt: new Date().toISOString() };
    await db.set(partnerKey(e), { ...p, bank } satisfies Partner);
    return true;
  });
  return res ? { ok: true, bank: { holder, iban: maskIban(iban), country, taxNumber: taxNumber ?? null, vatRegistered } } : { ok: false, error: "not_partner" };
}

// ---- Account deletion (src/lib/account.ts `wipeAccount`) ----

/**
 * The partner-programme keys of an account that is being deleted: its payments and, for a partner, the record (bank
 * details included), code, referral set and ledger. The account is also taken out of its own partner's referral set.
 * Ledger rows never carry a customer's email (only the label), so no deleted address stays listed anywhere.
 */
export async function forgetPartnerData(email: string): Promise<string[]> {
  const e = normalizeEmail(email);
  const [u, partner] = await Promise.all([getUser(e), getPartner(e)]);
  await Promise.all([u?.referredBy ? db.srem(refsKey(u.referredBy.partner), e) : null, partner ? db.srem(PARTNERS, e) : null]);
  return [paymentsKey(e), partnerKey(e), refsKey(e), ledgerKey(e), ...(partner ? [codeKey(partner.code)] : [])];
}
