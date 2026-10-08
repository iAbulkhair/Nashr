import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pctChange, rate, round2, roundTo, sumRead } from "@/lib/figures";

/**
 * Rules 731, 733 and 737: the figure helpers the ad totals, the site totals and the Reports card share. null is a
 * figure that was not read, never 0; a sum over nothing read is null; a change needs both figures and a previous one
 * that is not 0.
 */
describe("figures (rules 731, 733, 737)", () => {
  it("sumRead adds only the values read: null and NaN count as not read, 0 counts as read", () => {
    expect(sumRead([])).toBeNull();
    expect(sumRead([null, null])).toBeNull();
    expect(sumRead([Number.NaN, null])).toBeNull();
    expect(sumRead([Number.POSITIVE_INFINITY, null])).toBeNull();
    expect(sumRead([0])).toBe(0);
    expect(sumRead([0, null])).toBe(0);
    expect(sumRead([5, null, 7])).toBe(12);
    expect(sumRead([5, Number.NaN, 7])).toBe(12);
  });

  it("sums and round2 keep two decimals, so float noise never reaches a report", () => {
    expect(sumRead([0.1, 0.2])).toBe(0.3);
    expect(sumRead([1.005, 2.004])).toBe(3.01);
    expect(round2(2.345678)).toBe(2.35);
    expect(round2(-1.234)).toBe(-1.23);
    expect(round2(10)).toBe(10);
    expect(roundTo(0.012345, 4)).toBe(0.0123);
    expect(roundTo(3.26, 1)).toBe(3.3);
    expect(roundTo(0.6126, 3)).toBe(0.613);
  });

  it("pctChange is the change in percent, null when either figure was not read or the previous one is 0", () => {
    expect(pctChange(100, 80)).toBe(25);
    expect(pctChange(60, 80)).toBe(-25);
    expect(pctChange(80, 80)).toBe(0);
    expect(pctChange(0, 80)).toBe(-100);
    expect(pctChange(50, 0), "no 'up from 0'").toBeNull();
    expect(pctChange(0, 0)).toBeNull();
    expect(pctChange(null, 80)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
    expect(pctChange(null, null)).toBeNull();
  });

  it("rate is engagements over views as an unrounded fraction, null when either was not read or views are 0", () => {
    expect(rate({ engagements: 14, views: 900 })).toBe(14 / 900);
    expect(rate({ engagements: 0, views: 900 })).toBe(0);
    expect(rate({ engagements: 14, views: 0 }), "no rate over no views").toBeNull();
    expect(rate({ engagements: null, views: 900 })).toBeNull();
    expect(rate({ engagements: 14, views: null })).toBeNull();
  });

  it("imports nothing, so the server and the Reports card share it", () => {
    expect(readFileSync("src/lib/figures.ts", "utf8")).not.toMatch(/^\s*import\s/m);
  });
});
