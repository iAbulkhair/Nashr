/**
 * What the founder console accepts from its forms before it sends a request (rules 960, 1100-1102). Client-safe: it
 * imports only the client-safe pricing module. The server checks again; these only stop a request the founder did not
 * mean to send, and say why inside the form that asked (`ActionDialog`), which stays open.
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

/** Adds the form's reason (logged, optional: an empty one still goes, as before) to a parsed body. */
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
