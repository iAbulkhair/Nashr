/**
 * Figure helpers shared by the ad totals (ad-stats.ts), the site totals (site-stats.ts), the social block
 * (social-stats.ts) and the Reports cards (SiteStats.tsx, SocialStats.tsx). No imports, so the server and the client
 * bundle can both use it.
 *
 * `null` is a figure that was not read: unknown, never zero (rules 731, 737). A change over time exists only where both
 * figures were read and the previous one is not 0, so a report never says "up from 0" (rule 733).
 */

/** null = not read, never 0. */
export type N = number | null;

/** `x` rounded to `d` decimals. */
export const roundTo = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Sums are rounded to two decimals, so float noise (0.1 + 0.2) never reaches a report. */
export const round2 = (x: number) => roundTo(x, 2);

/** The sum over the values read (two decimals); null, NaN and Infinity are not read; none read is null, never 0. */
export function sumRead(xs: N[]): N {
  const read = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return read.length ? round2(read.reduce((a, b) => a + b, 0)) : null;
}

/** The change from `prev` to `cur` in percent (25 is up 25%), unrounded; null when either was not read or `prev` is 0. */
export function pctChange(cur: N, prev: N): N {
  if (cur == null || prev == null || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

/**
 * Engagements over views as a fraction (0.0733 is 7.33%), unrounded; null when either was not read or views are 0.
 * Worked out where it is shown (Dana's block rounds it to four decimals, the Reports card prints it as a percent), never
 * stored (rule 737).
 */
export const rate = (t: { engagements: N; views: N }): N => (t.engagements != null && t.views ? t.engagements / t.views : null);
