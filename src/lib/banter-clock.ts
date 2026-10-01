/**
 * When the lineup's banter plays (spec §7.3, "every 6–10 s one banter exchange"). Pure and import-free: Lineup.tsx
 * owns the timers and reads every moment from here.
 */

/** The first exchange starts this long after the lineup comes into view (or starts moving again). */
export const BANTER_FIRST_MS = 1500;

/** Each line holds this long; a pressed figure's answer too. */
export const BANTER_LINE_MS = 2200;

/** The next exchange starts at least this long after the previous one started… */
export const BANTER_EXCHANGE_MS = 8000;

/** …and at least this long after its last line ended, so a long exchange still gets a pause after it. */
export const BANTER_REST_MS = 2200;

/**
 * The moments of one exchange that starts at `start` (any clock, in ms): when each line shows, when the last one
 * ends, and when the next exchange starts: max(start + 8000, end + 2200).
 */
export function exchangeTimes(start: number, lineCount: number): { lines: number[]; end: number; next: number } {
  const lines = Array.from({ length: lineCount }, (_, i) => start + i * BANTER_LINE_MS);
  const end = start + lineCount * BANTER_LINE_MS;
  return { lines, end, next: Math.max(start + BANTER_EXCHANGE_MS, end + BANTER_REST_MS) };
}
