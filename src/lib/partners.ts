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
  CUSTOMER_LABEL_PREFIX, PARTNER_COOKIE, PARTNER_COOKIE_DAYS, balances, codeProblem, commissionDecision, commissionSar, maskIban,
  normalizeCode, payoutProblem, referralStatus, saIban, suggestCode, validAmount, validDay,
  type Attribution, type Commission, type LedgerRow, type NotCounted, type Payout, type ReferralStatus,
} from "./partner-rules";

/**
 * The partner programme and the 15% first-month discount, store side (docs/superpowers/specs/2026-10-01-affiliates-design.md).
 * The rules themselves are pure and live in src/lib/partner-rules.ts.
 *
 * Keys (all built from a normalized email or a validated code, never from free text):
 * - `partner:{email}` the approved partner: name, code, approval, bank details (IBAN in full: founder console only).
 * - `partnercode:{CODE}` → partner email. Unique; claimed under `lock:partners`.
 * - `partners:all` every partner email. `partner:refs:{email}` the customers attributed to that partner.
 * - `partner:ledger:{email}` hash: `c:{paymentId}` a commission, `p:{payoutId}` a payout. Changed only under
 *   `lock:partner:{email}`, so two payouts can never both pass the balance check.
 * - `payments:{email}` hash of the customer's recorded payments (the founder's record, the source of truth for commissions).
 * - `affiliate-applications` (list, the public form) and `affiliate:decisions` (hash, application id → approve/reject).
 *
 * The customer side lives on the account record (`User.referredBy`, `firstMonthOffer`, `firstPaidOn`, `partnerCode`),
 * always written under `withUserLock`.
 */

export type Bank = { holder: string; iban: string; savedAt: string };
export type Partner = { email: string; name: string; code: string; approvedAt: string; approvedBy: string; appId?: string; bank?: Bank };
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
/** What a partner sees instead of a customer's name or email: a stable code no one can turn back into the address. */
export const customerLabel = (email: string) => CUSTOMER_LABEL_PREFIX + createHash("sha256").update(`nashr-partner-ref:${email}`).digest("hex").slice(0, 6).toUpperCase();
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
/** The valid code in the visitor's partner cookie, or "". */
export async function cookieCode(): Promise<string> {
  const code = normalizeCode((await cookies()).get(PARTNER_COOKIE)?.value);
  return codeProblem(code) ? "" : code;
}

export type SignupPartner = { partner: Partner; via: Attribution["via"] } | null;
/**
 * Which partner a new account belongs to. A code typed at signup wins over the link cookie; a typed code that is not a
 * partner's answers "bad" (the form says so and nothing is created). Without a typed code, the cookie's code if it is
 * still a partner's (an unknown or stale cookie is ignored).
 */
export async function signupPartner(typed: unknown): Promise<SignupPartner | "bad"> {
  const code = normalizeCode(typed);
  if (code) {
    const partner = await partnerByCode(code);
    return partner ? { partner, via: "code" } : "bad";
  }
  const fromCookie = await cookieCode();
  const partner = fromCookie ? await partnerByCode(fromCookie) : null;
  return partner ? { partner, via: "link" } : null;
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
        const at = new Date().toISOString();
        u.referredBy = { partner: found!.partner.email, code: found!.partner.code, at, via: found!.via };
        if (!u.firstMonthOffer) u.firstMonthOffer = { kind: "partner", pct: FIRST_MONTH_DISCOUNT_PCT, at };
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
    x.referredBy = { partner: partner.email, code: partner.code, at, via: "code" };
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
/** The billing page: a trial on or past its last day with no offer yet (a missed cron run, or a trial that ended before the offer existed). */
export const lastDayOfferOwed = (u: User, now: number = Date.now()) =>
  u.plan === "trial" && !u.firstMonthOffer && !u.firstPaidOn && new Date(u.trialEnds).getTime() - now <= 24 * 36e5;
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
const today = () => new Date().toISOString().slice(0, 10);
const cleanText = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/**
 * Record a payment the founder received (SAR, excluding VAT). Under the customer's lock: the first payment uses the
 * account's first-month offer; when the account is attributed to a partner, not lapsed, inside the 4-month window and not
 * a self or team referral, 15% of the amount is written to the partner's ledger under the partner's lock, keyed by the
 * payment id. The id may come from the console, so a retried request records nothing twice.
 */
export async function recordPayment(email: string, input: PaymentInput, by: string): Promise<{ ok: true; payment: Payment; already?: boolean } | { ok: false; error: PaymentError }> {
  if (!validAmount(input.amountSar)) return { ok: false, error: "bad_amount" };
  if (typeof input.plan !== "string" || !PAID_PLANS.includes(input.plan as Plan)) return { ok: false, error: "bad_plan" };
  // A payment is dated the day the money arrived: a real day, not in the future (one day of slack for time zones).
  if (!validDay(input.date) || input.date > new Date(Date.now() + 864e5).toISOString().slice(0, 10)) return { ok: false, error: "bad_date" };
  if (input.id !== undefined && !(typeof input.id === "string" && /^pay_[a-f0-9]{8,32}$/.test(input.id))) return { ok: false, error: "bad_id" };
  const e = normalizeEmail(email);
  if (!(await getUser(e))) return { ok: false, error: "not_found" };
  const id = (input.id as string | undefined) ?? newId("pay");
  const amountSar = input.amountSar, plan = input.plan as Plan, date = input.date;
  return withUserLock(e, async (u) => {
    const all = await db.hgetall<Payment>(paymentsKey(e));
    if (all[id]) return { ok: true as const, payment: all[id], already: true };
    const live = Object.values(all).filter((p) => !p.voidedAt);
    const firstPaidOn = [date, ...live.map((p) => p.date)].sort()[0];
    const pay: Payment = { id, amountSar, plan, date, reference: cleanText(input.reference, 80), recordedAt: new Date().toISOString(), recordedBy: by };
    const offer = openOffer(u);
    if (offer && live.length === 0) {
      pay.offer = offer.kind;
      if ((SELF_SERVE_PLANS as readonly string[]).includes(plan)) pay.expectedSar = firstMonthPriceSar(plan as SelfServePlan);
      u.firstMonthOffer = { ...offer, usedAt: pay.recordedAt, paymentId: id };
    }
    const at = u.referredBy;
    if (at) {
      const [partner, sameTeam] = await Promise.all([getPartner(at.partner), Promise.all([onRoster(e, at.partner), onRoster(at.partner, e)]).then((x) => x.some(Boolean))]);
      const d = commissionDecision({ customer: e, attribution: at, partnerExists: !!partner, sameTeam, firstPaidOn, paymentDate: date });
      if (d.ok) {
        const row: Commission = { kind: "commission", id, customer: e, label: customerLabel(e), paymentDate: date, baseSar: amountSar, sar: commissionSar(amountSar), at: pay.recordedAt };
        await withPartnerLock(at.partner, () => db.hset(ledgerKey(at.partner), `c:${id}`, row));
        pay.commission = { partner: at.partner, sar: row.sar };
      } else pay.notCounted = d.reason;
    }
    await db.hset(paymentsKey(e), id, pay);
    u.firstPaidOn = firstPaidOn;
    await saveUser(u);
    return { ok: true as const, payment: pay };
  });
}

/**
 * Void a payment (refunded, or entered by mistake). Its commission is voided in the partner's ledger under the partner's
 * lock. When no other payment stands, the account is back to unpaid: its first payment day goes, and the first-month
 * offer this payment used is open again.
 */
export async function voidPayment(email: string, id: unknown, by: string, reason: unknown): Promise<{ ok: true; payment: Payment } | { ok: false; error: "not_found" }> {
  const e = normalizeEmail(email);
  if (typeof id !== "string" || !/^pay_[a-f0-9]{8,32}$/.test(id) || !(await getUser(e))) return { ok: false, error: "not_found" };
  return withUserLock(e, async (u) => {
    const all = await db.hgetall<Payment>(paymentsKey(e));
    const p = all[id];
    if (!p) return { ok: false as const, error: "not_found" as const };
    if (p.voidedAt) return { ok: true as const, payment: p };
    const voided: Payment = { ...p, voidedAt: new Date().toISOString(), voidedBy: by, voidReason: cleanText(reason, 200) || undefined };
    if (p.commission) {
      const partner = p.commission.partner;
      await withPartnerLock(partner, async () => {
        const row = (await db.hgetall<LedgerRow>(ledgerKey(partner)))[`c:${id}`];
        if (row && row.kind === "commission" && !row.voidedAt) await db.hset(ledgerKey(partner), `c:${id}`, { ...row, voidedAt: voided.voidedAt });
      });
    }
    const rest = Object.values(all).filter((x) => x.id !== id && !x.voidedAt);
    const first = rest.map((x) => x.date).sort()[0];
    if (first) u.firstPaidOn = first;
    else delete u.firstPaidOn;
    if (u.firstMonthOffer?.paymentId === id && rest.length === 0) u.firstMonthOffer = { kind: u.firstMonthOffer.kind, pct: u.firstMonthOffer.pct, at: u.firstMonthOffer.at };
    await db.hset(paymentsKey(e), id, voided);
    await saveUser(u);
    return { ok: true as const, payment: voided };
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
    const partner: Partner = { email, name: cleanText(input.name, 80) || (login?.kind === "owner" ? login.user.name : ""), code, approvedAt: now, approvedBy: by, ...(appId ? { appId } : {}) };
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

/** Mark a bank transfer paid. Only a payable balance (SAR 200 or more) is paid down, never past it, under the partner's lock. */
export async function recordPayout(email: string, input: { amountSar: unknown; date: unknown; reference?: unknown }, by: string): Promise<{ ok: true; payout: Payout } | { ok: false; error: "not_found" | "bad_date" | "bad_amount" | "below_minimum" | "over_balance" }> {
  const e = normalizeEmail(email);
  if (!validDay(input.date) || input.date > today()) return { ok: false, error: "bad_date" };
  if (!(await getPartner(e))) return { ok: false, error: "not_found" };
  const date = input.date;
  return withPartnerLock(e, async () => {
    const rows = Object.values(await db.hgetall<LedgerRow>(ledgerKey(e)));
    const problem = payoutProblem(rows, input.amountSar);
    if (problem) return { ok: false as const, error: problem };
    const payout: Payout = { kind: "payout", id: newId("po"), sar: input.amountSar as number, date, reference: cleanText(input.reference, 80), at: new Date().toISOString(), by };
    await db.hset(ledgerKey(e), `p:${payout.id}`, payout);
    return { ok: true as const, payout };
  });
}

const byNewest = <T extends { at: string }>(a: T, b: T) => (a.at < b.at ? 1 : -1);

/** Every partner for the founder: code, referrals, balances, commissions, payouts and bank details in full. */
export async function listPartners() {
  const emails = await db.smembers(PARTNERS);
  const [records, refCounts, ledgers] = await Promise.all([
    db.mget<Partner>(emails.map(partnerKey)),
    db.scardMany(emails.map(refsKey)),
    pmap(emails, (e) => db.hgetall<LedgerRow>(ledgerKey(e))),
  ]);
  return emails.flatMap((e, i) => {
    const p = records[i];
    if (!p) return [];
    const rows = Object.values(ledgers[i]);
    return [{
      email: p.email, name: p.name, code: p.code, approvedAt: p.approvedAt, bank: p.bank ?? null, referrals: refCounts[i],
      ...balances(rows),
      commissions: rows.filter((r): r is Commission => r.kind === "commission").sort(byNewest).slice(0, 100),
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
    const months = new Set(commissions.filter((c) => c.customer === u.email && !c.voidedAt).map((c) => c.paymentDate.slice(0, 7))).size;
    return [{ label: customerLabel(u.email), signedUpOn: u.createdAt.slice(0, 10), status: referralStatus(u.referredBy.at, u.firstPaidOn, now), months }];
  }).sort((a, b) => (a.signedUpOn < b.signedUpOn ? 1 : -1));
  return {
    code: partner.code, name: partner.name,
    bank: partner.bank ? { holder: partner.bank.holder, iban: maskIban(partner.bank.iban), savedAt: partner.bank.savedAt } : null,
    referrals,
    ...balances(rows),
    commissions: commissions.sort(byNewest).slice(0, 200).map((c) => ({ label: c.label, paymentDate: c.paymentDate, baseSar: c.baseSar, sar: c.sar, voided: !!c.voidedAt })),
    payouts: rows.filter((r): r is Payout => r.kind === "payout").sort(byNewest).map((p) => ({ date: p.date, sar: p.sar, reference: p.reference })),
  };
}

export type BankError = "not_partner" | "bad_holder" | "bad_iban";
/** The partner's own bank details: account holder and a valid Saudi IBAN. Never logged; the partner gets it back masked. */
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
 * details included), code, referral set and ledger. The account is also taken out of its own partner's referral set, so
 * no deleted address stays listed anywhere.
 */
export async function forgetPartnerData(email: string): Promise<string[]> {
  const e = normalizeEmail(email);
  const [u, partner] = await Promise.all([getUser(e), getPartner(e)]);
  await Promise.all([u?.referredBy ? db.srem(refsKey(u.referredBy.partner), e) : null, partner ? db.srem(PARTNERS, e) : null]);
  return [paymentsKey(e), partnerKey(e), refsKey(e), ledgerKey(e), ...(partner ? [codeKey(partner.code)] : [])];
}
