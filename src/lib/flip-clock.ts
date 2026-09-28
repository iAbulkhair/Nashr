/**
 * The clock behind the lineup's flipping questions (spec §7.3): one question visible, a new one every 2.4 s, and the
 * figures staggered so they never flip together. Every figure reads its question from the same elapsed time instead of
 * counting its own timer ticks, so timers that fire late (a busy page, a throttled background tab) can never pull the
 * stagger apart. Pure and import-free: the client component keeps the epoch and the timers.
 */

/** One question on screen for 2.4 s. */
export const FLIP_MS = 2400;

/** 7 × 343 ms spreads the seven agents across one 2.4 s flip. */
export const STAGGER_MS = 343;

/** The figure at `index` runs this far behind the shared clock: its first flip comes at `flipDelay + FLIP_MS`. */
export const flipDelay = (index: number): number => index * STAGGER_MS;

/** How many flips a figure with this delay has made at `elapsedMs` on the shared clock; negative before it starts. */
export function flipTick(elapsedMs: number, delayMs: number): number {
  return Math.floor((elapsedMs - delayMs) / FLIP_MS);
}

/** Which of `count` questions shows at `elapsedMs`: the first until the figure's first flip, then one per period. */
export function flipIndex(elapsedMs: number, delayMs: number, count: number): number {
  return count > 0 ? Math.max(0, flipTick(elapsedMs, delayMs)) % count : 0;
}

/** Milliseconds from `elapsedMs` to this figure's next flip. Always more than 0 and at most one period. */
export function untilNextFlip(elapsedMs: number, delayMs: number): number {
  return (flipTick(elapsedMs, delayMs) + 1) * FLIP_MS + delayMs - elapsedMs;
}
