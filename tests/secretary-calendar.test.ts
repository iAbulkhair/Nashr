import { afterEach, describe, expect, it } from "vitest";
import { activeSeasons, hijriDate } from "@/lib/seasons";
import { eveningAt, isRamadan, previousEveningAt, zonesDue } from "@/lib/secretary-evening";
import { addWorkingDays, defaultCal, firstWorkingMoment, inRamadanWindow, isQuietDay, nowLine } from "@/lib/secretary-agenda";
import { nextWeekStart, snoozePreset } from "@/lib/secretary";
import { ZONE_IDS, isWeekend, weekStart, weekStartDay } from "@/lib/zones";

/**
 * Rules 470-489 in docs/system/tests.md: Reem phase 3 A1 (the brand's work calendar and away contacts, spec
 * docs/superpowers/specs/2026-10-02-secretary-reem-phase3a-design.md). Rule 470 first: Hijri dates are read in the
 * brand's zone, because the calendar day flips at the brand's midnight and not at the server's. Rule 471: the pure
 * calendar primitives (working days, week start, Ramadan windows) that read the brand's `CalData`.
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

describe("rule 471: working days, week start and windows from the brand calendar", () => {
  const riyadh = defaultCal("Asia/Riyadh");
  it("defaults match today's zone weekend", () => {
    expect(addWorkingDays(Date.parse("2026-10-01T09:00:00+03:00"), 2, "Asia/Riyadh", riyadh)).toBe(Date.parse("2026-10-05T09:00:00+03:00")); // Thu + 2 → Mon
  });
  it("a quiet day does not count", () => {
    const cal = { ...riyadh, quiet: { "2026-10-04": { kind: "holiday" as const } } };
    expect(addWorkingDays(Date.parse("2026-10-01T09:00:00+03:00"), 2, "Asia/Riyadh", cal)).toBe(Date.parse("2026-10-06T09:00:00+03:00"));
  });
  it("week start: Fri+Sat → Sunday, Sat+Sun → Monday, Fri only → Saturday, none → Sunday", () => {
    expect([weekStartDay([5, 6]), weekStartDay([6, 0]), weekStartDay([5]), weekStartDay([])]).toEqual([0, 1, 6, 0]);
  });
  it("an empty weekend: nextweek is the next Sunday 09:00", () => {
    const cal = { ...riyadh, weekend: [], weekStart: 0 };
    expect(snoozePreset("nextweek", Date.parse("2026-10-01T12:00:00+03:00"), "Asia/Riyadh", cal)).toBe("2026-10-04T06:00:00.000Z");
  });
  it("Ramadan windows are [from, to)", () => {
    // Monday 22 and Tuesday 23 February 2027: weekdays in Riyadh, so the case tests Ramadan and not the weekend.
    const cal = { ...riyadh, ramadan: ["2027-02-22", "2027-02-23"] };
    expect(inRamadanWindow(Date.parse("2027-02-22T10:00:00+03:00"), cal)).toBe(true);
    expect(inRamadanWindow(Date.parse("2027-02-22T15:00:00+03:00"), cal)).toBe(false);
    expect(firstWorkingMoment(Date.parse("2027-02-22T15:00:00+03:00"), cal)).toBe(Date.parse("2027-02-23T10:00:00+03:00"));
  });
  it("briefAt on a working day is not moved", () => {
    expect(firstWorkingMoment(Date.parse("2026-10-04T08:00:00+03:00"), riyadh)).toBe(Date.parse("2026-10-04T08:00:00+03:00"));
  });

  // Beyond the brief: what the callers in chaseMoment, the wrap and the alerts lean on.
  it("defaultCal is the zone's weekend and week start, no quiet days, 10:00-15:00 in Ramadan, and the brief's local time", () => {
    expect(riyadh).toEqual({ zone: "Asia/Riyadh", weekend: [5, 6], weekStart: 0, quiet: {}, ramadan: [], ramadanHours: [{ from: "10:00", to: "15:00" }], briefAt: { hh: 8, mm: 0 } });
    expect(defaultCal("Asia/Dubai")).toMatchObject({ weekend: [6, 0], weekStart: 1, briefAt: { hh: 9, mm: 0 } });
  });
  it("a day is quiet on the weekend or when the calendar lists it, and on no other day", () => {
    const cal = { ...riyadh, quiet: { "2026-10-04": { kind: "eid_fitr" as const } } };
    expect(["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"].map((d) => isQuietDay(d, cal))).toEqual([true, true, true, false]);
    expect(isQuietDay("2026-10-04", riyadh)).toBe(false);
  });
  it("two quiet days in a row after the weekend both stay out of the count", () => {
    const cal = { ...riyadh, quiet: { "2026-10-04": { kind: "eid_fitr" as const }, "2026-10-05": { kind: "eid_fitr" as const } } };
    expect(addWorkingDays(Date.parse("2026-10-01T09:00:00+03:00"), 2, "Asia/Riyadh", cal)).toBe(Date.parse("2026-10-07T09:00:00+03:00"));
  });
  it("a moment on a quiet day moves to briefAt on the next day that is not quiet", () => {
    const fri = Date.parse("2026-10-02T12:00:00+03:00");
    expect(firstWorkingMoment(fri, riyadh)).toBe(Date.parse("2026-10-04T08:00:00+03:00"));
    const cal = { ...riyadh, quiet: { "2026-10-04": { kind: "holiday" as const } } };
    expect(firstWorkingMoment(fri, cal)).toBe(Date.parse("2026-10-05T08:00:00+03:00"));
    // The UAE's brief is at 09:00 and its weekend is Saturday and Sunday.
    expect(firstWorkingMoment(Date.parse("2026-10-03T12:00:00+04:00"), defaultCal("Asia/Dubai"))).toBe(Date.parse("2026-10-05T09:00:00+04:00"));
  });
  it("two Ramadan windows: the boundary moments, the gap between them and the end of the last one", () => {
    const cal = { ...riyadh, ramadan: ["2027-02-22", "2027-02-23"], ramadanHours: [{ from: "10:00", to: "15:00" }, { from: "21:30", to: "23:30" }] };
    const at = (t: string) => Date.parse(`2027-02-22T${t}:00+03:00`);
    expect(firstWorkingMoment(at("10:00"), cal)).toBe(at("10:00"));
    expect(firstWorkingMoment(at("15:00"), cal)).toBe(at("21:30"));
    expect(firstWorkingMoment(at("20:00"), cal)).toBe(at("21:30"));
    expect(firstWorkingMoment(at("23:30"), cal)).toBe(Date.parse("2027-02-23T10:00:00+03:00"));
    expect(firstWorkingMoment(at("07:00"), cal)).toBe(at("10:00"));
  });
  it("outside a Ramadan day there are no windows, and an empty list of hours means no restriction", () => {
    const noon = Date.parse("2027-02-22T12:00:00+03:00");
    expect(inRamadanWindow(noon, riyadh)).toBe(false);
    const open = { ...riyadh, ramadan: ["2027-02-22"], ramadanHours: [] };
    const night = Date.parse("2027-02-22T23:59:00+03:00");
    expect(inRamadanWindow(night, open)).toBe(true);
    expect(firstWorkingMoment(night, open)).toBe(night);
  });
  it("a Ramadan day that is also quiet moves on as a quiet day first", () => {
    // Friday: a weekend day in Riyadh, so the moment goes to Sunday 08:00, and Sunday's own Ramadan hours then take it to 10:00.
    const cal = { ...riyadh, ramadan: ["2027-02-19", "2027-02-21"] };
    expect(firstWorkingMoment(Date.parse("2027-02-19T11:00:00+03:00"), cal)).toBe(Date.parse("2027-02-21T10:00:00+03:00"));
  });
  it("a calendar that is quiet every day still ends, and a weekend of seven days does not hang the count", () => {
    const week = [0, 1, 2, 3, 4, 5, 6];
    const t = Date.parse("2026-10-01T09:00:00+03:00");
    expect(Number.isFinite(firstWorkingMoment(t, { ...riyadh, weekend: week }))).toBe(true);
    expect(Number.isFinite(addWorkingDays(t, 2, "Asia/Riyadh", { ...riyadh, weekend: week }))).toBe(true);
  });
  it("the week start is named from the weekend in the prompt line and from the calendar's week start in the snooze", () => {
    const now = Date.parse("2026-10-01T12:00:00+03:00");
    expect(weekStart("Asia/Riyadh")).toBe("Sunday");
    expect(weekStart("Asia/Dubai")).toBe("Monday");
    // Every zone keeps the answer it had before the week start was computed: Monday only where Sunday is a weekend day.
    for (const z of ZONE_IDS) expect(weekStart(z)).toBe(isWeekend(z, 0) ? "Monday" : "Sunday");
    expect(nowLine(now, "Asia/Riyadh")).toMatch(/The work week starts on Sunday\.$/);
    expect(nowLine(now, "Asia/Riyadh", [6, 0])).toMatch(/The work week starts on Monday\.$/);
    expect(nowLine(now, "Asia/Riyadh", [5])).toMatch(/The work week starts on Saturday\.$/);
    expect(nowLine(now, "Asia/Dubai", [])).toMatch(/The work week starts on Sunday\.$/);
    // A brand that moved its week start to Monday: next week is the Monday, and without a calendar nothing changes.
    const monday = { ...riyadh, weekend: [6, 0], weekStart: 1 };
    expect(nextWeekStart(now, "Asia/Riyadh", monday)).toBe("2026-10-05");
    expect(snoozePreset("nextweek", now, "Asia/Riyadh", monday)).toBe("2026-10-05T06:00:00.000Z");
    expect(nextWeekStart(now, "Asia/Riyadh")).toBe("2026-10-04");
    expect(snoozePreset("nextweek", now, "Asia/Dubai")).toBe("2026-10-05T05:00:00.000Z");
  });
});
