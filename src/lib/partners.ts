import { cookies } from "next/headers";
import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { getLogin, getUser, normalizeEmail, saveUser, sessionCookie, validEmail, type Plan, type User } from "./auth";
import { withUserLock } from "./credits";
import { pmap } from "./parallel";
import { onRoster } from "./team";
import { lifecyclePlan } from "./lifecycle";
import { FIRST_MONTH_DISCOUNT_PCT, SELF_SERVE_PLANS, firstMonthPriceSar, type SelfServePlan } from "./pricing";
import {
  CUSTOMER_LABEL_PREFIX, PARTNER_COOKIE, PARTNER_COOKIE_DAYS, balances, bankConfirmed, codeProblem, commissionDecision, commissionSar,
  ksaDay, maskIban, normalizeCode, parsePartnerCookie, payoutProblem, referralStatus, saIban, suggestCode, validAmount, validDay,
  type Attribution, type Bank, type Commission, type LedgerRow, type NotCounted, type Payout, type ReferralStatus,
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
 * - `affiliate-applications` (list, the public form) and `affiliate:decisions` (hash, application id → approve/reject).
 *
 * The customer side lives on the account record (`User.referredBy`, `firstMonthOffer`, `firstPaidOn`, `partnerCode`),
 * always written under `withUserLock`.
 */

export type { Bank };
/** `hadAccount`: the address already had an owner account at approval; when false, whoever signed up with it later holds it. */
export type Partner = { email: string; name: string; code: string; approvedAt: string; approvedBy: string; appId?: string; hadAccount?: boolean; bank?: Bank };
export type FirstMonthOffer = NonNullable<User["firstMonthOffer"]>;
export type Payment = {
  id: string; amountSar: number; plan: Plan; date: string; reference: string; recordedAt: string; recordedBy: string;
  /** The first-month discount this payment used, and the discounted list price the founder was shown. */
  offer?: FirstMonthOffer["kind"]; expectedSar?: number;
  commission?: { partner: string; sar: number }; notCounted?: NotCounted;
  voidedAt?: string; voidedBy?: string; voidReason?: string;
};
export type Application = { id: string; name: string; email: string; phone: string; channel: string; audience: string; lang: "ar" | "en"; at: string };
export type Decision = { status: "approved" | "rejected"; code?: string; at: string; by: string };

const partnerKey = (email: string) => `partner:${email}`;
const codeKey = (code: string) => `partnercode:${code}`;
const PARTNERS = "partners:all";
const refsKey = (email: string) => `partner:refs:${email}`;
const ledgerKey = (email: string) => `partner:ledger:${email}`;
const paymentsKey = (email: string) => `payments:${email}`;
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
  return parsePartnerCookie((await cookies()).get(PARTNER_COOKIE)?.value);
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
  if (jar.get(PARTNER_COOKIE)) jar.delete(PARTNER_COOKIE);
  return done;
}

export type ClaimError = "bad_partner_code" | "self_referral" | "already_attributed" | "already_paid";
/**
 * The billing page's partner-code field: an account still on its trial, never attributed and never paid, takes a
 * partner's code. The account keeps the one first-month offer it may already have (discounts never stack).
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
    if (!x.firstMonthOffer) x.firstMonthOffer = { kind: "partner", pct: FIRST_MONTH_DISCOUNT_PCT, at };
    await saveUser(x);
    return null;
  });
  if (res) return { ok: false, error: res };
  await db.sadd(refsKey(partner.email), u.email);
  return { ok: true, code: partner.code };
}

// ---- The first-month offer ----

/** The unused first-month offer of an account, or null. One per account, whichever came first. */
export const openOffer = (u: Pick<User, "firstMonthOffer" | "firstPaidOn">): FirstMonthOffer | null =>
  u.firstMonthOffer && !u.firstMonthOffer.usedAt && !u.firstPaidOn ? u.firstMonthOffer : null;
/** The cron's moment: the day-3 trial note is due (src/lib/lifecycle.ts `lifecyclePlan`), whether or not mail is set up. */
export const earlyOfferDue = (u: User, now: number = Date.now()) =>
  !u.firstMonthOffer && !u.firstPaidOn && lifecyclePlan(u, now).some(([k, due]) => k === "day3" && due);
/** How long after the trial's end the billing page still grants a missed early-partner offer (a missed cron run). */
export const OFFER_GRACE_MS = 72 * 36e5;
/**
 * The billing page: a trial in its last day, or ended less than 3 days ago, with no offer yet: the cron's moment plus a
 * grace for a missed run. A trial that ended long before is not owed it (the founder granted the offer for the last day
 * of the trial; whether older trials get it is an open founder question).
 */
export const lastDayOfferOwed = (u: User, now: number = Date.now()) => {
  const left = new Date(u.trialEnds).getTime() - now;
  return u.plan === "trial" && !u.firstMonthOffer && !u.firstPaidOn && left <= 24 * 36e5 && left > -OFFER_GRACE_MS;
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

export type PaymentInput = { id?: unknown; amountSar: unknown; plan: unknown; date: unknown; reference?: unknown };
export type PaymentError = "bad_amount" | "bad_plan" | "bad_date" | "bad_id" | "not_found";
const PAID_PLANS: readonly Plan[] = ["starter", "pro", "business", "agency"];
/** Today in Riyadh: payments and payouts are dated by the founder's calendar. */
const today = () => ksaDay();
const firstLiveDay = (all: Record<string, Payment>) => Object.values(all).filter((p) => !p.voidedAt).map((p) => p.date).sort()[0] as string | undefined;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
  const firstPaidOn = firstLiveDay(all);
  let decide: (p: Payment) => { ok: true } | { ok: false; reason: NotCounted } = () => ({ ok: false, reason: "no_partner" });
  if (at && firstPaidOn) {
    const [partner, sameTeam] = await Promise.all([getPartner(at.partner), Promise.all([onRoster(e, at.partner), onRoster(at.partner, e)]).then((x) => x.some(Boolean))]);
    decide = (p) => commissionDecision({ customer: e, attribution: at, partnerExists: !!partner, sameTeam, firstPaidOn, paymentDate: p.date });
  }
  const next: Record<string, Payment> = {};
  for (const p of Object.values(all)) {
    if (p.voidedAt || !at) { next[p.id] = p; continue; }
    const rest: Payment = { ...p };
    delete rest.commission;
    delete rest.notCounted;
    const d = decide(p);
    next[p.id] = d.ok ? { ...rest, commission: { partner: at.partner, sar: commissionSar(p.amountSar) } } : { ...rest, notCounted: d.reason };
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
          if (!live || live.sar !== p.commission.sar) writes.push([`c:${p.id}`, { kind: "commission", id: p.id, label, paymentDate: p.date, baseSar: p.amountSar, sar: p.commission.sar, at: now }]);
        } else if (live) writes.push([`c:${p.id}`, { ...live, voidedAt: now }]);
      }
      await Promise.all(writes.map(([f, v]) => db.hset(ledgerKey(at.partner), f, v)));
    });
  }
  return { payments: next, reclassified };
}
const cleanText = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/**
 * Record a payment the founder received (SAR, excluding VAT). Under the customer's lock: the first payment uses the
 * account's first-month offer (never a payment dated before the offer was granted); then every payment's commission is
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
  return withUserLock(e, async (u) => {
    const all = await db.hgetall<Payment>(paymentsKey(e));
    if (all[id]) return { ok: true as const, payment: all[id], already: true };
    const live = Object.values(all).filter((p) => !p.voidedAt);
    const pay: Payment = { id, amountSar, plan, date, reference: cleanText(input.reference, 80), recordedAt: new Date().toISOString(), recordedBy: by };
    const offer = openOffer(u);
    if (offer && live.length === 0 && date >= ksaDay(new Date(offer.at).getTime())) {
      pay.offer = offer.kind;
      if ((SELF_SERVE_PLANS as readonly string[]).includes(plan)) pay.expectedSar = firstMonthPriceSar(plan as SelfServePlan);
      u.firstMonthOffer = { ...offer, usedAt: pay.recordedAt, paymentId: id };
    }
    const { payments, reclassified } = await settle(e, u, { ...all, [id]: pay }, pay.recordedAt, id);
    u.firstPaidOn = firstLiveDay(payments);
    await saveUser(u);
    return { ok: true as const, payment: payments[id], ...(reclassified.length ? { reclassified } : {}) };
  });
}

/**
 * Void a payment (refunded, or entered by mistake). Every commission of the customer is re-taken (`settle`): this one's is
 * voided in the partner's ledger, and the others follow the new first payment day. When no other payment stands, the
 * account is back to unpaid: its first payment day goes, and the first-month offer this payment used is open again.
 */
export async function voidPayment(email: string, id: unknown, by: string, reason: unknown): Promise<{ ok: true; payment: Payment; reclassified?: string[] } | { ok: false; error: "not_found" }> {
  const e = normalizeEmail(email);
  if (typeof id !== "string" || !/^pay_[a-f0-9]{8,32}$/.test(id) || !(await getUser(e))) return { ok: false, error: "not_found" };
  return withUserLock(e, async (u) => {
    const all = await db.hgetall<Payment>(paymentsKey(e));
    const p = all[id];
    if (!p) return { ok: false as const, error: "not_found" as const };
    if (p.voidedAt) return { ok: true as const, payment: p };
    const voided: Payment = { ...p, voidedAt: new Date().toISOString(), voidedBy: by, voidReason: cleanText(reason, 200) || undefined };
    const { payments, reclassified } = await settle(e, u, { ...all, [id]: voided }, voided.voidedAt!, id);
    const first = firstLiveDay(payments);
    if (first) u.firstPaidOn = first;
    else delete u.firstPaidOn;
    if (u.firstMonthOffer?.paymentId === id && !first) u.firstMonthOffer = { kind: u.firstMonthOffer.kind, pct: u.firstMonthOffer.pct, at: u.firstMonthOffer.at };
    await saveUser(u);
    return { ok: true as const, payment: payments[id], ...(reclassified.length ? { reclassified } : {}) };
  });
}

/** The founder console's payment card for one account. */
export async function paymentsView(email: string) {
  const e = normalizeEmail(email);
  const [u, all] = await Promise.all([getUser(e), db.hgetall<Payment>(paymentsKey(e))]);
  if (!u) return null;
  const payments = Object.values(all).sort((a, b) => (a.date === b.date ? (a.recordedAt < b.recordedAt ? 1 : -1) : a.date < b.date ? 1 : -1));
  const offer = openOffer(u);
  return {
    payments, firstPaidOn: u.firstPaidOn ?? null, offer: u.firstMonthOffer ?? null, open: !!offer,
    expected: offer ? offerPrices() : null,
    referredBy: u.referredBy ? { ...u.referredBy, status: referralStatus(u.referredBy.at, u.firstPaidOn) } : null,
  };
}

// ---- Applications and partners (founder console) ----

export async function listApplications(): Promise<(Application & { decision: Decision | null; suggested: string })[]> {
  const [rows, decisions] = await Promise.all([db.lrange(APPLICATIONS, 0, 499), db.hgetall<Decision>(DECISIONS)]);
  return rows.flatMap((r) => {
    try {
      const a = JSON.parse(r) as Partial<Application>;
      const id = applicationId(a);
      return [{ id, name: a.name ?? "", email: a.email ?? "", phone: a.phone ?? "", channel: a.channel ?? "", audience: a.audience ?? "", lang: a.lang === "en" ? "en" as const : "ar" as const, at: a.at ?? "", decision: decisions[id] ?? null, suggested: suggestCode(a.name ?? "", a.email ?? "") }];
    } catch {
      return [];
    }
  });
}

export type ApproveError = "bad_code" | "reserved_code" | "bad_email" | "member_login" | "already_partner" | "code_taken";
/**
 * Approve a partner: claim the code (unique among partners and the credits-referral codes) and link it to the
 * applicant's email. The account need not exist yet: whoever signs up with that address later gets the partner page
 * (`afterSignup`). A member login cannot be a partner: it has no account of its own to be paid through.
 */
export async function approvePartner(input: { email: unknown; name?: unknown; code: unknown; appId?: unknown }, by: string): Promise<{ ok: true; partner: Partner } | { ok: false; error: ApproveError }> {
  const code = normalizeCode(input.code);
  const problem = codeProblem(code);
  if (problem) return { ok: false, error: problem };
  const email = normalizeEmail(typeof input.email === "string" ? input.email : "");
  if (!validEmail(email)) return { ok: false, error: "bad_email" };
  const login = await getLogin(email);
  if (login?.kind === "member") return { ok: false, error: "member_login" };
  const appId = typeof input.appId === "string" && /^app_[a-f0-9]{8,32}$/.test(input.appId) ? input.appId : undefined;
  const now = new Date().toISOString();
  const res = await withRegistryLock(async (): Promise<Partner | ApproveError> => {
    const [existing, holder, credits] = await Promise.all([getPartner(email), db.get<string>(codeKey(code)), db.get<string>(`ref:${code}`)]);
    if (existing) return "already_partner";
    if (holder || credits) return "code_taken";
    const partner: Partner = { email, name: cleanText(input.name, 80) || (login?.kind === "owner" ? login.user.name : ""), code, approvedAt: now, approvedBy: by, hadAccount: login?.kind === "owner", ...(appId ? { appId } : {}) };
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

export type PayoutError = "not_found" | "bad_id" | "bad_date" | "bad_amount" | "below_minimum" | "over_balance" | "bank_unconfirmed";
/**
 * Mark a bank transfer paid (rule 398). Only a payable balance (SAR 200 or more) is paid down, never past it, and only to
 * bank details the founder confirmed after their last change, under the partner's lock. The id may come from the console,
 * so a double press or a retry records the transfer once.
 */
export async function recordPayout(email: string, input: { id?: unknown; amountSar: unknown; date: unknown; reference?: unknown }, by: string): Promise<{ ok: true; payout: Payout; already?: boolean } | { ok: false; error: PayoutError }> {
  const e = normalizeEmail(email);
  if (input.id !== undefined && !(typeof input.id === "string" && /^po_[a-f0-9]{8,32}$/.test(input.id))) return { ok: false, error: "bad_id" };
  if (!validDay(input.date) || input.date > today()) return { ok: false, error: "bad_date" };
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
    const payout: Payout = { kind: "payout", id, sar: input.amountSar as number, date, reference: cleanText(input.reference, 80), at: new Date().toISOString(), by };
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
 * while that customer is still a referral; a deleted customer shows only the label.
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
      email: p.email, name: p.name, code: p.code, approvedAt: p.approvedAt, bank: p.bank ?? null, bankConfirmed: bankConfirmed(p.bank),
      accountAfterApproval: !!owner && (p.hadAccount === undefined ? owner.createdAt > p.approvedAt : !p.hadAccount), hasAccount: !!owner, referrals: refSets[i].length,
      ...balances(rows),
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
    bank: partner.bank ? { holder: partner.bank.holder, iban: maskIban(partner.bank.iban), savedAt: partner.bank.savedAt, confirmed: bankConfirmed(partner.bank) } : null,
    referrals,
    ...balances(rows),
    commissions: commissions.sort(byNewest).slice(0, 200).map((c) => ({ label: c.label, paymentDate: c.paymentDate, baseSar: c.baseSar, sar: c.sar, voided: !!c.voidedAt })),
    payouts: rows.filter((r): r is Payout => r.kind === "payout").sort(byNewest).map((p) => ({ date: p.date, sar: p.sar, reference: p.reference, voided: !!p.voidedAt })),
  };
}

export type BankError = "not_partner" | "bad_holder" | "bad_iban";
/**
 * The partner's own bank details: account holder and a valid Saudi IBAN. Never logged; the partner gets it back masked.
 * Every save clears the founder's confirmation, so no payout is marked paid to details nobody checked with the partner.
 */
export async function saveBank(email: string, holderRaw: unknown, ibanRaw: unknown): Promise<{ ok: true; bank: { holder: string; iban: string } } | { ok: false; error: BankError }> {
  const holder = cleanText(holderRaw, 80);
  if (holder.length < 2) return { ok: false, error: "bad_holder" };
  const iban = saIban(ibanRaw);
  if (!iban) return { ok: false, error: "bad_iban" };
  const e = normalizeEmail(email);
  const res = await withPartnerLock(e, async () => {
    const p = await getPartner(e);
    if (!p) return false;
    await db.set(partnerKey(e), { ...p, bank: { holder, iban, savedAt: new Date().toISOString() } } satisfies Partner);
    return true;
  });
  return res ? { ok: true, bank: { holder, iban: maskIban(iban) } } : { ok: false, error: "not_partner" };
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
