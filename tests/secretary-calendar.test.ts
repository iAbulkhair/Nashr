import { afterEach, describe, expect, it } from "vitest";
import { activeSeasons, hijriDate } from "@/lib/seasons";
import { eveningAt, isRamadan, previousEveningAt, zonesDue } from "@/lib/secretary-evening";
import { addWorkingDays, defaultCal, firstWorkingMoment, inRamadanWindow, isQuietDay, nowLine } from "@/lib/secretary-agenda";
import { nextWeekStart, snoozePreset } from "@/lib/secretary";
import { COUNTRY_CAL, countryOf, parseCalendar, upcomingQuiet, workCalendar, type SecCalendar } from "@/lib/secretary-calendar";
import { ZONE_IDS, isWeekend, weekStart, weekStartDay, zoneOf, type Zone } from "@/lib/zones";

/**
 * Rules 470-489 in docs/system/tests.md: Reem phase 3 A1 (the brand's work calendar and away contacts, spec
 * docs/superpowers/specs/2026-10-02-secretary-reem-phase3a-design.md). Rule 470 first: Hijri dates are read in the
 * brand's zone, because the calendar day flips at the brand's midnight and not at the server's. Rule 471: the pure
 * calendar primitives (working days, week start, Ramadan windows) that read the brand's `CalData`. Rules 472-474: the
 * server's `workCalendar`, which builds that `CalData` from the country's private-sector holidays and the brand's
 * settings, and `parseCalendar`, which checks those settings. Every Hijri date and weekday below was checked against
 * ICU Umm al-Qura in Riyadh before it was written down.
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

// Rules 472-474. `calFor` builds a zone's calendar a month before the day asked about, so the day sits well inside the
// calendar's window (today-14 … today+400), the way the brief's helper reads it.
const DAY_MS = 864e5;
const at = (day: string) => Date.parse(`${day}T09:00:00Z`);
const calFor = (zone: Zone, day: string, cal: SecCalendar | null = null) => workCalendar(cal, zone, at(day) - 30 * DAY_MS);
const settings = (over: Partial<SecCalendar> = {}): SecCalendar => ({
  v: 1, weekend: null, ramadanHours: null, hijriFix: {}, holidays: { add: [], remove: [] }, updatedAt: "2026-10-02T09:00:00.000Z", updatedBy: "admin@example.com", ...over,
});
/** The quiet (non-weekend) days of a calendar between two days, in order. */
const quietBetween = (cal: { quiet: Record<string, unknown> }, from: string, to: string) => Object.keys(cal.quiet).filter((d) => d >= from && d <= to).sort();

describe("rule 472: Eid holidays per country (official private-sector spans)", () => {
  const q = (zone: Zone, day: string) => !!calFor(zone, day).quiet[day];

  it("2027-05-19 (13 Dhu al-Hijjah 1448, a Wednesday) is never an Eid day, and is quiet only in Saudi Arabia, as the day in lieu of the Saturday Arafah", () => {
    // Ruling R4, with the sources read on 2026-10-02: Saudi art. 24 (II.1) compensates every Eid day that falls on the
    // weekly rest; Oman compensates an Eid only when its first day (10 Dhu al-Hijjah, here a Sunday) is a Friday
    // (RD 88/2022); Bahrain only a Friday, and its Eid al-Adha is 10-12 without Arafah (Cabinet Resolution 1/2013);
    // Qatar's three working days start on 10 Dhu al-Hijjah (Sunday); the UAE and Kuwait have no compensation.
    for (const z of ZONE_IDS) {
      const why = calFor(z, "2027-05-19").quiet["2027-05-19"];
      expect(why?.kind, z).not.toBe("eid_adha");
      expect(!!why, z).toBe(z === "Asia/Riyadh");
    }
    expect(calFor("Asia/Riyadh", "2027-05-19").quiet["2027-05-19"]).toEqual({ kind: "holiday", name: { ar: "بدل إجازة عيد الأضحى", en: "Day in lieu of Eid al-Adha holiday" } });
  });

  it("29 Ramadan 1448 (2027-03-08) is quiet in Oman only", () => {
    for (const z of ZONE_IDS) expect(q(z, "2027-03-08"), z).toBe(z === "Asia/Muscat");
  });

  it("30 Ramadan 1447 (2026-03-19, Thursday) is quiet in SA, AE and OM only", () => {
    const yes = new Set(["Asia/Riyadh", "Asia/Dubai", "Asia/Muscat"]);
    for (const z of ZONE_IDS) expect(q(z, "2026-03-19"), z).toBe(yes.has(z));
    expect(calFor("Asia/Dubai", "2026-03-19").quiet["2026-03-19"]).toEqual({ kind: "eid_fitr", name: { ar: "إجازة عيد الفطر", en: "Eid al-Fitr holiday" } });
  });

  it("Eid al-Fitr 1447 (1 Shawwal = Friday 2026-03-20): each country's span and days in lieu, weekend days left out", () => {
    // SA: Thu 19 to Sun 22, and the Friday and Saturday inside it earn Mon 23 and Tue 24 (art. 24 II.1, after the span).
    // AE: 30 Ramadan to 3 Shawwal, its weekend is Sat+Sun, nothing in lieu. OM: 29 Ramadan (Wed 18) to 3 Shawwal, and
    // 1 Shawwal on a Friday earns Mon 23. KW: 1-3 Shawwal, nothing in lieu. BH: 1-3 Shawwal, the Friday earns the next
    // working day (Sun 22 is still Eid, so Mon 23). QA: three working days from 1 Shawwal: Sun 22, Mon 23, Tue 24.
    const expected: Record<Zone, string[]> = {
      "Asia/Riyadh": ["2026-03-19", "2026-03-22", "2026-03-23", "2026-03-24"],
      "Asia/Dubai": ["2026-03-19", "2026-03-20"],
      "Asia/Muscat": ["2026-03-18", "2026-03-19", "2026-03-22", "2026-03-23"],
      "Asia/Kuwait": ["2026-03-22"],
      "Asia/Bahrain": ["2026-03-22", "2026-03-23"],
      "Asia/Qatar": ["2026-03-22", "2026-03-23", "2026-03-24"],
    };
    for (const z of ZONE_IDS) expect(quietBetween(calFor(z, "2026-03-19"), "2026-03-14", "2026-03-28"), z).toEqual(expected[z]);
  });

  it("Arafah 1447 (Tuesday 2026-05-26) is an Eid day in SA, AE, OM and KW, not in BH or QA; the Eid's last day, Friday 29 May, earns Sunday 31 May in SA, BH and QA only", () => {
    for (const z of ZONE_IDS) {
      const cal = calFor(z, "2026-05-26");
      expect(cal.quiet["2026-05-26"]?.kind, z).toBe(["Asia/Bahrain", "Asia/Qatar"].includes(z) ? undefined : "eid_adha");
      expect(cal.quiet["2026-05-27"]?.kind, z).toBe("eid_adha");
      expect(!!cal.quiet["2026-05-31"], z).toBe(["Asia/Riyadh", "Asia/Bahrain", "Asia/Qatar"].includes(z));
    }
  });

  it("hijriFix: with 1 Shawwal 1448 moved to 2027-03-10 in Kuwait, 2027-03-09 is a Ramadan day and Fitr is 2027-03-10 to 2027-03-12", () => {
    const now = at("2026-10-02");
    const parsed = parseCalendar({ hijriFix: { "1448": { shawwal1: "2027-03-10" } } }, now, "Asia/Kuwait", "admin@example.com");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cal = workCalendar(parsed.cal, "Asia/Kuwait", at("2027-02-10"));
    expect(cal.ramadan).toContain("2027-03-09");
    expect(cal.ramadan).not.toContain("2027-03-10");
    expect(cal.quiet["2027-03-09"]).toBeUndefined();
    expect(cal.quiet["2027-03-10"]?.kind).toBe("eid_fitr");
    expect(cal.quiet["2027-03-11"]?.kind).toBe("eid_fitr");
    // Friday 2027-03-12 is the third Eid day and Kuwait's weekend: quiet as a weekend day, and Kuwait gives nothing in lieu.
    expect(isQuietDay("2027-03-12", cal)).toBe(true);
    expect(isQuietDay("2027-03-14", cal)).toBe(false);
    // Without the fix the same calendar has Eid on Umm al-Qura's 1 Shawwal, Tuesday 2027-03-09.
    expect(workCalendar(null, "Asia/Kuwait", at("2027-02-10")).quiet["2027-03-09"]?.kind).toBe("eid_fitr");
  });

  it("the Ramadan days are the effective month, inside the calendar's window", () => {
    const cal = workCalendar(null, "Asia/Riyadh", at("2026-10-02"));
    expect(cal.ramadan[0]).toBe("2027-02-08");
    expect(cal.ramadan[cal.ramadan.length - 1]).toBe("2027-03-08");
    expect(cal.ramadan).toHaveLength(29);
  });

  it("Review Focus 1: a brand without a stored zone follows its city: «دبي» then «الرياض» switches the weekend, the country and the holidays", () => {
    const now = at("2026-11-20");
    const brand: { timeZone?: string; city: string } = { city: "دبي" };
    const dubai = workCalendar(null, zoneOf(brand), now);
    expect(dubai.weekend).toEqual([6, 0]);
    expect(dubai.quiet["2026-12-02"]?.name?.en).toBe("National Day"); // the UAE's, a Wednesday
    brand.city = "الرياض";
    const riyadh = workCalendar(null, zoneOf(brand), now);
    expect(riyadh.weekend).toEqual([5, 6]);
    expect(riyadh.zone).toBe("Asia/Riyadh");
    expect(riyadh.quiet["2026-12-02"]).toBeUndefined();
  });

  it("the calendar is memoised by zone, local day and settings, not by who saved them or when; the memo keeps 200 entries", () => {
    const now = at("2026-10-02");
    const a = workCalendar(settings(), "Asia/Riyadh", now);
    expect(workCalendar(settings({ updatedAt: "2026-10-03T00:00:00.000Z", updatedBy: "other@example.com" }), "Asia/Riyadh", now + 3600_000)).toBe(a);
    const fridayOnly = workCalendar(settings({ weekend: [5] }), "Asia/Riyadh", now);
    expect(fridayOnly).not.toBe(a);
    expect(fridayOnly.weekend).toEqual([5]);
    expect(fridayOnly.weekStart).toBe(6);
    // A calendar handed out is frozen: a caller cannot change what the next caller reads.
    expect(Object.isFrozen(a) && Object.isFrozen(a.quiet) && Object.isFrozen(a.weekend)).toBe(true);
    // 200 other days push the first entry out: the next call builds it again, equal but not the same object.
    const first = workCalendar(null, "Asia/Qatar", at("2030-01-01"));
    for (let i = 1; i <= 200; i++) workCalendar(null, "Asia/Qatar", at("2030-01-01") + i * DAY_MS);
    const again = workCalendar(null, "Asia/Qatar", at("2030-01-01"));
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });

  it("a stored weekend of more than three days is ignored for the zone's own, and the calendar still returns", () => {
    // build() trusts stored settings; a 7-day weekend once made the Saturday → Sunday walk for a day in lieu endless.
    const all = workCalendar(settings({ weekend: [0, 1, 2, 3, 4, 5, 6] }), "Asia/Riyadh", at("2028-08-25"));
    expect(all.weekend).toEqual([5, 6]);
    expect(all.quiet["2028-09-24"]?.name?.en).toBe("Day in lieu of National Day"); // Saturday 23 Sep → Sunday
    expect(workCalendar(settings({ weekend: [4, 5, 6, 0] }), "Asia/Dubai", at("2028-08-25")).weekend).toEqual([6, 0]);
  });

  it("countryOf names each zone's country, and every country cites its source", () => {
    expect(ZONE_IDS.map(countryOf)).toEqual(["SA", "KW", "QA", "BH", "AE", "OM"]);
    for (const c of Object.values(COUNTRY_CAL)) expect(c.source.length).toBeGreaterThan(40);
  });
});

describe("rule 473: other official holidays and the days given in lieu", () => {
  it("QA: 2027-02-09, the second Tuesday of February, is National Sport Day", () => {
    expect(calFor("Asia/Qatar", "2027-02-09").quiet["2027-02-09"]).toEqual({ kind: "holiday", name: { ar: "اليوم الرياضي للدولة", en: "National Sport Day" } });
    expect(calFor("Asia/Qatar", "2027-02-09").quiet["2027-02-02"]).toBeUndefined();
  });

  it("KW: 2026-08-25 (12 Rabi al-Awwal 1448) is quiet", () => {
    expect(calFor("Asia/Kuwait", "2026-08-25").quiet["2026-08-25"]?.kind).toBe("holiday");
  });

  it("SA: National Day on Saturday 2028-09-23 makes Sunday 09-24 quiet; on Friday 2022-09-23 it makes Thursday 09-22 quiet", () => {
    const sat = calFor("Asia/Riyadh", "2028-09-24");
    expect(sat.quiet["2028-09-24"]).toEqual({ kind: "holiday", name: { ar: "بدل اليوم الوطني", en: "Day in lieu of National Day" } });
    expect(sat.quiet["2028-09-21"]).toBeUndefined();
    const fri = calFor("Asia/Riyadh", "2022-09-22");
    expect(fri.quiet["2022-09-22"]?.name?.en).toBe("Day in lieu of National Day");
    expect(fri.quiet["2022-09-25"]).toBeUndefined();
  });

  it("BH: a holiday on a Friday earns a day, one on a Saturday does not (Cabinet Resolution 1/2013 art. 2, private sector)", () => {
    // The brief expected 2023-12-18 here (National Day on Saturday 16 Dec). Bahrain's private-sector rule compensates a
    // Friday or another official holiday only; the Monday in 2023 was the government's circular, not the private sector's.
    expect(calFor("Asia/Bahrain", "2023-12-18").quiet["2023-12-17"]?.name?.en).toBe("National Day");
    expect(calFor("Asia/Bahrain", "2023-12-18").quiet["2023-12-18"]).toBeUndefined();
    // 2022: 16 Dec is a Friday, so the next working day after the two days, Sunday 18 Dec, is given in lieu.
    expect(calFor("Asia/Bahrain", "2022-12-18").quiet["2022-12-18"]?.name?.en).toBe("Day in lieu of National Day");
  });

  it("AE: a National Day on Saturday and Sunday (2028-12-02/03) adds no day", () => {
    const cal = calFor("Asia/Dubai", "2028-12-02");
    expect(quietBetween(cal, "2028-11-28", "2028-12-08")).toEqual([]);
  });

  it("OM 2026: the announced 25-26 Nov are quiet and the decree's 20 Nov is not; in 2027 the decree's Saturday-Sunday National Day earns Monday", () => {
    const y26 = calFor("Asia/Muscat", "2026-11-20");
    expect(y26.quiet["2026-11-25"]?.name?.en).toBe("National Day");
    expect(y26.quiet["2026-11-26"]?.name?.en).toBe("National Day");
    expect(y26.quiet["2026-11-20"]).toBeUndefined();
    expect(y26.quiet["2026-11-22"]).toBeUndefined();
    // RD 88/2022 as amended by RD 15/2025: 20-21 Nov; one or both on the weekend earn one day.
    const y27 = calFor("Asia/Muscat", "2027-11-21");
    expect(quietBetween(y27, "2027-11-18", "2027-11-25")).toEqual(["2027-11-21", "2027-11-22"]);
    expect(y27.quiet["2027-11-22"]?.name?.en).toBe("Day in lieu of National Day");
  });

  it("an added 'YYYY-MM-DD' day is quiet that year only; an added 'MM-DD' day every year", () => {
    const cal = settings({ holidays: { add: ["2026-12-31", "12-30"], remove: [] } });
    const dubai = workCalendar(cal, "Asia/Dubai", at("2026-12-01"));
    expect(dubai.quiet["2026-12-31"]).toEqual({ kind: "added" });
    expect(dubai.quiet["2027-12-31"]).toBeUndefined(); // a Friday, a working day in the UAE
    expect(dubai.quiet["2026-12-30"]).toEqual({ kind: "added" });
    expect(dubai.quiet["2027-12-30"]).toEqual({ kind: "added" });
  });

  it("an added 'H-09-25' day is quiet every year: 25 Ramadan 1448 (2027-03-04) and 1449 (2028-02-21)", () => {
    const cal = workCalendar(settings({ holidays: { add: ["H-09-25"], remove: [] } }), "Asia/Riyadh", at("2027-02-20"));
    expect(cal.quiet["2027-03-04"]).toEqual({ kind: "added" });
    expect(cal.quiet["2028-02-21"]).toEqual({ kind: "added" });
    expect(cal.quiet["2027-03-03"]).toBeUndefined();
  });

  it("removing a default day makes it not quiet, and takes its day in lieu with it", () => {
    const now = at("2026-10-02");
    expect(workCalendar(null, "Asia/Riyadh", now).quiet["2027-09-23"]?.name?.en).toBe("National Day");
    const off = settings({ holidays: { add: [], remove: ["09-23", "2027-03-11"] } });
    const cal = workCalendar(off, "Asia/Riyadh", now);
    expect(cal.quiet["2027-09-23"]).toBeUndefined();
    expect(cal.quiet["2027-03-11"]).toBeUndefined();
    expect(cal.quiet["2027-03-10"]?.kind).toBe("eid_fitr");
    expect(workCalendar(off, "Asia/Riyadh", at("2028-08-25")).quiet["2028-09-24"]).toBeUndefined();
  });

  it("removing one Eid day does not also cost the day in lieu: a removed day is never where a day in lieu lands", () => {
    // Eid al-Adha 1448 in Riyadh: Sat 15 (Arafah, weekend) to Tue 18 May 2027; the Saturday earns Wednesday 19.
    const cal = workCalendar(settings({ holidays: { add: [], remove: ["2027-05-18"] } }), "Asia/Riyadh", at("2027-04-19"));
    expect(quietBetween(cal, "2027-05-13", "2027-05-23")).toEqual(["2027-05-16", "2027-05-17", "2027-05-19"]);
    expect(cal.quiet["2027-05-19"]?.name?.en).toBe("Day in lieu of Eid al-Adha holiday");
    // The Friday rule's Thursday: National Day on Friday 2022-09-23 with Thursday 22 removed goes after the weekend, Sunday 25.
    const fri = workCalendar(settings({ holidays: { add: [], remove: ["2022-09-22"] } }), "Asia/Riyadh", at("2022-08-24"));
    expect(fri.quiet["2022-09-22"]).toBeUndefined();
    expect(fri.quiet["2022-09-25"]?.name?.en).toBe("Day in lieu of National Day");
  });

  it("upcomingQuiet lists the next 365 days' quiet days in order with their names, and the next Ramadan", () => {
    const now = at("2026-10-02");
    const up = upcomingQuiet(null, "Asia/Riyadh", now);
    const days = up.days.map((d) => d.day);
    expect(days).toEqual([...days].sort());
    expect(days[0] >= "2026-10-02" && days[days.length - 1] <= "2027-10-01").toBe(true);
    expect(up.days.find((d) => d.day === "2027-02-22")?.why).toEqual({ kind: "holiday", name: { ar: "يوم التأسيس", en: "Founding Day" } });
    expect(up.days.find((d) => d.day === "2027-09-23")?.why.name?.ar).toBe("اليوم الوطني");
    expect(up.days.some((d) => d.day === "2026-09-23")).toBe(false);
    expect(up.ramadan).toEqual({ start: "2027-02-08", end: "2027-03-08" });
  });
});

describe("rule 474: parseCalendar refuses what the calendar cannot hold", () => {
  const now = at("2026-10-02"); // 1448 is the current Hijri year in Riyadh, 1449 the next
  const parse = (body: Record<string, unknown>) => parseCalendar(body, now, "Asia/Riyadh", "admin@example.com");
  const error = (body: Record<string, unknown>) => { const r = parse(body); return r.ok ? "ok" : r.error; };

  it("a weekend of non-contiguous days or of more than three days is weekend_invalid", () => {
    expect(error({ weekend: [5, 1] })).toBe("weekend_invalid");
    expect(error({ weekend: [0, 1, 2, 3] })).toBe("weekend_invalid");
    expect(error({ weekend: [5, 5] })).toBe("weekend_invalid");
    expect(error({ weekend: [7] })).toBe("weekend_invalid");
    expect(error({ weekend: "5,6" })).toBe("weekend_invalid");
    expect(error({ weekend: [4, 5, 6] })).toBe("ok");
    expect(error({ weekend: [] })).toBe("ok");
  });

  it("three Ramadan windows, a time off the 15-minute step, from not before to, or overlapping windows are ramadan_hours_invalid", () => {
    const w = (from: string, to: string) => ({ from, to });
    expect(error({ ramadanHours: [w("09:00", "10:00"), w("11:00", "12:00"), w("13:00", "14:00")] })).toBe("ramadan_hours_invalid");
    expect(error({ ramadanHours: [w("10:10", "15:00")] })).toBe("ramadan_hours_invalid");
    expect(error({ ramadanHours: [w("15:00", "15:00")] })).toBe("ramadan_hours_invalid");
    expect(error({ ramadanHours: [w("16:00", "15:00")] })).toBe("ramadan_hours_invalid");
    expect(error({ ramadanHours: [w("10:00", "15:00"), w("14:30", "16:00")] })).toBe("ramadan_hours_invalid");
    // Task 2's pure functions trust these strings: "" would read as midnight, "24:00" is not a time of day.
    expect(error({ ramadanHours: [w("", "15:00")] })).toBe("ramadan_hours_invalid");
    expect(error({ ramadanHours: [w("10:00", "24:00")] })).toBe("ramadan_hours_invalid");
    expect(error({ ramadanHours: [w("9:00", "15:00")] })).toBe("ramadan_hours_invalid");
    expect(error({ ramadanHours: [{ from: "10:00", to: "15:00", note: "x" }] })).toBe("ramadan_hours_invalid");
  });

  it("[] as Ramadan hours is accepted (no restriction), and two touching windows are sorted", () => {
    const empty = parse({ ramadanHours: [] });
    expect(empty.ok && empty.cal.ramadanHours).toEqual([]);
    const two = parse({ ramadanHours: [{ from: "21:30", to: "23:45" }, { from: "10:00", to: "15:00" }] });
    expect(two.ok && two.cal.ramadanHours).toEqual([{ from: "10:00", to: "15:00" }, { from: "21:30", to: "23:45" }]);
    expect(error({ ramadanHours: [{ from: "10:00", to: "15:00" }, { from: "15:00", to: "16:00" }] })).toBe("ok");
  });

  it("a hijriFix year after the next Hijri year is bad_year; a past year is dropped, not refused (ruling R8)", () => {
    expect(error({ hijriFix: { "1460": { shawwal1: "2038-12-01" } } })).toBe("bad_year");
    expect(error({ hijriFix: { "1450": { shawwal1: "2029-02-14" } } })).toBe("bad_year");
    expect(error({ hijriFix: { abc: {} } })).toBe("bad_year");
    const past = parse({ hijriFix: { "1447": { shawwal1: "2026-03-20" } } });
    expect(past.ok && past.cal.hijriFix).toEqual({});
  });

  it("a hijriFix date 2 days from the computed one is hijri_fix_range; one day either way is accepted", () => {
    // Umm al-Qura: 1 Shawwal 1448 is 2027-03-09.
    expect(error({ hijriFix: { "1448": { shawwal1: "2027-03-11" } } })).toBe("hijri_fix_range");
    expect(error({ hijriFix: { "1448": { shawwal1: "2027-03-07" } } })).toBe("hijri_fix_range");
    expect(error({ hijriFix: { "1448": { shawwal1: "not a date" } } })).toBe("hijri_fix_range");
    expect(error({ hijriFix: { "1448": { shawwal1: "2027-03-08" } } })).toBe("ok");
    expect(error({ hijriFix: { "1448": { shawwal1: "2027-03-10", dhulhijja1: "2027-05-08" } } })).toBe("ok");
    expect(error({ hijriFix: { "1449": { ramadan1: "2028-01-27" } } })).toBe("ok");
    expect(error({ hijriFix: { "1448": { muharram1: "2026-06-16" } } })).toBe("bad_request");
  });

  it("31 entries in add, a malformed value, or a removal the defaults do not produce is holidays_invalid", () => {
    const many = Array.from({ length: 31 }, (_, i) => `2027-01-${String(i + 1).padStart(2, "0")}`);
    expect(error({ holidays: { add: many, remove: [] } })).toBe("holidays_invalid");
    expect(error({ holidays: { add: many.slice(0, 30), remove: [] } })).toBe("ok");
    expect(error({ holidays: { add: ["2027-02-30"] } })).toBe("holidays_invalid");
    expect(error({ holidays: { add: ["H-13-01"] } })).toBe("holidays_invalid");
    expect(error({ holidays: { add: ["13-01"] } })).toBe("holidays_invalid");
    expect(error({ holidays: { add: [42] } })).toBe("holidays_invalid");
    expect(error({ holidays: { add: [], remove: ["2027-03-15"] } })).toBe("holidays_invalid");
    expect(error({ holidays: { add: [], remove: ["09-23", "2027-03-11", "H-10-02"] } })).toBe("ok");
    expect(error({ holidays: { add: [], other: [] } })).toBe("holidays_invalid");
  });

  it("settings saved back unchanged after their values went stale still save, the stale values dropped (ruling R8)", () => {
    const saved = parse({ hijriFix: { "1448": { shawwal1: "2027-03-10" } }, holidays: { add: ["2026-10-20", "H-1448-04-20", "12-31", "2027-12-30"], remove: ["2026-09-23", "09-23"] } });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.cal.holidays.add).toEqual(["2026-10-20", "H-1448-04-20", "12-31", "2027-12-30"]);
    // 2027-07-01 is 26 Muharram 1449 in Riyadh: 1448 is past, and the window starts 2027-06-17 (12 Muharram 1449).
    const later = at("2027-07-01");
    const again = parseCalendar({ ...saved.cal, weekend: [5] }, later, "Asia/Riyadh", "admin@example.com");
    expect(again).toEqual({
      ok: true,
      cal: { v: 1, weekend: [5], ramadanHours: null, hijriFix: {}, holidays: { add: ["12-31", "2027-12-30"], remove: ["09-23"] }, updatedAt: "2027-07-01T09:00:00.000Z", updatedBy: "admin@example.com" },
    });
    // A year after next is still refused then: 1449 is current, 1450 next.
    const far = parseCalendar({ hijriFix: { "1451": { shawwal1: "2030-02-05" } } }, later, "Asia/Riyadh", "admin@example.com");
    expect(!far.ok && far.error).toBe("bad_year");
  });

  it("the calendar ignores a past year's hijriFix too: 25 Dhu al-Hijjah 1448 stays on Umm al-Qura's 2027-05-31", () => {
    // Umm al-Qura: 1 Dhu al-Hijjah 1448 is 2027-05-07. A stored fix moving it to 05-08 would put 25 Dhu al-Hijjah on 06-01;
    // on 2027-06-10 (5 Muharram 1449) that fix belongs to a past year and no longer applies.
    const stored = settings({ hijriFix: { "1448": { dhulhijja1: "2027-05-08" } }, holidays: { add: ["H-12-25"], remove: [] } });
    const cal = workCalendar(stored, "Asia/Riyadh", at("2027-06-10"));
    expect(cal.quiet["2027-05-31"]).toEqual({ kind: "added" });
    expect(cal.quiet["2027-06-01"]).toBeUndefined();
  });

  it("an unknown top-level field is bad_request", () => {
    const r = parse({ weekend: [5, 6], timezone: "Asia/Dubai" });
    expect(r).toEqual({ ok: false, error: "bad_request", status: 400, field: "timezone" });
    expect(error({ v: 2 })).toBe("bad_request");
  });

  it("an accepted body is normalised and stamped with the time and the admin's login", () => {
    const r = parse({ v: 1, weekend: [0, 6], hijriFix: { "1448": { shawwal1: "2027-03-10" } }, holidays: { add: ["2026-12-31", "2026-12-31"], remove: ["09-23"] } });
    expect(r).toEqual({
      ok: true,
      cal: { v: 1, weekend: [6, 0], ramadanHours: null, hijriFix: { "1448": { shawwal1: "2027-03-10" } }, holidays: { add: ["2026-12-31"], remove: ["09-23"] }, updatedAt: "2026-10-02T09:00:00.000Z", updatedBy: "admin@example.com" },
    });
    expect(parse({})).toEqual({ ok: true, cal: { v: 1, weekend: null, ramadanHours: null, hijriFix: {}, holidays: { add: [], remove: [] }, updatedAt: "2026-10-02T09:00:00.000Z", updatedBy: "admin@example.com" } });
    const fail = parse({ weekend: [5, 1] });
    expect(fail).toEqual({ ok: false, error: "weekend_invalid", status: 400, field: "weekend" });
  });
});
