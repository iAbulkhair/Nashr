import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { until } from "@/lib/model";

/**
 * Rule 1206: a deadline built from a budget reads the clock once and hands that reading to `until` as `now`, so the
 * per-attempt timeout equals the budget exactly. `until(Date.now() + X)` read the clock a second time inside `until`,
 * and a millisecond tick between the two reads gave X - 1 (CI run 38160469570, tests/media-prompts.test.ts).
 */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
/** Source without comments, so a comment that quotes the old form is not a call. "https://" keeps its colon. */
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

afterEach(() => { vi.restoreAllMocks(); });

describe("one clock reading per deadline (rule 1206)", () => {
  it("until with the caller's `now` gives the whole budget while the clock ticks 1 ms per read", () => {
    let t = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t++);
    for (const budget of [20_000, 45_000, 5_000]) {
      const now = Date.now();
      expect(until(now + budget, { now }).timeout, `budget ${budget}`).toBe(budget);
    }
  });

  it("without `now`, until reads the clock itself: the reason the callers pass theirs", () => {
    let t = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t++);
    expect(until(Date.now() + 20_000).timeout).toBe(19_999);
  });

  it("no file in src builds a deadline as until(Date.now() + ...)", () => {
    const bad = walk("src").filter((f) => /until\(\s*Date\.now\(\)/.test(code(f)));
    expect(bad).toEqual([]);
  });
});
