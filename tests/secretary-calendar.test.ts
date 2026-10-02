import { afterEach, describe, expect, it } from "vitest";
import { hijriDate } from "@/lib/seasons";
import { isRamadan } from "@/lib/secretary-evening";

/**
 * Rules 470-489 in docs/system/tests.md: Reem phase 3 A1 (the brand's work calendar and away contacts, spec
 * docs/superpowers/specs/2026-10-02-secretary-reem-phase3a-design.md). Rule 470 first: Hijri dates are read in the
 * brand's zone, because the calendar day flips at the brand's midnight and not at the server's.
 */
const TZ = process.env.TZ;
afterEach(() => {
  if (TZ === undefined) delete process.env.TZ;
  else process.env.TZ = TZ;
});

describe("rule 470: Hijri dates follow the brand's zone, not the server's", () => {
  it("2027-03-09 is 1 Shawwal 1448 in Riyadh whatever TZ the process has", () => {
    for (const tz of ["UTC", "Asia/Riyadh", "America/New_York"]) {
      process.env.TZ = tz;
      expect(hijriDate(new Date("2027-03-08T21:30:00Z"), "Asia/Riyadh")).toEqual({ y: 1448, m: 10, day: 1 });
    }
  });

  it("the day flips at local midnight: 20:59Z on 2027-02-07 is still Sha'ban in Riyadh, 21:00Z is 1 Ramadan", () => {
    expect(hijriDate(new Date("2027-02-07T20:59:00Z"), "Asia/Riyadh").m).toBe(8);
    expect(hijriDate(new Date("2027-02-07T21:00:00Z"), "Asia/Riyadh")).toEqual({ y: 1448, m: 9, day: 1 });
  });

  it("isRamadan and the wrap time are per zone", () => {
    const t = Date.parse("2027-02-07T20:30:00Z"); // 00:30 in Dubai (Ramadan 1), 23:30 in Riyadh (Sha'ban 30)
    expect(isRamadan(t, "Asia/Dubai")).toBe(true);
    expect(isRamadan(t, "Asia/Riyadh")).toBe(false);
  });
});
