/**
 * The partner programme's rules as pure functions: codes, the attribution and commission windows, money in halalas,
 * the Saudi IBAN check and the labels a partner sees. The founder's decisions of 2026-10-01
 * (docs/superpowers/specs/2026-10-01-affiliates-design.md):
 *
 * - Commission: 15% of each payment a referred customer makes during their first 4 months of paid subscription.
 * - A referral counts only when the customer's first payment is within 30 days of being attributed: the click on the
 *   partner's link (the cookie carries the click time), else the signup with a typed code.
 * - Payouts monthly by bank transfer, from a SAR 200 balance. The founder pays by hand and marks it paid.
 * - Every partner has their own code, which gives the customer 15% off the first month (src/lib/pricing.ts).
 * - No self-referral: the partner's own account or a member of either team is never counted.
 *
 * Imports nothing on purpose: the partner page, the founder console and the signup form (client components) read it.
 * The store side is src/lib/partners.ts. Rules 390-402, tests/partners.test.ts.
 */

export const COMMISSION_PCT = 15;
/** Payments dated before the first payment's date plus this many calendar months count. */
export const COMMISSION_MONTHS = 4;
/** The first payment must be dated on or before the attribution day plus this many days. */
export const ATTRIBUTION_DAYS = 30;
export const PAYOUT_MIN_SAR = 200;
/** These terms took effect on this day; applications sent before it were made under the old public terms (25% recurring, 60 days). */
export const NEW_TERMS_FROM = "2026-10-01";
/** The first-party cookie a partner link sets (httpOnly, 30 days), `CODE.<click ms>`. Never the credits referral's `?ref=`. */
export const PARTNER_COOKIE = "nashr_partner";
export const PARTNER_COOKIE_DAYS = 30;
/** The cookie's value: the code and the moment of the click, so the 30 days run from the click, not from signup. */
export const partnerCookieValue = (code: string, clickMs: number): string => `${code}.${Math.floor(clickMs)}`;
/**
 * The code and click time in a partner cookie, or null. A click time in the future is taken as now; one older than the
 * cookie's own 30 days, or missing (a bare code), leaves `clickMs` unset so the signup time is used. The visitor can only
 * move the click later than it was (shortening the window), never earlier than the signup it already gets.
 */
export function parsePartnerCookie(raw: unknown, now: number = Date.now()): { code: string; clickMs?: number } | null {
  if (typeof raw !== "string") return null;
  const m = /^([A-Za-z0-9]{3,16})(?:\.(\d{10,16}))?$/.exec(raw.trim());
  if (!m) return null;
  const code = normalizeCode(m[1]);
  if (codeProblem(code)) return null;
  const ms = m[2] ? Number(m[2]) : NaN;
  if (!Number.isFinite(ms) || ms < now - PARTNER_COOKIE_DAYS * 864e5) return { code };
  return { code, clickMs: Math.min(ms, now) };
}

/** A partner code: A-Z and 0-9, 3 to 16 characters, stored and compared uppercase. */
export const CODE_RE = /^[A-Z0-9]{3,16}$/;
/** Codes nobody may hold: product, staff and route words a visitor could take for an official code. */
export const RESERVED_CODES: ReadonlySet<string> = new Set([
  "ADMIN", "API", "APP", "AFFILIATE", "AFFILIATES", "BILLING", "DISCOUNT", "FOUNDER", "FREE", "HELP", "LOGIN", "NASHR", "NOOR",
  "NULL", "OFFICIAL", "PARTNER", "PARTNERS", "PROMO", "REF", "REFER", "ROOT", "SIGNUP", "STAFF", "SUPPORT", "SYSTEM", "TEST",
  "THAKEEN", "TRIAL", "UNDEFINED", "ZAKEEN",
]);
/** Trim and uppercase what a person typed. Anything that is not a string is "". */
export const normalizeCode = (raw: unknown): string => (typeof raw === "string" ? raw.trim().toUpperCase() : "");
export type CodeProblem = "bad_code" | "reserved_code";
/** Null when `code` (already normalized) may be a partner code. */
export function codeProblem(code: string): CodeProblem | null {
  if (!CODE_RE.test(code)) return "bad_code";
  return RESERVED_CODES.has(code) ? "reserved_code" : null;
}

const AR_LATIN: Record<string, string> = {
  "ا": "A", "أ": "A", "إ": "I", "آ": "A", "ء": "", "ؤ": "O", "ئ": "E", "ب": "B", "ت": "T", "ث": "TH", "ج": "J", "ح": "H", "خ": "KH",
  "د": "D", "ذ": "TH", "ر": "R", "ز": "Z", "س": "S", "ش": "SH", "ص": "S", "ض": "D", "ط": "T", "ظ": "Z", "ع": "A", "غ": "GH",
  "ف": "F", "ق": "Q", "ك": "K", "ل": "L", "م": "M", "ن": "N", "ه": "H", "ة": "A", "و": "W", "ي": "Y", "ى": "A",
};
/**
 * A first suggestion for the founder, from the applicant's first name (Arabic letters spelled out in Latin), else the
 * email's local part, padded to 3 characters. The founder edits it before approving; uniqueness is checked on approval.
 */
export function suggestCode(name: string, email = ""): string {
  const latin = (s: string) => [...s].map((c) => AR_LATIN[c] ?? c).join("").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const first = latin((name.trim().split(/\s+/)[0] ?? "")).slice(0, 12);
  let code = first.length >= 3 ? first : latin(email.split("@")[0] ?? "").slice(0, 12);
  if (code.length < 3) code = (code + "PRT").slice(0, 3);
  return RESERVED_CODES.has(code) ? `${code}1` : code;
}

// ---- Money: every sum is taken in whole halalas, so 0.1 + 0.2 never shows up in a balance ----

/** SAR as integer halalas. */
export const toHalalas = (sar: number): number => Math.round(sar * 100);
export const fromHalalas = (h: number): number => h / 100;
/** 15% of a payment, rounded to the halala. */
export const commissionSar = (amountSar: number): number => fromHalalas(Math.round((toHalalas(amountSar) * COMMISSION_PCT) / 100));
/** A payment amount in SAR excluding VAT: finite, above 0, at most 1,000,000, at most two decimals. */
export const validAmount = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1_000_000 && Math.abs(toHalalas(v) - v * 100) < 1e-6;
/** "1,234.50": the site's Latin digits with a comma, always two decimals. */
export const sarText = (sar: number): string => {
  const [whole, frac] = (Math.round(sar * 100) / 100).toFixed(2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};

// ---- Dates: payments carry the day the money arrived (YYYY-MM-DD, as the founder enters it) ----

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day in YYYY-MM-DD. */
export const validDay = (s: unknown): s is string => typeof s === "string" && DAY_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Saudi Arabia is UTC+3 all year (no daylight saving). */
const KSA_OFFSET_MS = 3 * 36e5;
/**
 * The calendar day in Riyadh at `ms`: the day the founder and the customers see. Every programme day (attribution,
 * deadlines, "today" for payment and payout dates, the console's default dates) is a Riyadh day, so a signup at 01:30 on
 * the 2nd in Riyadh (22:30 UTC on the 1st) is attributed on the 2nd.
 */
export const ksaDay = (ms: number = Date.now()): string => utcDay(ms + KSA_OFFSET_MS);
/** The Riyadh day of an attribution. */
export const attributionDay = (attributedAt: string): string => ksaDay(new Date(attributedAt).getTime());
/** The last day (inclusive, Riyadh) a first payment may be dated for the referral to count: attribution day + 30 days. */
export const attributionDeadline = (attributedAt: string): string => ksaDay(new Date(attributedAt).getTime() + ATTRIBUTION_DAYS * 864e5);
/**
 * The first day that no longer counts: the first payment's day-of-month, 4 calendar months later, clamped to the end of
 * that month. First payment 2026-10-15 → payments dated up to 2027-02-14 count; 2026-10-31 → up to 2027-02-27.
 */
export function windowEnd(firstPaidOn: string): string {
  const [y, m, d] = firstPaidOn.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + COMMISSION_MONTHS + 1, 0)).getUTCDate();
  return utcDay(Date.UTC(y, m - 1 + COMMISSION_MONTHS, Math.min(d, last)));
}

/** `ref`: a random id drawn at attribution, the only source of the label a partner sees (`customerLabel`). */
export type Attribution = { partner: string; code: string; at: string; via: "link" | "code"; ref?: string };
export type NotCounted = "no_partner" | "self" | "team" | "before_attribution" | "lapsed" | "window";
/**
 * Does this payment earn the partner a commission? `firstPaidOn` is the account's first payment day among every payment
 * that stands. The decision is re-taken for every payment of the customer whenever a payment is recorded or voided
 * (src/lib/partners.ts `settle`), so a backdated entry or a voided first payment moves every payment's answer with it.
 * Self: the partner's own account. Team: either account has the other on its roster. Before attribution: the customer
 * paid before the partner referred them, so they were never the partner's customer. Lapsed: the first payment came more
 * than 30 days after attribution, so no payment of this customer ever counts. Window: dated 4 months or more after the
 * first payment.
 */
export function commissionDecision(a: { customer: string; attribution?: Attribution | null; partnerExists: boolean; sameTeam: boolean; firstPaidOn: string; paymentDate: string }): { ok: true } | { ok: false; reason: NotCounted } {
  const at = a.attribution;
  if (!at || !a.partnerExists) return { ok: false, reason: "no_partner" };
  if (at.partner === a.customer) return { ok: false, reason: "self" };
  if (a.sameTeam) return { ok: false, reason: "team" };
  if (a.firstPaidOn < attributionDay(at.at)) return { ok: false, reason: "before_attribution" };
  if (a.firstPaidOn > attributionDeadline(at.at)) return { ok: false, reason: "lapsed" };
  if (a.paymentDate >= windowEnd(a.firstPaidOn)) return { ok: false, reason: "window" };
  return { ok: true };
}

export type ReferralStatus = "trial" | "paid" | "lapsed";
/** A referral as the partner sees it: still in its 30 days, paid in time, or lapsed (no payment in time, kept on record). */
export function referralStatus(at: string, firstPaidOn: string | undefined, now: number = Date.now()): ReferralStatus {
  const deadline = attributionDeadline(at);
  if (firstPaidOn) return firstPaidOn <= deadline && firstPaidOn >= attributionDay(at) ? "paid" : "lapsed";
  return ksaDay(now) > deadline ? "lapsed" : "trial";
}

// ---- Ledger ----

/**
 * A commission row, keyed `c:{paymentId}`. It carries the customer's label, never the email, so deleting the customer's
 * account leaves no address in the partner's ledger; the founder console maps labels of current referrals back to emails.
 */
export type Commission = { kind: "commission"; id: string; label: string; paymentDate: string; baseSar: number; sar: number; at: string; voidedAt?: string };
/** A payout row, keyed `p:{payoutId}`. A payout entered by mistake is voided (kept on record), which puts its amount back in the balance. */
export type Payout = { kind: "payout"; id: string; sar: number; date: string; reference: string; at: string; by: string; voidedAt?: string; voidedBy?: string; voidReason?: string };
export type LedgerRow = Commission | Payout;
/**
 * Earned (commissions not voided), paid (payouts) and the balance between them, in SAR. The balance is "payable" once it
 * reaches the SAR 200 minimum and "pending" below it; it can go negative when a commission already paid out is voided,
 * which later commissions then make up.
 */
export function balances(rows: LedgerRow[]): { earned: number; paid: number; balance: number; pending: number; payable: number } {
  let earned = 0, paid = 0;
  for (const r of rows) {
    if (r.kind === "commission" && !r.voidedAt) earned += toHalalas(r.sar);
    else if (r.kind === "payout" && !r.voidedAt) paid += toHalalas(r.sar);
  }
  const balance = earned - paid;
  const payable = balance >= toHalalas(PAYOUT_MIN_SAR) ? balance : 0;
  return { earned: fromHalalas(earned), paid: fromHalalas(paid), balance: fromHalalas(balance), pending: fromHalalas(balance > 0 && !payable ? balance : 0), payable: fromHalalas(payable) };
}
/** Null when a payout of `amountSar` may be marked paid against these rows: only a payable balance is paid down. */
export function payoutProblem(rows: LedgerRow[], amountSar: unknown): "bad_amount" | "below_minimum" | "over_balance" | null {
  if (!validAmount(amountSar)) return "bad_amount";
  const b = balances(rows);
  if (b.payable <= 0) return "below_minimum";
  return toHalalas(amountSar) > toHalalas(b.payable) ? "over_balance" : null;
}

// ---- Bank details ----

/**
 * The partner's bank details. `confirmedAt` is set by the founder after checking the details with the partner out of band
 * (by phone, from the application); every save by the partner clears it. No payout is marked paid to unconfirmed details.
 */
export type Bank = { holder: string; iban: string; savedAt: string; confirmedAt?: string; confirmedBy?: string };
/** True when the founder confirmed these exact details after their last change. */
export const bankConfirmed = (b: Pick<Bank, "savedAt" | "confirmedAt"> | null | undefined): boolean => !!b?.confirmedAt && b.confirmedAt >= b.savedAt;

/**
 * A Saudi IBAN: "SA", 2 check digits, then 20 digits (24 characters), and the ISO 13616 mod-97 check. Spaces and case
 * are ignored. Returns the compact uppercase form, or null.
 */
export function saIban(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const iban = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!/^SA\d{22}$/.test(iban)) return null;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1 ? iban : null;
}
/** What the partner sees after saving: the country code and the last four characters only. */
export const maskIban = (iban: string): string => `${iban.slice(0, 2)}•• •••• •••• •••• •••• ${iban.slice(-4)}`;

/**
 * The label a partner sees for a referred customer: never the name or email, a stable short code instead, taken from
 * the random `ref` drawn at attribution (src/lib/partners.ts `customerLabel`), so it cannot be recomputed from a guessed
 * address.
 */
export const CUSTOMER_LABEL_PREFIX = "C-";
