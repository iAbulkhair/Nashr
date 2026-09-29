import { describe, expect, it } from "vitest";
import { FLIP_MS, STAGGER_MS, flipDelay, flipIndex, flipTick, untilNextFlip } from "@/lib/flip-clock";
import { AGENT_CAST } from "@/lib/home";

/** The lineup's figures that flip: the agents, in their places in the row (the owner, last, has no questions). */
const AGENTS = AGENT_CAST.map((_, i) => i);

/** The moments in (from, to) at which the figure at `index` shows a new question, stepping the clock 1 ms at a time. */
function flipsBetween(index: number, from: number, to: number): number[] {
  const shows = (t: number) => flipIndex(t, flipDelay(index), 4);
  const out: number[] = [];
  for (let t = from + 1; t < to; t++) if (shows(t) !== shows(t - 1)) out.push(t);
  return out;
}

describe("the lineup's flip clock", () => {
  it("staggers the figures by their place in the row, so no two flip together", () => {
    // In the first round each agent flips 300 ms after the one before it, and no two flips ever share a moment.
    const flips = AGENTS.map((i) => flipsBetween(i, 0, FLIP_MS + AGENTS.length * STAGGER_MS));
    expect(flips.map((f) => f[0])).toEqual(AGENTS.map((i) => FLIP_MS + i * STAGGER_MS));
    expect(new Set(flips.flat()).size).toBe(flips.flat().length);
  });

  it("spreads every agent on the homepage evenly across one flip, so none flips right after another's turn", () => {
    // Where in the 2.4 s period each agent flips. With a stagger too long for the cast, the last agent wraps round and
    // flips a moment after the first (8 × 343 ms: 1 ms apart).
    const beats = AGENTS.map((i) => flipDelay(i) % FLIP_MS).sort((a, b) => a - b);
    const gaps = beats.map((b, k) => (k + 1 < beats.length ? beats[k + 1] : beats[0] + FLIP_MS) - b);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(Math.floor(FLIP_MS / AGENTS.length));
  });

  it("shows the first question until a figure's first flip, even before the clock reaches its delay", () => {
    expect(flipTick(0, flipDelay(6))).toBeLessThan(0);
    expect(flipIndex(0, flipDelay(6), 4)).toBe(0);
    expect(flipIndex(-5_000, flipDelay(3), 4)).toBe(0);
    expect(flipIndex(flipDelay(3) + FLIP_MS - 1, flipDelay(3), 4)).toBe(0);
    expect(flipIndex(flipDelay(3) + FLIP_MS, flipDelay(3), 4)).toBe(1);
  });

  it("does not drift: after days of elapsed time each figure still flips on its own beat", () => {
    const days = 9 * 24 * 60 * 60 * 1000;
    const k = Math.floor(days / FLIP_MS);
    for (const i of [0, 3, 6]) {
      const beat = k * FLIP_MS + flipDelay(i);
      expect(flipTick(beat - 1, flipDelay(i))).toBe(k - 1);
      expect(flipTick(beat, flipDelay(i))).toBe(k);
      expect(flipIndex(beat, flipDelay(i), 5)).toBe(k % 5);
    }
  });

  it("resumes in place: from the question on screen, one flip 2.4 s after it starts moving again", () => {
    // The story's agent held question 2 of 4 while its chapter was away; its own clock starts at 0 when it comes back.
    expect(untilNextFlip(0, 0)).toBe(FLIP_MS);
    expect(flipIndex(0, 0, 4, 2)).toBe(2);
    expect(flipIndex(FLIP_MS - 1, 0, 4, 2)).toBe(2);
    expect(flipIndex(FLIP_MS, 0, 4, 2)).toBe(3);
    expect(flipIndex(2 * FLIP_MS, 0, 4, 2)).toBe(0);
    // Never skips a question on the way.
    const seen = Array.from({ length: 6 }, (_, n) => flipIndex(n * FLIP_MS, 0, 4, 3));
    expect(seen).toEqual([3, 0, 1, 2, 3, 0]);
  });

  it("cycles through the questions and waits exactly until the next flip", () => {
    const seen = Array.from({ length: 10 }, (_, n) => flipIndex(n * FLIP_MS + flipDelay(2), flipDelay(2), 4));
    expect(seen).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1]);
    expect(untilNextFlip(flipDelay(2), flipDelay(2))).toBe(FLIP_MS);
    expect(untilNextFlip(flipDelay(2) + 100, flipDelay(2))).toBe(FLIP_MS - 100);
    expect(untilNextFlip(0, flipDelay(2))).toBe(flipDelay(2));
    expect(flipIndex(123_456, 0, 0)).toBe(0);
  });
});
