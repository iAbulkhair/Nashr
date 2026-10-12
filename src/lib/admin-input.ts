/**
 * What the founder console accepts from its forms before it sends a request (rules 960, 1100-1102 from #321, 1176).
 * Client-safe: it imports only the client-safe pricing module. The server checks again; these only stop a request the
 * founder did not mean to send, and say why inside the form that asked (`AdminForm`), which stays open.
 */
import { MAX_SEAT_OVERRIDE, isChatOverride, isTopupPack, parseDeal, type DealInput } from "./pricing";

/** A form's answer: the request body it makes, or the error code shown in the form. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The longest trial extension, in days. POST /api/admin/users/{email} `extendTrial` clamps to the same bound. */
export const TRIAL_EXTEND_MAX_DAYS = 90;

/**
 * "Extend trial": the number of days typed, a whole number from 1 to TRIAL_EXTEND_MAX_DAYS, or null for anything else.
 * Cancel is not a number either: before rule 960, `Number(null) || 7` sent 7 days on Cancel.
 */
export function parseTrialDays(raw: string | null): number | null {
  if (raw === null) return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= TRIAL_EXTEND_MAX_DAYS ? n : null;
}

/** The shortest reason the console sends with a change, and the longest (the server cuts at the same 200). */
export const REASON_MIN = 3;
export const REASON_MAX = 200;

/**
 * The reason every founder change asks for (rule 1176): one line, 3 to 200 characters after trimming. The console checks
 * it first, and since rule 1185 the server runs the same check (`reasonRefused` in admin-audit.ts) on every change the
 * console sends a reason with.
 */
export function parseReason(raw: string | null | undefined): Parsed<string> {
  const t = (raw ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (t.length < REASON_MIN) return { ok: false, error: "reason_short" };
  if (t.length > REASON_MAX) return { ok: false, error: "reason_long" };
  return { ok: true, value: t };
}

/** Adds the form's reason to a parsed body. */
export function withReason<T extends object>(p: Parsed<T>, reason: string | undefined): Parsed<T & { reason: string }> {
  return p.ok ? { ok: true, value: { ...p.value, reason: reason ?? "" } } : p;
}

/** A number from the text with its thousands commas and outer spaces dropped, or NaN when nothing was typed. */
const num = (raw: string): number => {
  const t = raw.replace(/,/g, "").trim();
  return t === "" ? NaN : Number(t);
};

/** The seat override (spec §5): 1 to MAX_SEAT_OVERRIDE, or 0 to go back to the plan's number (sent as null). */
export function parseSeats(raw: string): Parsed<{ seats: number | null }> {
  const n = num(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SEAT_OVERRIDE) return { ok: false, error: "bad_seats" };
  return { ok: true, value: { seats: n === 0 ? null : n } };
}

/** The chat override (rule 316): a number `isChatOverride` takes (0 stops chat), or empty / "plan" / «الخطة» to clear (null). */
export function parseChat(raw: string): Parsed<{ chatAllowance: number | null }> {
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "plan" || t === "الخطة") return { ok: true, value: { chatAllowance: null } };
  const n = Number(t);
  return isChatOverride(n) ? { ok: true, value: { chatAllowance: n } } : { ok: false, error: "bad_chat" };
}

/**
 * An Agency deal in one form: empty credits clears it (the server clears its seats too); otherwise `parseDeal`, the
 * server's own parser. The account's first deal always goes with plan "agency" (it grants the deal's allowance now);
 * a change to an existing deal does so only when "apply now" is ticked. Seats are optional, 1 to MAX_SEAT_OVERRIDE.
 */
export function parseDealForm(f: { credits: string; price: string; seats: string; applyNow: boolean }, hasDeal: boolean): Parsed<{ deal: DealInput | null; plan?: "agency"; seats?: number }> {
  if (f.credits.trim() === "") return { ok: true, value: { deal: null } };
  const parsed = parseDeal({ credits: Number(f.credits.trim()), priceSar: Number(f.price.trim()) });
  if (!parsed.ok) return parsed;
  const value: { deal: DealInput; plan?: "agency"; seats?: number } = { deal: parsed.deal };
  if (!hasDeal || f.applyNow) value.plan = "agency";
  if (f.seats.trim() !== "") {
    const n = num(f.seats);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SEAT_OVERRIDE) return { ok: false, error: "bad_seats" };
    value.seats = n;
  }
  return { ok: true, value };
}

/** "+ credits": any non-zero number (negative removes); 0, empty and text are refused. The server checks it again. */
export function parseCreditDelta(raw: string): Parsed<{ addCredits: number }> {
  const n = Number(raw.trim());
  return n ? { ok: true, value: { addCredits: n } } : { ok: false, error: "bad_credits" };
}

/**
 * A top-up pack paid outside the app (rules 446-447, 454): a pack `isTopupPack` takes, the amount paid excluding VAT
 * (0 or more), the payment day as typed (the server's `parseTopup` checks it is a Riyadh day not after today) and the
 * reference as typed (optional).
 */
export function parseTopupForm(f: { pack: string; paid: string; date: string; ref: string }): Parsed<{ credits: number; paidSar: number; paidOn: string; ref: string }> {
  const credits = num(f.pack);
  if (!isTopupPack(credits)) return { ok: false, error: "bad_pack" };
  const paidSar = num(f.paid);
  if (!Number.isFinite(paidSar) || paidSar < 0) return { ok: false, error: "bad_paid" };
  return { ok: true, value: { credits, paidSar, paidOn: f.date.trim(), ref: f.ref } };
}

/** "Refund unused" (rule 460): the transfer's day as typed and its reference, which is required. */
export function parseRefundForm(f: { date: string; ref: string }): Parsed<{ on: string; ref: string }> {
  if (!f.ref.trim()) return { ok: false, error: "bad_ref" };
  return { ok: true, value: { on: f.date.trim(), ref: f.ref } };
}

/** How long an impersonation may last, in minutes (rule 1177). The longest is the two hours every one had before. */
export const IMPERSONATE_MINUTES = [15, 60, 120] as const;
export type ImpersonateMinutes = (typeof IMPERSONATE_MINUTES)[number];
/** What a request without a length gets: the old two hours, so an older console keeps working. */
export const IMPERSONATE_DEFAULT: ImpersonateMinutes = 120;

/** One of `IMPERSONATE_MINUTES`; undefined is the old default; anything else is refused (null). */
export function parseImpersonateMinutes(v: unknown): ImpersonateMinutes | null {
  if (v === undefined || v === null || v === "") return IMPERSONATE_DEFAULT;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return (IMPERSONATE_MINUTES as readonly unknown[]).includes(n) ? (n as ImpersonateMinutes) : null;
}

/** The words for every error code these parsers answer, and the server's refusals the console shows, in both languages. */
export const ADMIN_INPUT_ERRORS = {
  en: {
    reason_short: `Write a reason of at least ${REASON_MIN} characters.`,
    reason_long: `Keep the reason to ${REASON_MAX} characters.`,
    bad_seats: `Seats: a whole number from 1 to ${MAX_SEAT_OVERRIDE}, or 0 for the plan's number.`,
    bad_chat: "Chat messages: a whole number, 0 to stop chat, or empty for the plan's number.",
    bad_deal: "The deal needs whole numbers for credits and price.",
    below_floor: "That price is under the Business rate per credit.",
    bad_credits: "Credits: a whole number other than 0 (negative removes).",
    bad_pack: "Pick one of the top-up packs.",
    bad_paid: "The amount paid is 0 or more, before VAT.",
    bad_ref: "The transfer reference is required.",
    bad_days: `Days: a whole number from 1 to ${TRIAL_EXTEND_MAX_DAYS}.`,
    bad_minutes: "Pick how long to view the account.",
    bad_grant: "Pick a day after today, at most a year ahead.",
    bad_paid_through: "Paid through: a day from today to 400 days ahead.",
    paid_through_needs_plan: "A trial has no paid-through day: set a paid plan first.",
    paid_through_paymob: "This account pays online: its subscription sets the paid-through day.",
    mismatch: "Type the email exactly to confirm.",
    failed: "That did not go through. Try again.",
  },
  ar: {
    reason_short: `اكتب سببًا لا يقل عن ${REASON_MIN} أحرف.`,
    reason_long: `اجعل السبب في حدود ${REASON_MAX} حرف.`,
    bad_seats: `المقاعد: عدد صحيح من 1 إلى ${MAX_SEAT_OVERRIDE}، أو 0 للعودة إلى عدد الخطة.`,
    bad_chat: "رسائل المحادثة: عدد صحيح، أو 0 لإيقاف المحادثة، أو فارغ للعودة إلى رقم الخطة.",
    bad_deal: "تحتاج الصفقة أعدادًا صحيحة للرصيد والسعر.",
    below_floor: "هذا السعر أقل من سعر الرصيد في خطة الأعمال.",
    bad_credits: "الرصيد: عدد صحيح غير الصفر (السالب يخصم).",
    bad_pack: "اختر إحدى باقات الرصيد.",
    bad_paid: "المبلغ المدفوع صفر أو أكثر، قبل الضريبة.",
    bad_ref: "مرجع التحويل مطلوب.",
    bad_days: `الأيام: عدد صحيح من 1 إلى ${TRIAL_EXTEND_MAX_DAYS}.`,
    bad_minutes: "اختر مدة عرض الحساب.",
    bad_grant: "اختر يومًا بعد اليوم، وفي حدود سنة.",
    bad_paid_through: "مدفوع حتى: يوم من اليوم إلى 400 يوم قادمة.",
    paid_through_needs_plan: "التجربة ليس لها يوم دفع: اختر خطة مدفوعة أولًا.",
    paid_through_paymob: "هذا الحساب يدفع إلكترونيًا: اشتراكه يحدد يوم الدفع.",
    mismatch: "اكتب البريد كما هو للتأكيد.",
    failed: "لم يتم ذلك. حاول مرة أخرى.",
  },
} as const;
export type AdminInputError = keyof (typeof ADMIN_INPUT_ERRORS)["en"];

/** The words for an error code, or the generic failure for a code this map does not know. */
export function inputError(lang: "ar" | "en", code: string): string {
  const m = ADMIN_INPUT_ERRORS[lang] as Record<string, string>;
  return m[code] ?? m.failed;
}
