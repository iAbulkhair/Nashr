import { describe, expect, it } from "vitest";
import { BANTER_EXCHANGE_MS, BANTER_FIRST_MS, BANTER_LINE_MS, BANTER_REST_MS, exchangeTimes } from "@/lib/banter-clock";
import { BANTER } from "@/lib/home";

describe("the lineup's banter cadence", () => {
  it("uses the ruled timings", () => {
    expect([BANTER_FIRST_MS, BANTER_LINE_MS, BANTER_EXCHANGE_MS, BANTER_REST_MS]).toEqual([1500, 2200, 8000, 2200]);
  });

  it("a one-line exchange: one line for 2.2 s, the next exchange 8 s after it started", () => {
    expect(exchangeTimes(1500, 1)).toEqual({ lines: [1500], end: 3700, next: 9500 });
  });

  it("a two-line exchange: lines 2.2 s apart, the next exchange still on the 8 s beat", () => {
    expect(exchangeTimes(1500, 2)).toEqual({ lines: [1500, 3700], end: 5900, next: 9500 });
  });

  it("a four-line exchange runs past the 8 s beat, so the next one waits 2.2 s after its last line", () => {
    expect(exchangeTimes(9500, 4)).toEqual({ lines: [9500, 11700, 13900, 16100], end: 18300, next: 20500 });
  });

  it("the real banter: the first exchange 1.5 s after the lineup shows, and never less than 2.2 s of quiet between", () => {
    let start = BANTER_FIRST_MS;
    const starts: number[] = [];
    for (const exchange of [...BANTER, ...BANTER]) {
      const at = exchangeTimes(start, exchange.lines.length);
      starts.push(start);
      expect(at.next - start).toBeGreaterThanOrEqual(BANTER_EXCHANGE_MS);
      expect(at.next - at.end).toBeGreaterThanOrEqual(BANTER_REST_MS);
      start = at.next;
    }
    expect(starts.slice(0, 5)).toEqual([1500, 9500, 20500, 28500, 36500]);
  });
});
