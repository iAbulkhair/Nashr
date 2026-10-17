import { dateFormat } from "./dates";

/**
 * Account suspension with an optional end date (rules 2070-2076, docs/system/flows.md section 84). Client-safe: only
 * `dates.ts`, which imports nothing, so the console and the log-in form can use it.
 *
 * Stored shape, an expand (rule 679), in the account's existing `suspended` field:
 * - absent or `false`: not suspended (as before);
 * - `true`: suspended with no end date (as before, and what every old record holds: it reads as indefinite);
 * - `{ until: ISO }`: suspended until that moment, new.
 *
 * Why the same field and not a new `suspendedUntil` beside it: code from before this release reads `suspended` only for
 * its truth, so an object still blocks there (it never ends early: it ends later, at the next unsuspend, which is safe),
 * and every old write sets the whole field to `true` or `false`, so an end date can never outlive an old unsuspend and
 * shorten a later indefinite suspension. There is no contract step: `true` stays the indefinite shape for good.
 *
 * `isSuspended` is the only reader (rule 2071, pinned by a test that greps for any other `.suspended` read). An expired
 * suspension stops blocking the moment it ends, at read time; nothing has to run for that (rule 2072).
 */

export type Suspension = true | { until: string };
/** The `suspended` field as stored: `false` and absent both mean not suspended. */
export type StoredSuspension = boolean | { until: string };
type HasSuspension = { suspended?: unknown } | null | undefined;

/** The longest end date staff can pick, in days from now. */
export const SUSPEND_MAX_DAYS = 365;
/** What staff pick in the suspend form: no end date, 7 days, 30 days, or until a date. */
export const SUSPEND_FOR = ["indefinite", "7", "30", "date"] as const;
export type SuspendFor = (typeof SUSPEND_FOR)[number];
const DAY = 864e5;

/** The end of a timed suspension as an ISO string, or null (none, indefinite, or not a moment). */
export function suspensionEnd(u: HasSuspension): string | null {
  const v = u?.suspended;
  if (!v || typeof v !== "object") return null;
  const until = (v as { until?: unknown }).until;
  return typeof until === "string" && Number.isFinite(Date.parse(until)) ? until : null;
}

/**
 * Is the account blocked now? `true` (and any other truthy value this code does not know, a broken end date included)
 * blocks: the check fails closed. `{ until }` blocks only until that moment.
 */
export function isSuspended(u: HasSuspension, now: number = Date.now()): boolean {
  const v = u?.suspended;
  if (!v) return false;
  if (v === true || typeof v !== "object") return true;
  const end = suspensionEnd(u);
  return end === null ? true : Date.parse(end) > now;
}

/** Stored as suspended, but its end date has passed: what `endExpiredSuspension` tidies and writes to the log. */
export const suspensionExpired = (u: HasSuspension, now: number = Date.now()): boolean => !!u?.suspended && !isSuspended(u, now);

/**
 * Staff's choice (the form's `for` and `date`) as the value to store, or `bad_until`. A request without `for` keeps the
 * old meaning, no end date, so a script that only says `suspend` still works. A date is a calendar day `YYYY-MM-DD`: the
 * account opens at the start of that day in Riyadh, at least tomorrow and at most SUSPEND_MAX_DAYS away.
 */
export function parseSuspendFor(forValue: unknown, date: unknown, now: number = Date.now()): { ok: true; value: Suspension } | { ok: false; error: "bad_until" } {
  const f = forValue === undefined || forValue === null || forValue === "" ? "indefinite" : String(forValue);
  if (f === "indefinite") return { ok: true, value: true };
  if (f === "7" || f === "30") return { ok: true, value: { until: new Date(now + Number(f) * DAY).toISOString() } };
  if (f !== "date" || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "bad_until" };
  const at = Date.parse(`${date}T00:00:00+03:00`);
  // A real day only: "2026-02-31" parses to March in some engines, so the day must read back the same.
  if (!Number.isFinite(at) || new Date(at + 3 * 36e5).toISOString().slice(0, 10) !== date) return { ok: false, error: "bad_until" };
  if (at <= now || at > now + SUSPEND_MAX_DAYS * DAY) return { ok: false, error: "bad_until" };
  return { ok: true, value: { until: new Date(at).toISOString() } };
}

/** An end date as the customer and staff read it: day, month, year and time, in Riyadh. */
export const formatSuspensionEnd = (iso: string, lang: "ar" | "en") =>
  dateFormat(lang, { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" }, "Asia/Riyadh").format(new Date(iso));

/** The log-in form's message for a suspended account with an end date (rule 2075). Without one the form keeps its own. */
export const SUSPENDED_UNTIL = {
  ar: (d: string) => `حسابك موقوف لحد ${d} بتوقيت الرياض، وبعدها يرجع يشتغل تلقائي. لو عندك سؤال كلّمنا على واتساب.`,
  en: (d: string) => `This account is suspended until ${d}, Riyadh time. It opens again by itself after that. Questions? Contact us on WhatsApp.`,
} as const;

/** The message for a `suspended` answer: with the end date when the answer carries a valid one, else `fallback`. */
export function suspendedMessage(until: unknown, lang: "ar" | "en", fallback: string): string {
  return typeof until === "string" && Number.isFinite(Date.parse(until)) ? SUSPENDED_UNTIL[lang](formatSuspensionEnd(until, lang)) : fallback;
}
