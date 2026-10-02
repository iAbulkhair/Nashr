import { afterEach, describe, expect, it } from "vitest";
import { activeSeasons, hijriDate } from "@/lib/seasons";
import { eveningAt, isRamadan, previousEveningAt, zonesDue } from "@/lib/secretary-evening";

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

  // 00:30 on 8 Feb in Dubai (1 Ramadan 1448), 23:30 on 7 Feb in Riyadh (30 Sha'ban): inside the hour between Dubai's midnight and Riyadh's.
  const T = Date.parse("2027-02-07T20:30:00Z");

  it("isRamadan and activeSeasons read the zone's own day: 1 Ramadan in Dubai, still Sha'ban 30 in Riyadh", () => {
    expect(isRamadan(T, "Asia/Dubai")).toBe(true);
    expect(isRamadan(T, "Asia/Riyadh")).toBe(false);
    const ids = (zone: "Asia/Dubai" | "Asia/Riyadh") => activeSeasons(new Date(T), zone).map((s) => s.id);
    expect(ids("Asia/Dubai")).toContain("ramadan");
    expect(ids("Asia/Dubai")).not.toContain("pre_ramadan");
    expect(ids("Asia/Riyadh")).toContain("pre_ramadan");
    expect(ids("Asia/Riyadh")).not.toContain("ramadan");
  });

  it("the wrap time follows the zone's own Ramadan: 21:30 on Dubai's day 1, 18:00 on Riyadh's last Sha'ban day", () => {
    expect(eveningAt(T, "Asia/Dubai")).toBe(Date.parse("2027-02-08T17:30:00Z")); // 21:30 on 8 Feb in Dubai
    expect(eveningAt(T, "Asia/Riyadh")).toBe(Date.parse("2027-02-07T15:00:00Z")); // 18:00 on 7 Feb in Riyadh
    // The previous evening: Dubai's day before 1 Ramadan wrapped at 18:00; the day after its 1 Ramadan, the previous wrap was 21:30.
    expect(previousEveningAt(T, "Asia/Dubai")).toBe(Date.parse("2027-02-07T14:00:00Z")); // 18:00 on 7 Feb in Dubai
    const next = Date.parse("2027-02-08T20:30:00Z"); // 00:30 on 9 Feb in Dubai, 23:30 on 8 Feb in Riyadh
    expect(previousEveningAt(next, "Asia/Dubai")).toBe(Date.parse("2027-02-08T17:30:00Z")); // 21:30 on 8 Feb in Dubai (1 Ramadan)
    expect(previousEveningAt(next, "Asia/Riyadh")).toBe(Date.parse("2027-02-07T15:00:00Z")); // 18:00 on 7 Feb in Riyadh (30 Sha'ban)
  });

  it("a tick starts a zone at its own wrap time: Ramadan's 21:30 in Dubai, and the Ramadan wrap an hour before Dubai leaves Ramadan", () => {
    // 21:35 in Dubai and Muscat on 1 Ramadan: their 21:30 wrap is 5 minutes old; Riyadh's 21:30 is an hour away.
    expect(zonesDue(Date.parse("2027-02-08T17:35:00Z")).sort()).toEqual(["Asia/Dubai", "Asia/Muscat"]);
    // A four-hour look-back shows each zone's own wrap time at the hour the zones disagree. 7 Feb 23:30 in Riyadh is
    // Sha'ban 30: its wrap was 18:00, 5.5 hours ago, outside the window; Dubai's 21:30 is tomorrow's.
    expect(zonesDue(T, 4 * 3600_000)).toEqual([]);
    // 8 Mar 23:30 in Riyadh is still Ramadan (29th): its wrap was 21:30, 2 hours ago; Dubai is on 1 Shawwal, wrap 18:00 tomorrow.
    expect(zonesDue(Date.parse("2027-03-08T20:30:00Z"), 4 * 3600_000).sort()).toEqual(["Asia/Bahrain", "Asia/Kuwait", "Asia/Qatar", "Asia/Riyadh"]);
  });
});
