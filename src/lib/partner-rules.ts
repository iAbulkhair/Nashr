/**
 * The partner programme's rules as pure functions: codes, the attribution and commission windows, money in halalas,
 * the IBAN check, the early-partner offer's expiry, the tax flags and the labels a partner sees. The founder's decisions
 * of 2026-10-01 (docs/superpowers/specs/2026-10-01-affiliates-design.md):
 *
 * - Commission: 15% of each payment a referred customer makes during their first 4 months of paid subscription, on the
 *   payment before VAT (every amount the founder records excludes VAT).
 * - A referral counts only when the customer's first payment is within 30 days of being attributed: the click on the
 *   partner's link (the cookie carries the click time), else the signup with a typed code.
 * - Payouts monthly by bank transfer, from a SAR 200 balance. The founder pays by hand and marks it paid.
 * - Every partner has their own code, which gives the customer 15% off the first month (src/lib/pricing.ts), on the
 *   price before VAT; VAT is then computed on the discounted price.
 * - The early-partner offer (the trial's last day) ends 7 days after that day.
 * - No self-referral: the partner's own account or a member of either team is never counted.
 * - Partners from any country. Thakeen bears the taxes on a commission: VAT a VAT-registered partner adds on top, and
 *   withholding tax where it applies; the partner receives the full 15% and stays responsible for their own income tax.
 *   No tax rate is coded here: the founder enters the amounts paid with each payout.
 *
 * Imports nothing on purpose: the partner page, the founder console and the signup form (client components) read it.
 * The store side is src/lib/partners.ts. Rules 390-417, tests/partners.test.ts.
 */

export const COMMISSION_PCT = 15;
/** Payments dated before the first payment's date plus this many calendar months count. */
export const COMMISSION_MONTHS = 4;
/** The first payment must be dated on or before the attribution day plus this many days. */
export const ATTRIBUTION_DAYS = 30;
export const PAYOUT_MIN_SAR = 200;
/** These terms took effect on this day; applications sent before it were made under the old public terms (25% recurring, 60 days). */
export const NEW_TERMS_FROM = "2026-10-01";
/**
 * The version of the public programme terms (/{lang}/affiliates/terms, "last updated"). An application stores the
 * version its applicant agreed to (rule 414); change it whenever the terms page changes.
 */
export const PARTNER_TERMS_VERSION = "2026-10-02";
/** The early-partner offer can be used until the end of this many Riyadh days after the trial's last day (rule 410). */
export const EARLY_OFFER_DAYS = 7;
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
/**
 * 15% of a payment, rounded to the halala. The base is the payment before VAT: the founder records every amount
 * excluding VAT (rule 409), so the VAT a customer paid never earns commission.
 */
export const commissionSar = (amountSar: number): number => fromHalalas(Math.round((toHalalas(amountSar) * COMMISSION_PCT) / 100));
/**
 * The commission on a payment part of which was refunded (a top-up pack's unused credits, founder decision of
 * 2026-10-02, rule 460): the commission less commission × refunded / paid, each to the halala. The refund never counts
 * for more than the payment, so the result is between 0 and `commissionSar(amountSar)`.
 */
export function commissionAfterRefund(amountSar: number, refundSar: number): number {
  const paid = toHalalas(amountSar);
  if (!(paid > 0)) return 0;
  const full = toHalalas(commissionSar(amountSar));
  const back = Math.min(paid, Math.max(0, Number.isFinite(refundSar) ? toHalalas(refundSar) : 0));
  return fromHalalas(full - Math.round((full * back) / paid));
}
/** An amount in SAR (a payment excluding VAT, a payout, a tax paid): finite, above 0, at most 1,000,000, at most two decimals. */
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
/** The Riyadh day of a trial's last moment: its last day (a trial ending at midnight ends on the day before). */
export const trialLastDay = (trialEnds: string): string => ksaDay(new Date(trialEnds).getTime() - 1);
/**
 * The last Riyadh day the early-partner offer can be used: 7 days after the trial's last day (rule 410). A trial ending
 * on 2026-10-04 at 18:00 in Riyadh: the offer can be used through 2026-10-11; from 2026-10-12 it is neither shown nor
 * granted nor applied, unless a recorded payment already took it. Computed from the trial, so it is never stored.
 */
export const earlyOfferLastDay = (trialEnds: string): string => ksaDay(new Date(trialEnds).getTime() - 1 + EARLY_OFFER_DAYS * 864e5);

export function windowEnd(firstPaidOn: string): string {
  const [y, m, d] = firstPaidOn.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + COMMISSION_MONTHS + 1, 0)).getUTCDate();
  return utcDay(Date.UTC(y, m - 1 + COMMISSION_MONTHS, Math.min(d, last)));
}

/** `ref`: a random id drawn at attribution, the only source of the label a partner sees (`customerLabel`). */
export type Attribution = { partner: string; code: string; at: string; via: "link" | "code"; ref?: string };
/** `refunded`: the payment counted, but all of it was refunded since, so no commission is left (rule 460). */
export type NotCounted = "no_partner" | "self" | "team" | "before_attribution" | "lapsed" | "window" | "refunded";
/**
 * Does this payment earn the partner a commission? `firstPaidOn` is the day the windows start: the account's first plan
 * payment that stands, or its first top-up payment when no plan payment stands (src/lib/partners.ts `windowStartDay`). The decision is re-taken for every payment of the customer whenever a payment is recorded or voided
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
 * After part of the payment was refunded (rule 460), `baseSar` is what the customer kept paying, `refundSar` what went
 * back, and `sar` the commission less its refunded share (`commissionAfterRefund`).
 */
export type Commission = { kind: "commission"; id: string; label: string; paymentDate: string; baseSar: number; sar: number; at: string; voidedAt?: string; refundSar?: number };
/**
 * A payout row, keyed `p:{payoutId}`. `sar` is the commission paid down; `vatSar` the VAT Thakeen paid on top to a
 * VAT-registered partner and `whtSar` the withholding tax Thakeen bore (rule 412): both are Thakeen's costs, recorded for
 * the books, and never touch the balance. A payout entered by mistake is voided (kept on record), which puts its amount
 * back in the balance.
 */
export type Payout = { kind: "payout"; id: string; sar: number; vatSar?: number; whtSar?: number; date: string; reference: string; at: string; by: string; voidedAt?: string; voidedBy?: string; voidReason?: string };
export type LedgerRow = Commission | Payout;
/**
 * Earned (commissions not voided), paid (payouts' commission amounts, never the VAT or withholding recorded with them)
 * and the balance between them, in SAR. The balance is "payable" once it reaches the SAR 200 minimum and "pending"
 * below it; it can go negative when a commission already paid out is voided, which later commissions then make up.
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

/** VAT paid on top and withholding tax borne across the payouts that stand, in SAR: Thakeen's costs, for the books (rule 412). */
export function taxTotals(rows: LedgerRow[]): { vatPaid: number; whtBorne: number } {
  let vat = 0, wht = 0;
  for (const r of rows) {
    if (r.kind !== "payout" || r.voidedAt) continue;
    vat += toHalalas(r.vatSar ?? 0);
    wht += toHalalas(r.whtSar ?? 0);
  }
  return { vatPaid: fromHalalas(vat), whtBorne: fromHalalas(wht) };
}
/**
 * An optional tax amount on the payout form: absent (undefined, null, "" or 0) is no amount, a valid amount is kept,
 * anything else is refused. The founder enters what was actually paid; no rate is computed here.
 */
export function optionalTax(v: unknown): { ok: true; sar?: number } | { ok: false } {
  if (v === undefined || v === null || v === "" || v === 0) return { ok: true };
  return validAmount(v) ? { ok: true, sar: v } : { ok: false };
}
/**
 * What the payout form sends for an optional tax field: absent when empty, the number when the text is one, and the text
 * itself otherwise ("1,500", "12,5"), so `optionalTax` refuses it with bad_vat or bad_wht. Never `Number(text)` alone:
 * NaN becomes null in JSON, which reads as "no amount", and the tax the founder meant to record would be lost unseen.
 */
export function taxField(text: string): number | string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

// ---- Bank details ----

/**
 * The partner's payout details. `country` is where the partner lives (ISO 3166-1 alpha-2), which may differ from the
 * IBAN's country; `taxNumber` is the partner's VAT or tax registration number, when they have one; `vatRegistered` is the
 * partner's own answer that they are registered for VAT (a tax number alone may be an income-tax id), and needs the
 * number. `confirmedAt` is set
 * by the founder after checking the details with the partner out of band (by phone, from the application); every save
 * by the partner clears it. No payout is marked paid to unconfirmed details. `country` is missing only on details saved
 * before it was asked (none in production: the programme ships with it).
 */
export type Bank = { holder: string; iban: string; country?: string; taxNumber?: string; vatRegistered?: boolean; savedAt: string; confirmedAt?: string; confirmedBy?: string };
/** True when the founder confirmed these exact details after their last change. */
export const bankConfirmed = (b: Pick<Bank, "savedAt" | "confirmedAt"> | null | undefined): boolean => !!b?.confirmedAt && b.confirmedAt >= b.savedAt;

/**
 * IBAN lengths from the ISO 13616 registry for common countries, all six GCC states included. A country not listed
 * still passes the generic check (15 to 34 characters and the mod-97 checksum); a listed one must have its exact length.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  // The GCC
  SA: 24, AE: 23, BH: 22, KW: 30, QA: 29, OM: 23,
  // The region
  EG: 29, JO: 30, LB: 28, IQ: 23, PS: 29, TN: 24, LY: 25, SD: 18, MR: 27, YE: 30, SO: 23, DJ: 27, PK: 24, TR: 26, IL: 23,
  // Europe
  GB: 22, IE: 22, DE: 22, FR: 27, NL: 18, BE: 16, LU: 20, IT: 27, ES: 24, PT: 25, CH: 21, AT: 20, SE: 24, NO: 15, DK: 18,
  FI: 18, PL: 28, RO: 24, CZ: 24, HU: 28, GR: 27, CY: 28, MT: 31, BG: 22, HR: 21, EE: 20, LT: 20, LV: 21, SI: 19, SK: 24,
  IS: 26,
  // Elsewhere
  KZ: 20, AZ: 28, GE: 22, UA: 29, BR: 29, RU: 33,
};
/** The ISO 13616 mod-97 check of a compact uppercase IBAN: the first four characters move to the end, letters count 10-35. */
export function ibanChecksumOk(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}
/**
 * Any country's IBAN (rule 411): an ISO 3166 country code (`COUNTRY_CODES`), two check digits, then letters and digits,
 * 15 to 34 characters in all; the registry length for a country in `IBAN_LENGTHS`; and the mod-97 checksum. Spaces, dashes and
 * case are ignored. Returns the compact uppercase form, or null.
 */
export function validIban(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const iban = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) || !COUNTRIES.has(iban.slice(0, 2))) return null;
  const want = IBAN_LENGTHS[iban.slice(0, 2)];
  if (want !== undefined && iban.length !== want) return null;
  return ibanChecksumOk(iban) ? iban : null;
}
/** What the partner sees after saving: the country code and the last four characters only. */
export const maskIban = (iban: string): string => `${iban.slice(0, 2)}•• •••• •••• •••• •••• ${iban.slice(-4)}`;

/** Every ISO 3166-1 alpha-2 country code, plus XK (Kosovo, which the IBAN registry uses): the partner's country of residence. */
export const COUNTRY_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
  "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
  "UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");
const COUNTRIES: ReadonlySet<string> = new Set(COUNTRY_CODES);
/** A country's name in Arabic or English from the runtime's own data, or the code when it has none. */
export function countryName(code: string, lang: "ar" | "en"): string {
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
/**
 * The country select's options, Saudi Arabia first and the rest by name. Built on the server and handed to the form,
 * so the browser never renders names from different locale data than the server did.
 */
export function countryOptions(lang: "ar" | "en"): [code: string, name: string][] {
  const named = COUNTRY_CODES.map((c) => [c, countryName(c, lang)] as [string, string]);
  const rest = named.filter(([c]) => c !== "SA").sort((a, b) => a[1].localeCompare(b[1], lang));
  return [named.find(([c]) => c === "SA")!, ...rest];
}
/** A country code from the list, uppercase, or null. */
export function validCountry(raw: unknown): string | null {
  const c = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return COUNTRIES.has(c) ? c : null;
}
/**
 * The partner's optional VAT or tax registration number: undefined when nothing was typed, else 3 to 30 letters,
 * digits, spaces, dots, dashes or slashes, stored uppercase; "bad" when what was typed is not one.
 */
export function taxNumberOf(raw: unknown): string | undefined | "bad" {
  const t = typeof raw === "string" ? raw.trim().toUpperCase().replace(/\s+/g, " ") : "";
  if (!t) return undefined;
  return /^[A-Z0-9][A-Z0-9 ./-]{1,28}[A-Z0-9]$/.test(t) ? t : "bad";
}
/**
 * What the founder checks before a transfer (rule 412), never a rate: a VAT-registered partner (the partner ticked "I am
 * VAT-registered" and gave the number; a tax number alone may be an income-tax id and flags nothing) adds VAT on top of
 * the commission, which Thakeen pays; a partner living outside Saudi Arabia may be subject to withholding tax, which
 * Thakeen bears. `noCountry`: details saved before the country was asked.
 */
export function taxFlags(b: Pick<Bank, "country" | "taxNumber" | "vatRegistered"> | null | undefined): { vatRegistered: boolean; outsideSaudi: boolean; noCountry: boolean } {
  return { vatRegistered: !!b?.vatRegistered && !!b.taxNumber, outsideSaudi: !!b?.country && b.country !== "SA", noCountry: !!b && !b.country };
}

/**
 * The label a partner sees for a referred customer: never the name or email, a stable short code instead, taken from
 * the random `ref` drawn at attribution (src/lib/partners.ts `customerLabel`), so it cannot be recomputed from a guessed
 * address.
 */
export const CUSTOMER_LABEL_PREFIX = "C-";
