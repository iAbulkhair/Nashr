import type { N } from "../figures";
import type { Range, Totals } from "../social-stats";

/**
 * What every social reader shares: the key of the posts Thakeen published, the empty totals, the deadline, the split of
 * one read into two periods, the strict count, and the adapter's error shapes. Kept apart from social-stats.ts, which lists the readers
 * (READERS) and so imports each platform's file: a reader importing social-stats.ts back would load in a cycle. This file
 * imports nothing at run time and never reaches Composio (rule 652).
 */

/**
 * Post ids Thakeen published for this workspace on a platform whose results are read (publish-once.ts), so a result can
 * say «من ذكين». No TTL: the wrapper cannot refresh a set's TTL, one id is about 20 bytes, and wipeAccount deletes it.
 */
export const SOCIAL_PUB_KEY = (scope: string) => `socialpub:${scope}`;
export const EMPTY_TOTALS: Totals = Object.freeze({ views: null, reach: null, engagements: null, clicks: null, likes: null, comments: null, shares: null, pageViews: null, followsGained: null, followsLost: null, watchMinutes: null });

export const DAY_MS = 864e5;
export const day = (d: Date) => d.toISOString().slice(0, 10);
/** A date as the platforms take and give it (YYYY-MM-DD). */
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Throws `deadline` once the shared deadline has come (rule 741): every reader calls it before each Composio read. */
export function beforeDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new Error("deadline");
}
export const late = (e: unknown) => e instanceof Error && e.message === "deadline";

/** The same number of whole days as `r`, ending the day before it starts (rule 733): the previous period. */
export function rangeBefore(r: Range): Range {
  const start = Date.parse(r.from);
  const len = Math.round((Date.parse(r.to) - start) / DAY_MS) + 1;
  return { from: day(new Date(start - len * DAY_MS)), to: day(new Date(start - DAY_MS)) };
}

/**
 * Rows of one read split into the window's days and the same number of days just before it (rule 733): one call for
 * both periods, split in code. A row without a date (YYYY-MM-DD), or dated in neither period, counts in neither.
 */
export function splitDays<T extends { day: string }>(rows: T[], window: Range): { cur: T[]; prev: T[] } {
  const before = rangeBefore(window);
  const within = (d: string, r: Range) => ISO_DAY.test(d) && d >= r.from && d <= r.to;
  return { cur: rows.filter((r) => within(r.day, window)), prev: rows.filter((r) => within(r.day, before)) };
}
/**
 * A platform's count: a finite number of zero or more, or one written in digits ("1234"). Anything else is not read: an
 * empty `{}`, "", "N/A", NaN, Infinity or a negative becomes null, never NaN, a string or zero (Review Focus 5).
 */
export function count(v: unknown): N {
  const x = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(x) && x >= 0 ? x : null;
}
/** A call's answer or its error, so one failed side of a read never rejects the others. */
export const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
/** A platform's timestamp as its date (YYYY-MM-DD), or "" when it does not start with one. */
export const dateOf = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
/** The adapter's 401 (composio.ts statusOf): only a new connection fixes it, so it is never retried or hidden. */
export const refused = (e: unknown) => e instanceof Error && / 401:/.test(e.message);
/** A timeout or a rate limit: asking again for fewer metrics only spends more of the same budget. */
export const busy = (e: unknown) =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || / 429:|rate.?limit|composio_rate_limited/i.test(e.message));
