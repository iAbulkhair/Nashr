import { afterEach, describe, expect, it, vi } from "vitest";
import { activeSeasons, hijriDate } from "@/lib/seasons";
import { buildWrap, eveningAt, isRamadan, previousEveningAt, wrapText, zonesDue, type Wrap } from "@/lib/secretary-evening";
import {
  addDays, addWorkingDays, briefAgenda, chaseAt, chaseMoment, classify, computeAgenda, defaultCal, firstWorkingMoment, inRamadanWindow, isQuietDay, nextStepText, nowLine,
  outsideRamadanHours, overdueAlerts, partyKey, workingDaysBetween, type AwayMap, type CalData, type SecItem,
} from "@/lib/secretary-agenda";
import { SEC_KEYS, agendaFor, backFingerprint, cleanLine, createItem, nextWeekStart, overdueAlertFingerprint, snoozePreset } from "@/lib/secretary";
import { runTool } from "@/lib/chat";
import { db } from "@/lib/db";
import { type User } from "@/lib/auth";
import { followUps, type Notif } from "@/lib/notifications";
import { runDaily } from "@/lib/schedule";
import { saveBrand, type Brand } from "@/lib/brand";
import { json, newUser, signIn } from "./helpers/session";
import * as listRoute from "@/app/api/secretary/route";
import { COUNTRY_CAL, countryOf, parseCalendar, upcomingQuiet, workCalendar, type SecCalendar } from "@/lib/secretary-calendar";
import { ZONE_IDS, isWeekend, weekStart, weekStartDay, zoneOf, type Zone } from "@/lib/zones";

/**
 * Rules 470-489 in docs/system/tests.md: Reem phase 3 A1 (the brand's work calendar and away contacts, spec
 * docs/superpowers/specs/2026-10-02-secretary-reem-phase3a-design.md). Rule 470 first: Hijri dates are read in the
 * brand's zone, because the calendar day flips at the brand's midnight and not at the server's. Rule 471: the pure
 * calendar primitives (working days, week start, Ramadan windows) that read the brand's `CalData`. Rules 472-474: the
 * server's `workCalendar`, which builds that `CalData` from the country's private-sector holidays and the brand's
 * settings, and `parseCalendar`, which checks those settings. Rules 475-477: `chaseMoment`, the one rule for when the
 * owner may chase someone, and the agenda that reads it. Rules 479-480: the alerts, the morning brief and the evening
 * wrap that read it. Every Hijri date and weekday below was checked against ICU Umm al-Qura in Riyadh before it was
 * written down.
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

  it("removing one Eid day does not also cost the day in lieu: a removed holiday day is never where a day in lieu lands", () => {
    // Eid al-Adha 1448 in Riyadh: Sat 15 (Arafah, weekend) to Tue 18 May 2027; the Saturday earns Wednesday 19.
    const cal = workCalendar(settings({ holidays: { add: [], remove: ["2027-05-18"] } }), "Asia/Riyadh", at("2027-04-19"));
    expect(quietBetween(cal, "2027-05-13", "2027-05-23")).toEqual(["2027-05-16", "2027-05-17", "2027-05-19"]);
    expect(cal.quiet["2027-05-19"]?.name?.en).toBe("Day in lieu of Eid al-Adha holiday");
  });

  it("removing the day in lieu itself drops it: it does not move to another day", () => {
    const quiet = (remove: string[]) => quietBetween(workCalendar(settings({ holidays: { add: [], remove } }), "Asia/Riyadh", at("2027-04-19")), "2027-05-13", "2027-05-27");
    expect(quiet([])).toEqual(["2027-05-16", "2027-05-17", "2027-05-18", "2027-05-19"]);
    expect(quiet(["2027-05-19"])).toEqual(["2027-05-16", "2027-05-17", "2027-05-18"]);
    expect(quiet(["2027-05-19", "2027-05-20"])).toEqual(["2027-05-16", "2027-05-17", "2027-05-18"]);
    // The Friday rule's Thursday: National Day on Friday 2022-09-23 with its day in lieu, Thursday 22, removed.
    const fri = workCalendar(settings({ holidays: { add: [], remove: ["2022-09-22"] } }), "Asia/Riyadh", at("2022-08-24"));
    expect(fri.quiet["2022-09-22"]).toBeUndefined();
    expect(fri.quiet["2022-09-25"]).toBeUndefined();
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

// Rules 475-477: the chase rule. Every calendar below is built by hand from `defaultCal`, so each case names the quiet
// and Ramadan days it touches (ruling R1: the Ramadan cases sit on Monday 22 and Tuesday 23 February 2027, weekdays in
// Riyadh, so they test Ramadan and not the weekend).
const RIYADH = defaultCal("Asia/Riyadh");
const DUBAI = defaultCal("Asia/Dubai");
/** A local wall-clock time "YYYY-MM-DDTHH:mm" in Riyadh (UTC+3) or Dubai (UTC+4). */
const local = (s: string, z: Zone = "Asia/Riyadh") => Date.parse(`${s}:00${z === "Asia/Dubai" ? "+04:00" : "+03:00"}`);
const iso = (ms: number) => new Date(ms).toISOString();
/** Something «أحمد» owes the owner: undated unless the case dates it. */
const debt = (p: Partial<SecItem> = {}): SecItem => ({
  id: "s00000000000004a1", kind: "waiting_on", title: "Quote from the supplier", description: "", result: null, direction: "they_owe", owedBy: "أحمد", owedTo: "owner",
  dueAt: null, allDay: false, snoozeUntil: null, priority: 1, critical: false, links: {}, source: "owner", notes: [],
  createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-01T09:00:00.000Z", completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, rev: 1, ...p,
});
const FITR = { kind: "eid_fitr" as const, name: { ar: "إجازة عيد الفطر", en: "Eid al-Fitr holiday" } };
/** Saudi Eid al-Fitr 1448 by hand: Tuesday 9 to Friday 12 March 2027 (Friday and Saturday are the weekend anyway). */
const EID: CalData = { ...RIYADH, quiet: Object.fromEntries(["2027-03-09", "2027-03-10", "2027-03-11", "2027-03-12"].map((d) => [d, FITR])) };
const RAMADAN: CalData = { ...RIYADH, ramadan: ["2027-02-22", "2027-02-23"] };
/** A moment long before every case below, so `at` is the anchor. */
const EARLY = local("2026-09-01T12:00");

describe("rule 475: chaseMoment moves chasing off quiet days, out of Ramadan's off-hours and past an absence", () => {
  it("Riyadh: a chase due Friday moves to Sunday 08:00 (quiet); one due Thursday is not moved", () => {
    const sun = local("2026-10-04T08:00");
    expect(chaseMoment(debt({ dueAt: iso(local("2026-10-02T10:00")) }), EARLY, RIYADH, {})).toEqual({ anchor: sun, at: sun, why: "quiet", quiet: { kind: "weekend" } });
    const thu = local("2026-10-01T10:00");
    expect(chaseMoment(debt({ dueAt: iso(thu) }), EARLY, RIYADH, {})).toEqual({ anchor: thu, at: thu, why: "normal" });
  });

  it("Dubai: a chase due Saturday moves to Monday 09:00; one due Friday is not moved", () => {
    const mon = local("2026-10-05T09:00", "Asia/Dubai");
    expect(chaseMoment(debt({ dueAt: iso(local("2026-10-03T10:00", "Asia/Dubai")) }), EARLY, DUBAI, {})).toMatchObject({ at: mon, why: "quiet" });
    expect(chaseMoment(debt({ dueAt: iso(local("2026-10-04T10:00", "Asia/Dubai")) }), EARLY, DUBAI, {})).toMatchObject({ at: mon, why: "quiet" });
    const fri = local("2026-10-02T10:00", "Asia/Dubai");
    expect(chaseMoment(debt({ dueAt: iso(fri) }), EARLY, DUBAI, {})).toEqual({ anchor: fri, at: fri, why: "normal" });
  });

  it("away until Thursday 2026-10-08: an item owed by «أحمد » due Monday 10-05 is chased Sunday 10-11 08:00, why away", () => {
    const away: AwayMap = { "احمد": { label: "احمد", until: "2026-10-08" } };
    const it0 = debt({ owedBy: "أحمد ", dueAt: iso(local("2026-10-05T10:00")) });
    const sun = local("2026-10-11T08:00");
    expect(chaseMoment(it0, local("2026-10-05T12:00"), RIYADH, away)).toEqual({ anchor: sun, at: sun, why: "away", until: "2026-10-08" });
    // `until` is inclusive: a chase due on the last away day moves too; one due the day after does not.
    expect(chaseMoment(debt({ dueAt: iso(local("2026-10-08T10:00")) }), EARLY, RIYADH, away)).toMatchObject({ at: sun, why: "away" });
    const after = local("2026-10-11T10:00");
    expect(chaseMoment(debt({ dueAt: iso(after) }), EARLY, RIYADH, away)).toEqual({ anchor: after, at: after, why: "normal" });
    // Another contact is not away.
    const sara = local("2026-10-05T10:00");
    expect(chaseMoment(debt({ owedBy: "سارة", dueAt: iso(sara) }), EARLY, RIYADH, away)).toEqual({ anchor: sara, at: sara, why: "normal" });
    // Away until Sunday: Monday is a working day, and chasing starts at its brief time, 08:00, not at midnight (ruling R10).
    const sunAway: AwayMap = { "احمد": { label: "احمد", until: "2026-10-04" } };
    const mon = local("2026-10-05T08:00");
    expect(chaseMoment(debt({ dueAt: iso(local("2026-10-04T10:00")) }), EARLY, RIYADH, sunAway)).toEqual({ anchor: mon, at: mon, why: "away", until: "2026-10-04" });
    // Dubai's brief is at 09:00: away until Sunday 2026-10-04 (its weekend), chased Monday 09:00.
    const dubaiMon = local("2026-10-05T09:00", "Asia/Dubai");
    expect(chaseMoment(debt({ dueAt: iso(local("2026-10-01T10:00", "Asia/Dubai")) }), EARLY, DUBAI, sunAway)).toEqual({ anchor: dubaiMon, at: dubaiMon, why: "away", until: "2026-10-04" });
    // The day after the absence is a Ramadan day: its brief time is outside the hours, so the first window start, 10:00.
    const ramadanAway: AwayMap = { "احمد": { label: "احمد", until: "2027-02-21" } };
    const monday = local("2027-02-22T10:00");
    expect(chaseMoment(debt({ dueAt: iso(local("2027-02-21T11:00")) }), EARLY, RAMADAN, ramadanAway)).toEqual({ anchor: monday, at: monday, why: "away", until: "2027-02-21" });
  });

  it("a label that names an Object property is just a label: no away entry, no crash", () => {
    const due = local("2026-10-05T10:00");
    for (const owedBy of ["constructor", "__proto__", "toString"]) {
      expect(chaseMoment(debt({ owedBy, dueAt: iso(due) }), EARLY, RIYADH, {})).toEqual({ anchor: due, at: due, why: "normal" });
    }
  });

  it("malformed data moves nothing and throws nothing: an away day that is not a date, a due date that is not one", () => {
    const due = local("2026-10-05T10:00");
    for (const until of ["soon", "2026-13-45", ""]) {
      expect(chaseMoment(debt({ dueAt: iso(due) }), EARLY, RIYADH, { "احمد": { label: "أحمد", until } }), until).toEqual({ anchor: due, at: due, why: "normal" });
    }
    const bad = chaseMoment(debt({ dueAt: "not a date" }), EARLY, RIYADH, {});
    expect(Number.isNaN(bad?.at)).toBe(true);
    expect(classify(debt({ dueAt: "not a date" }), EARLY, "Asia/Riyadh")?.bucket).toBe("waiting");
  });

  it("Eid: with SA quiet days 2027-03-09 to 12, an item due 03-10 moves past the last Eid day to Sunday 03-14 08:00", () => {
    const sun = local("2027-03-14T08:00");
    expect(chaseMoment(debt({ dueAt: iso(local("2027-03-10T10:00")) }), EARLY, EID, {})).toEqual({ anchor: sun, at: sun, why: "quiet", quiet: FITR });
  });

  it("a follow-up recorded Monday 2027-03-08, the day before Eid: the re-chase is the 2nd working day after Eid, 03-15, at the follow-up's time", () => {
    const it0 = debt({ dueAt: iso(local("2027-03-07T10:00")), lastChasedAt: iso(local("2027-03-08T11:00")) });
    expect(chaseAt(it0, "Asia/Riyadh", EID)).toBe(local("2027-03-15T11:00"));
    expect(chaseMoment(it0, local("2027-03-08T12:00"), EID, {})).toEqual({ anchor: local("2027-03-15T11:00"), at: local("2027-03-15T11:00"), why: "normal" });
    // Without the calendar only the weekend is skipped: Wednesday, an Eid day.
    expect(chaseAt(it0, "Asia/Riyadh")).toBe(local("2027-03-10T11:00"));
  });

  it("Ramadan: due Monday 2027-02-22 20:00 is chased Tuesday 10:00; with a second window 21:30-23:30, the same evening at 21:30", () => {
    const it0 = debt({ dueAt: iso(local("2027-02-22T20:00")) });
    expect(chaseMoment(it0, EARLY, RAMADAN, {})).toEqual({ anchor: local("2027-02-23T10:00"), at: local("2027-02-23T10:00"), why: "ramadan" });
    const two = { ...RAMADAN, ramadanHours: [{ from: "10:00", to: "15:00" }, { from: "21:30", to: "23:30" }] };
    expect(chaseMoment(it0, EARLY, two, {})).toEqual({ anchor: local("2027-02-22T21:30"), at: local("2027-02-22T21:30"), why: "ramadan" });
    // Ramadan hours of [] are no restriction.
    expect(chaseMoment(it0, EARLY, { ...RAMADAN, ramadanHours: [] }, {})).toMatchObject({ at: local("2027-02-22T20:00"), why: "normal" });
  });

  it("review focus 4: in Ramadan a moment exactly at 15:00 moves and one exactly at 10:00 does not; one at briefAt on a working day stays", () => {
    expect(chaseMoment(debt({ dueAt: iso(local("2027-02-22T15:00")) }), EARLY, RAMADAN, {})).toMatchObject({ at: local("2027-02-23T10:00"), why: "ramadan" });
    expect(chaseMoment(debt({ dueAt: iso(local("2027-02-22T14:59")) }), EARLY, RAMADAN, {})).toMatchObject({ at: local("2027-02-22T14:59"), why: "normal" });
    expect(chaseMoment(debt({ dueAt: iso(local("2027-02-22T10:00")) }), EARLY, RAMADAN, {})).toMatchObject({ at: local("2027-02-22T10:00"), why: "normal" });
    expect(chaseMoment(debt({ dueAt: iso(local("2026-10-04T08:00")) }), EARLY, RIYADH, {})).toMatchObject({ at: local("2026-10-04T08:00"), why: "normal" });
  });

  it("several moves: why is the last one's reason (ruling R5), except that away wins once applied", () => {
    // Friday 19 Feb (weekend) → Sunday 08:00 → Sunday is a Ramadan day: 10:00. The last move is Ramadan's.
    const cal = { ...RIYADH, ramadan: ["2027-02-19", "2027-02-21"] };
    expect(chaseMoment(debt({ dueAt: iso(local("2027-02-19T11:00")) }), EARLY, cal, {})).toEqual({ anchor: local("2027-02-21T10:00"), at: local("2027-02-21T10:00"), why: "ramadan" });
    // Thursday 18 Feb 16:00, after the window → Friday 08:00 (Ramadan's move) → the weekend → Sunday 08:00, not a Ramadan day here.
    const thu = { ...RIYADH, ramadan: ["2027-02-18"] };
    expect(chaseMoment(debt({ dueAt: iso(local("2027-02-18T16:00")) }), EARLY, thu, {})).toEqual({ anchor: local("2027-02-21T08:00"), at: local("2027-02-21T08:00"), why: "quiet", quiet: { kind: "weekend" } });
    // Away until Thursday, then the weekend, then Sunday's Ramadan hours: still "away".
    const away: AwayMap = { "احمد": { label: "أحمد", until: "2027-02-18" } };
    expect(chaseMoment(debt({ dueAt: iso(local("2027-02-17T11:00")) }), EARLY, cal, away)).toEqual({ anchor: local("2027-02-21T10:00"), at: local("2027-02-21T10:00"), why: "away", until: "2027-02-18" });
  });

  it("a weekend run that holds a named holiday is explained by the holiday", () => {
    // Friday and Saturday, then a holiday on Sunday: the line names the holiday, not the weekend.
    const cal = { ...RIYADH, quiet: { "2026-10-04": { kind: "holiday" as const, name: { ar: "يوم التأسيس", en: "Founding Day" } } } };
    expect(chaseMoment(debt({ dueAt: iso(local("2026-10-02T10:00")) }), EARLY, cal, {})).toEqual({
      anchor: local("2026-10-05T08:00"), at: local("2026-10-05T08:00"), why: "quiet", quiet: { kind: "holiday", name: { ar: "يوم التأسيس", en: "Founding Day" } },
    });
  });

  it("an item owed by an agent is never moved, and the owner's own item has no chase moment", () => {
    const fri = local("2026-10-02T10:00");
    const dana = debt({ owedBy: "dana", dueAt: iso(fri) });
    expect(chaseMoment(dana, EARLY, RIYADH, {})).toEqual({ anchor: fri, at: fri, why: "normal" });
    // Not even when it is read on the Friday itself.
    expect(chaseMoment(dana, local("2026-10-02T12:00"), RIYADH, { dana: { label: "dana", until: "2026-10-30" } })).toEqual({ anchor: fri, at: fri, why: "normal" });
    expect(chaseMoment(debt({ owedBy: "owner", direction: "i_owe", dueAt: iso(fri) }), EARLY, RIYADH, {})).toBeNull();
  });

  it("outsideRamadanHours is false on every day that is not a Ramadan day, and on a Ramadan day outside the windows only", () => {
    expect(outsideRamadanHours(local("2027-02-22T20:00"), RIYADH)).toBe(false);
    expect(outsideRamadanHours(local("2027-02-22T20:00"), RAMADAN)).toBe(true);
    expect(outsideRamadanHours(local("2027-02-22T12:00"), RAMADAN)).toBe(false);
    expect(outsideRamadanHours(local("2027-02-22T20:00"), { ...RAMADAN, ramadanHours: [] })).toBe(false);
  });

  it("partyKey folds the ways one Arabic name is written, and drops what cannot be seen", () => {
    for (const s of ["أحمد", "احمد", "إحمد", "آحمد", "ٱحمد", "أحمد ", "  أحمد\t", "أح\u00ADمد", "أَحْمَد", "أحـــمد", "\u200Bأحمد\u200F", "أحم\u200Dد", "أ\uFE00حمد"]) {
      expect(partyKey(s), JSON.stringify(s)).toBe("احمد");
    }
    expect(partyKey("فاطمة")).toBe("فاطمه");
    expect(partyKey("مصطفى")).toBe("مصطفي");
    expect(partyKey("ＤＡＮＡ")).toBe("dana");
    expect(partyKey("Dana   Smith")).toBe("dana smith");
    expect(partyKey("Ahmad")).not.toBe(partyKey("أحمد"));
    expect(partyKey("\u3164")).toBe("");
  });

  it("partyKey is null past 80 characters of key, and cleans at least what party() cleans (ruling R2)", () => {
    expect(partyKey("a".repeat(80))).toBe("a".repeat(80));
    expect(partyKey("a".repeat(81))).toBeNull();
    // Characters that leave the key do not count toward its length.
    expect(partyKey(`${"a".repeat(80)}\u00AD\u00AD `)).toBe("a".repeat(80));
    for (const s of ["  أحمد\t\n", "a\u0000b", "x\u202Ey", "p\u2028q", "\uFEFFsara  ali\r\n"]) expect(partyKey(s), JSON.stringify(s)).toBe(partyKey(cleanLine(s)));
  });
});

describe("rule 476: a debt that is already chaseable waits on quiet days and outside Ramadan hours", () => {
  it("a chase due Wednesday 2027-03-03, read Friday 03-05 12:00 in Riyadh: waiting until Sunday 08:00, why quiet", () => {
    const it0 = debt({ dueAt: iso(local("2027-03-03T10:00")) });
    const c = classify(it0, local("2027-03-05T12:00"), "Asia/Riyadh");
    expect(c).toMatchObject({ bucket: "waiting", next: "wait", actionOwner: "أحمد" });
    expect(c?.moment).toEqual({ anchor: local("2027-03-03T10:00"), at: local("2027-03-07T08:00"), why: "quiet", quiet: { kind: "weekend" } });
    // Sunday, after the brief: a chase again (overdue, its due date long past).
    expect(classify(it0, local("2027-03-07T08:00"), "Asia/Riyadh")).toMatchObject({ bucket: "overdue", next: "chase", moment: { at: local("2027-03-03T10:00"), why: "normal" } });
    expect(classify(it0, local("2027-03-07T07:59"), "Asia/Riyadh")).toMatchObject({ bucket: "overdue", next: "chase" });
  });

  it("Ramadan: waiting at 21:00 until 10:00 the next day, a chase at 11:00", () => {
    const it0 = debt({ expectBy: iso(local("2027-02-22T11:00")) });
    const anchor = local("2027-02-22T11:00");
    const night = computeAgenda([it0], local("2027-02-22T21:00"), { zone: "Asia/Riyadh", cal: RAMADAN });
    expect(night.counts).toMatchObject({ waiting: 1, chase: 0 });
    expect(night.buckets.waiting[0].moment).toEqual({ anchor, at: local("2027-02-23T10:00"), why: "ramadan" });
    expect(computeAgenda([it0], local("2027-02-23T09:59"), { cal: RAMADAN }).counts.waiting).toBe(1);
    const day = computeAgenda([it0], local("2027-02-23T11:00"), { cal: RAMADAN });
    expect(day.counts).toMatchObject({ waiting: 0, chase: 1 });
    expect(day.buckets.chase[0]).toMatchObject({ next: "chase", moment: { anchor, at: anchor, why: "normal" } });
  });

  it("an item already in chase the day before Eid is waiting on every Eid day, then a chase again on Sunday 03-14", () => {
    const eve = debt({ expectBy: iso(local("2027-03-07T10:00")) });
    const bucketAt = (t: string) => computeAgenda([eve], local(t), { cal: EID }).buckets;
    expect(bucketAt("2027-03-08T12:00").chase).toHaveLength(1);
    for (const d of ["2027-03-09", "2027-03-10", "2027-03-11", "2027-03-12", "2027-03-13"]) {
      const b = bucketAt(`${d}T12:00`);
      expect(b.waiting, d).toHaveLength(1);
      expect(b.waiting[0].moment, d).toMatchObject({ at: local("2027-03-14T08:00"), why: "quiet" });
    }
    expect(bucketAt("2027-03-14T08:00").chase).toHaveLength(1);
  });

  it("an owner item due on an Eid day is still overdue at Eid noon, with no chase moment", () => {
    const mine = debt({ direction: "i_owe", owedBy: "owner", owedTo: null, dueAt: iso(local("2027-03-10T09:00")) });
    const c = classify(mine, local("2027-03-10T12:00"), "Asia/Riyadh", { cal: EID });
    expect(c).toEqual({ bucket: "overdue", reason: "overdue", actionOwner: "owner", next: "do" });
    expect(computeAgenda([mine], local("2027-03-10T12:00"), { cal: EID }).buckets.overdue[0].moment).toBeUndefined();
  });

  it("without a calendar the agenda keeps the zone's own weekend: a Dubai Sunday pauses, a Riyadh Sunday does not", () => {
    const it0 = debt({ dueAt: iso(local("2026-10-01T10:00")) });
    const sunNoon = Date.parse("2026-10-04T09:00:00Z"); // 12:00 in Riyadh, 13:00 in Dubai
    expect(computeAgenda([it0], sunNoon, { zone: "Asia/Riyadh" }).counts.overdue).toBe(1);
    expect(computeAgenda([it0], sunNoon, { zone: "Asia/Dubai" }).buckets.waiting[0].moment).toMatchObject({ at: local("2026-10-05T09:00", "Asia/Dubai"), why: "quiet" });
    // A calendar passed without a zone brings its own.
    expect(computeAgenda([it0], sunNoon, { cal: DUBAI }).zone).toBe("Asia/Dubai");
  });
});

describe("rule 477: next stays a string, and the reason line is shown", () => {
  const away: AwayMap = { [partyKey("أحمد")!]: { label: "أحمد", until: "2026-10-08" } };
  const it0 = debt({ dueAt: iso(local("2026-10-05T10:00")) });
  const now = local("2026-10-05T12:00");

  it("an away item is waiting, its next step the string \"wait\", and its line says until when, in Latin digits", () => {
    const c = classify(it0, now, "Asia/Riyadh", { cal: RIYADH, away });
    expect(c?.next).toBe("wait");
    expect(typeof c?.next).toBe("string");
    const e = { item: it0, next: c!.next, moment: c!.moment };
    expect(nextStepText(e, "ar")).toBe("بانتظار أحمد · أحمد: غياب لين الخميس 8 أكتوبر");
    expect(nextStepText(e, "ar")).toContain("غياب لين");
    expect(nextStepText(e, "ar")).not.toMatch(/[٠-٩]/);
    expect(nextStepText(e, "en")).toBe("Waiting on أحمد · أحمد: away until Thursday, October 8");
    // Agents read contact names as JSON-quoted data.
    expect(nextStepText(e, "en", "Asia/Riyadh", { quote: true })).toBe('Waiting on "أحمد" · "أحمد": away until Thursday, October 8');
    // The year is named when it is not the current one.
    expect(nextStepText({ ...e, moment: { ...e.moment!, until: "2027-01-07" } }, "en", "Asia/Riyadh", { now })).toBe("Waiting on أحمد · أحمد: away until Thursday, January 7, 2027");
  });

  it("on an Eid day a quiet item's line names «إجازة عيد الفطر»; a weekend one names the weekend; a day the owner added is a public holiday", () => {
    const eid = debt({ dueAt: iso(local("2027-03-10T10:00")) });
    const e = computeAgenda([eid], local("2027-03-10T12:00"), { cal: EID }).buckets.waiting[0];
    expect(nextStepText(e, "ar")).toBe("بانتظار أحمد · المتابعة الأحد 14 مارس — إجازة عيد الفطر");
    expect(nextStepText(e, "en")).toBe("Waiting on أحمد · Follow up Sunday, March 14, Eid al-Fitr holiday");
    // Already chaseable before Eid and paused today: the line names today's reason.
    const eve = computeAgenda([debt({ expectBy: iso(local("2027-03-07T10:00")) })], local("2027-03-10T12:00"), { cal: EID }).buckets.waiting[0];
    expect(nextStepText(eve, "ar")).toContain("إجازة عيد الفطر");
    const fri = computeAgenda([debt({ dueAt: iso(local("2026-10-02T10:00")) })], local("2026-10-01T12:00")).buckets.waiting[0];
    expect(nextStepText(fri, "ar")).toBe("بانتظار أحمد · المتابعة الأحد 4 أكتوبر — عطلة نهاية الأسبوع");
    expect(nextStepText(fri, "en")).toBe("Waiting on أحمد · Follow up Sunday, October 4, the weekend");
    const added = { ...RIYADH, quiet: { "2026-10-05": { kind: "added" as const } } };
    const mon = computeAgenda([debt({ dueAt: iso(local("2026-10-05T10:00")) })], local("2026-10-01T12:00"), { cal: added }).buckets.waiting[0];
    expect(nextStepText(mon, "ar")).toBe("بانتظار أحمد · المتابعة الثلاثاء 6 أكتوبر — إجازة رسمية");
    expect(nextStepText(mon, "en")).toBe("Waiting on أحمد · Follow up Tuesday, October 6, a public holiday");
  });

  it("Ramadan's line gives the time, and the day when it is not today", () => {
    const it1 = debt({ expectBy: iso(local("2027-02-22T11:00")) });
    const e = computeAgenda([it1], local("2027-02-22T21:00"), { cal: RAMADAN }).buckets.waiting[0];
    expect(nextStepText(e, "ar")).toBe("بانتظار أحمد · تابعه بعد 10:00 (ساعات رمضان)");
    expect(nextStepText(e, "en")).toBe("Waiting on أحمد · Follow up after 10:00 (Ramadan hours)");
    expect(nextStepText(e, "en", "Asia/Riyadh", { now: local("2027-02-22T21:00") })).toBe("Waiting on أحمد · Follow up after 10:00 on Tuesday, February 23 (Ramadan hours)");
    expect(nextStepText(e, "ar", "Asia/Riyadh", { now: local("2027-02-22T21:00") })).toBe("بانتظار أحمد · تابعه بعد 10:00 يوم الثلاثاء 23 فبراير (ساعات رمضان)");
    const early = computeAgenda([it1], local("2027-02-23T07:00"), { cal: RAMADAN }).buckets.waiting[0];
    expect(nextStepText(early, "en", "Asia/Riyadh", { now: local("2027-02-23T07:00") })).toBe("Waiting on أحمد · Follow up after 10:00 (Ramadan hours)");
  });

  it("an entry that is chaseable now, or whose moment is normal, has no reason line", () => {
    const due = computeAgenda([debt({ dueAt: iso(local("2026-10-02T10:00")) })], local("2026-10-05T12:00")).buckets.overdue[0];
    expect(due.moment?.why).toBe("quiet");
    expect(nextStepText(due, "en")).toBe("Chase أحمد");
    const plain = computeAgenda([debt({ dueAt: iso(local("2026-10-06T10:00")) })], local("2026-10-05T12:00")).buckets.waiting[0];
    expect(nextStepText(plain, "en")).toBe("Waiting on أحمد");
    // Agents and the owner are named, not quoted.
    const agent = computeAgenda([debt({ owedBy: "reem", dueAt: iso(local("2026-10-06T10:00")) })], local("2026-10-05T12:00")).buckets.waiting[0];
    expect(nextStepText(agent, "en", "Asia/Riyadh", { quote: true })).toBe("Waiting on Reem");
  });

  it("agenda_get gives the agent the reason line with the contact JSON-quoted", async () => {
    // A fixed clock, Thursday 1 October 2026 12:00 in Riyadh, so no Ramadan day or holiday a brand calendar may hold
    // can move the Sunday below. Only Date is faked; timers run.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-01T09:00:00Z"));
    try {
      const brand: Brand = { name: "Rif", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-09-29" };
      const u = await newUser("chasequiet");
      await saveBrand(u.email, brand);
      await signIn(u.email);
      // Due Friday 2 October: its chase moves to Sunday 4 October, 08:00.
      const r = await listRoute.POST(json("/api/secretary", "POST", { title: "Samples", direction: "they_owe", owedBy: "المورّد", dueAt: "2026-10-02T10:00" }));
      expect(r.status).toBe(200);
      const text = await runTool(u, "agenda_get", {}, []);
      expect(text).toContain('next: Waiting on "المورّد" · Follow up Sunday, October 4, the weekend');
    } finally {
      vi.useRealTimers();
    }
  });
});

// Rules 479-480: the alerts, the morning brief and the evening wrap read the chase rule (spec §2.2-2.3). The pure cases
// use the hand-built calendars above. The cases through the daily follow-ups, the brief and the wrap use a Riyadh
// brand's real calendar on dates checked to hold no holiday (October 2026) or to be ordinary Ramadan days (Tuesday 23
// and Wednesday 24 February 2027; Monday 22 is Founding Day); each fakes Date only (timers run) and gives the real
// clock back.
const ALERT_BRAND: Brand = { name: "Rif", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-09-29" };
async function fakeAt<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
async function workspace(prefix: string, brand: Brand = ALERT_BRAND): Promise<User> {
  const u = await newUser(prefix);
  await saveBrand(u.email, brand);
  return u;
}
async function make(u: User, ms: number, raw: Record<string, unknown>): Promise<SecItem> {
  const r = await fakeAt(ms, () => createItem(u, raw, { actor: "owner", via: "web", source: "owner" }));
  if (!r.ok) throw new Error(`createItem: ${r.error}`);
  return r.item;
}
/** The to-do alerts the daily follow-ups send at `ms`; a second run at the same moment must send none. */
async function alertsAt(u: User, ms: number): Promise<Notif[]> {
  return fakeAt(ms, async () => {
    const sent = (await followUps(u, u.email)).filter((n) => n.kind === "todo");
    expect((await followUps(u, u.email)).filter((n) => n.kind === "todo"), `second run at ${iso(ms)}`).toEqual([]);
    return sent;
  });
}
const seen = (u: User, fp: string) => db.get(`notifseen:${u.email}:${fp}`);
/** An away entry as the page's PUT stores it (Task 7). DELETE ends one by setting `until` to yesterday and keeping it. */
const goAway = (u: User, label: string, until: string) => db.hset(SEC_KEYS.away(u.email), partyKey(label)!, { label, until, by: u.email, via: "web", at: "2026-10-01T00:00:00.000Z" });

describe("rule 479: alerts for what others owe count working days from the chase moment, none on a quiet day, and say once that a contact is back", () => {
  it("workingDaysBetween counts the days in (a, b] that are not quiet", () => {
    // Thursday → Sunday in Riyadh: Friday and Saturday are the weekend.
    expect(workingDaysBetween("2026-10-08", "2026-10-11", RIYADH)).toBe(1);
    expect(workingDaysBetween("2026-10-08", "2026-10-19", RIYADH)).toBe(7);
    expect(workingDaysBetween("2026-10-08", "2026-10-08", RIYADH)).toBe(0);
    expect(workingDaysBetween("2026-10-11", "2026-10-08", RIYADH)).toBe(0);
    // Eid 9-12 March and the weekend: Monday 8 → Sunday 14 is one working day.
    expect(workingDaysBetween("2027-03-08", "2027-03-14", EID)).toBe(1);
    // Dubai's weekend is Saturday and Sunday.
    expect(workingDaysBetween("2026-10-09", "2026-10-11", DUBAI)).toBe(0);
  });

  it("a debt chaseable Thursday 8 October 2026 07:00: step 0 Thursday, none Friday or Saturday, 1 Sunday, 3 Tuesday, 7 Monday 19, an agent's too; the owner's own item keeps calendar days", () => {
    const days = Array.from({ length: 13 }, (_, i) => addDays("2026-10-08", i));
    const stepsOf = (item: SecItem) => days.map((d) => {
      const now = local(`${d}T08:00`);
      const a = computeAgenda([item], now, { cal: RIYADH });
      return overdueAlerts([...a.buckets.overdue, ...a.buckets.chase], now, "Asia/Riyadh", RIYADH)[0]?.step ?? null;
    });
    const due = iso(local("2026-10-08T07:00"));
    expect(stepsOf(debt({ dueAt: due }))).toEqual([0, null, null, 1, 1, 3, 3, 3, null, null, 3, 7, null]);
    expect(stepsOf(debt({ direction: "i_owe", owedBy: "owner", owedTo: null, dueAt: due }))).toEqual([0, 1, 1, 3, 3, 3, 3, 7, null, null, null, null, null]);
    // An agent's chase is never moved (spec §2.1 step 2), so Dana's item is overdue on Friday; its alert still waits for
    // a working day, like every item someone else owes (spec §2.3).
    const dana = debt({ owedBy: "dana", dueAt: due });
    expect(computeAgenda([dana], local("2026-10-09T08:00"), { cal: RIYADH }).counts.overdue).toBe(1);
    expect(stepsOf(dana)).toEqual([0, null, null, 1, 1, 3, 3, 3, null, null, 3, 7, null]);
    // Keyed by the anchor; `days` are working days.
    const sun = computeAgenda([debt({ dueAt: due })], local("2026-10-11T08:00"), { cal: RIYADH });
    expect(overdueAlerts(sun.buckets.overdue, local("2026-10-11T08:00"), "Asia/Riyadh", RIYADH)[0]).toMatchObject({ days: 1, step: 1, anchorMs: local("2026-10-08T07:00") });
    // Entries handed in on a quiet day give nothing for a contact.
    const thu = computeAgenda([debt({ dueAt: due })], local("2026-10-08T08:00"), { cal: RIYADH });
    expect(overdueAlerts(thu.buckets.overdue, local("2026-10-09T08:00"), "Asia/Riyadh", RIYADH)).toEqual([]);
    // An owner's item that is not overdue gives nothing, whatever bucket it is handed in from.
    const today = computeAgenda([debt({ direction: "i_owe", owedBy: "owner", owedTo: null, dueAt: iso(local("2026-10-08T12:00")) })], local("2026-10-08T08:00"), { cal: RIYADH });
    expect(overdueAlerts(today.buckets.today, local("2026-10-08T08:00"), "Asia/Riyadh", RIYADH)).toEqual([]);
  });

  it("through the daily follow-ups (Riyadh, real calendar): each step once, on working days only, and the step-3 marker outlives the weekend", async () => {
    const cal = workCalendar(null, "Asia/Riyadh", local("2026-10-08T08:00"));
    expect(Object.keys(cal.quiet).filter((d) => d.startsWith("2026-10"))).toEqual([]);
    const u = await workspace("al479steps");
    const it0 = await make(u, local("2026-10-07T12:00"), { title: "Quote from Ahmad", direction: "they_owe", owedBy: "أحمد", dueAt: "2026-10-08T07:00" });
    const got: number[] = [];
    let first: Notif[] = [], last: Notif[] = [];
    for (let i = 0; i <= 12; i++) {
      // The daily run, a minute later each day: a marker that lived five days would let Sunday 18's run repeat the
      // step Tuesday 13's run sent.
      const sent = await alertsAt(u, local(`${addDays("2026-10-08", i)}T08:00`) + i * 60_000);
      got.push(sent.length);
      if (i === 0) first = sent;
      if (i === 11) last = sent;
    }
    expect(got).toEqual([1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
    expect(first[0]).toMatchObject({ agent: "reem", href: "/ar/app/todo", title: "متأخرة: «Quote from Ahmad»", body: "تابِع مع أحمد، أو غيّر الموعد." });
    expect(last[0].body).toContain("آخر تنبيه");
    expect(await seen(u, `todo-due:${u.email}:${it0.id}:${local("2026-10-08T07:00")}:0`)).toBe(1);
  });

  it("an undated debt alerts on its anchor's day, at step 0, keyed by the anchor and titled as a follow-up, not as overdue", async () => {
    const u = await workspace("al479undated");
    // Created Thursday 1 October 10:00: its chase clock is two working days on, Monday 5 October 10:00.
    const it0 = await make(u, local("2026-10-01T10:00"), { title: "Samples", direction: "they_owe", owedBy: "المورّد" });
    expect(it0.expectBy).toBe(iso(local("2026-10-05T10:00")));
    expect(await alertsAt(u, local("2026-10-04T12:00"))).toEqual([]);
    const mon = await alertsAt(u, local("2026-10-05T12:00"));
    expect(mon).toHaveLength(1);
    expect(mon[0]).toMatchObject({ title: "حان وقت المتابعة: «Samples»", body: "تابِع مع المورّد، أو غيّر الموعد." });
    expect(await seen(u, `todo-due:${u.email}:${it0.id}:${local("2026-10-05T10:00")}:0`)).toBe(1);
    const a = computeAgenda([it0], local("2026-10-05T12:00"), { cal: RIYADH });
    expect(overdueAlerts(a.buckets.chase, local("2026-10-05T12:00"), "Asia/Riyadh", RIYADH)).toMatchObject([{ days: 0, step: 0, anchorMs: local("2026-10-05T10:00") }]);
    // In English.
    const v = await workspace("al479undateden");
    await make(v, local("2026-10-01T10:00"), { title: "Samples", direction: "they_owe", owedBy: "Sara" });
    const en = await fakeAt(local("2026-10-05T12:00"), async () => (await followUps({ ...v, lang: "en" }, v.email)).filter((n) => n.kind === "todo"));
    expect(en[0]).toMatchObject({ title: "Time to follow up: «Samples»", body: "Follow up with Sara, or change the date.", href: "/en/app/todo" });
  });

  it("the owner's own items keep today's steps (Friday included) and the fingerprint string todo-due:{scope}:{id}:{dueMs}:{step}", async () => {
    const u = await workspace("al479owner");
    const mine = await make(u, local("2026-10-07T12:00"), { title: "Pay the printer", dueAt: "2026-10-08T07:00" });
    const dueMs = Date.parse(mine.dueAt!);
    expect(await alertsAt(u, local("2026-10-08T08:00"))).toMatchObject([{ title: "متأخرة: «Pay the printer»", body: "أنجزها أو أجّلها أو غيّر موعدها." }]);
    expect(await alertsAt(u, local("2026-10-09T08:00"))).toHaveLength(1);
    expect(await seen(u, `todo-due:${u.email}:${mine.id}:${dueMs}:0`)).toBe(1);
    expect(await seen(u, `todo-due:${u.email}:${mine.id}:${dueMs}:1`)).toBe(1);
    expect(overdueAlertFingerprint(u.email, mine.id, dueMs, 3)).toBe(`todo-due:${u.email}:${mine.id}:${dueMs}:3`);
    expect(backFingerprint(u.email, mine.id, "2026-10-08")).toBe(`todo-back:${u.email}:${mine.id}:2026-10-08`);
  });

  it("over steps 0-3 after an absence, «انتهى غياب» comes once, on the first alert; an item made after the return never says it", async () => {
    const u = await workspace("al479back");
    const quote = await make(u, local("2026-10-01T12:00"), { title: "Quote from Ahmad", direction: "they_owe", owedBy: "أحمد", dueAt: "2026-10-05T10:00" });
    // «احمد» is the same contact: away until Thursday 8 October, so the chase waits for Sunday 11 October 08:00.
    await goAway(u, "احمد", "2026-10-08");
    const bodies: Record<string, string[]> = {};
    for (let i = 0; i <= 9; i++) {
      const day = addDays("2026-10-05", i);
      bodies[day] = (await alertsAt(u, local(`${day}T08:00`) + i * 60_000)).map((n) => n.body);
      if (day === "2026-10-11") {
        expect(await fakeAt(local("2026-10-11T08:06"), () => db.ttl(`notifseen:${u.email}:${backFingerprint(u.email, quote.id, "2026-10-08")}`))).toBe(7 * 86400);
        // Made after the return, for the same contact: its chase clock is Tuesday 13 October 12:00.
        await make(u, local("2026-10-11T12:00"), { title: "New request", direction: "they_owe", owedBy: "أحمد" });
      }
    }
    expect(Object.fromEntries(Object.entries(bodies).filter(([, b]) => b.length))).toEqual({
      "2026-10-11": ["انتهى غياب أحمد — وقت المتابعة."],
      "2026-10-12": ["تابِع مع أحمد، أو غيّر الموعد."],
      "2026-10-14": ["تابِع مع أحمد، أو غيّر الموعد.", "تابِع مع أحمد، أو غيّر الموعد."],
    });
    expect(Object.values(bodies).flat().filter((b) => b.includes("انتهى غياب"))).toHaveLength(1);
  });

  it("ending an absence early (DELETE sets until to yesterday) brings the back alert with the next run", async () => {
    const u = await workspace("al479end");
    const inv = await make(u, local("2026-10-01T12:00"), { title: "Invoice", direction: "they_owe", owedBy: "أحمد", dueAt: "2026-10-05T10:00" });
    await goAway(u, "أحمد", "2026-10-15");
    expect(await alertsAt(u, local("2026-10-05T08:00"))).toEqual([]);
    expect(await alertsAt(u, local("2026-10-06T08:01"))).toEqual([]);
    // Tuesday noon: the owner ends it; the entry stays, its last day now Monday 5 October.
    await goAway(u, "أحمد", "2026-10-05");
    const wed = await alertsAt(u, local("2026-10-07T08:02"));
    expect(wed).toMatchObject([{ title: "متأخرة: «Invoice»", body: "انتهى غياب أحمد — وقت المتابعة." }]);
    expect(await seen(u, backFingerprint(u.email, inv.id, "2026-10-05"))).toBe(1);
    expect(await alertsAt(u, local("2026-10-08T08:03"))).toEqual([]);
    // Sunday is the third working day after Tuesday's return: step 3, the normal text.
    expect(await alertsAt(u, local("2026-10-11T08:04"))).toMatchObject([{ body: "تابِع مع أحمد، أو غيّر الموعد." }]);
  });
});

describe("rule 480: in Ramadan the 08:00 alert and brief say when chasing opens, and the evening wrap names the morning it reads", () => {
  it("at the 08:00 run an item chase-due at 10:00 is alerted «تابعه اليوم بعد 10:00», step 0; the next morning step 1; nothing for tomorrow's window", async () => {
    const cal = workCalendar(null, "Asia/Riyadh", local("2027-02-23T08:00"));
    expect(["2027-02-23", "2027-02-24"].map((d) => [cal.ramadan.includes(d), cal.quiet[d] ?? null])).toEqual([[true, null], [true, null]]);
    expect(cal.ramadanHours).toEqual([{ from: "10:00", to: "15:00" }]);
    const u = await workspace("al480ramadan");
    const quote = await make(u, local("2027-02-21T12:00"), { title: "Quote", direction: "they_owe", owedBy: "أحمد", dueAt: "2027-02-23T07:00" });
    const a = await fakeAt(local("2027-02-23T08:00"), () => agendaFor(u.email, local("2027-02-23T08:00")));
    expect(a.buckets.waiting[0].moment).toEqual({ anchor: local("2027-02-23T10:00"), at: local("2027-02-23T10:00"), why: "ramadan" });
    expect(overdueAlerts(a.buckets.waiting, local("2027-02-23T08:00"), "Asia/Riyadh", a.cal)).toMatchObject([{ step: 0, days: 0, anchorMs: local("2027-02-23T10:00"), ramadanToday: "10:00" }]);
    const tue = await alertsAt(u, local("2027-02-23T08:00"));
    expect(tue).toMatchObject([{ title: "متأخرة: «Quote»", body: "تابعه اليوم بعد 10:00 مع أحمد، أو غيّر الموعد." }]);
    expect(await seen(u, `todo-due:${u.email}:${quote.id}:${local("2027-02-23T10:00")}:0`)).toBe(1);
    // Wednesday 08:00: chaseable since Tuesday 10:00, waiting for today's window.
    expect(await alertsAt(u, local("2027-02-24T08:01"))).toMatchObject([{ body: "تابعه اليوم بعد 10:00 مع أحمد، أو غيّر الموعد." }]);
    // In English.
    const v = await workspace("al480ramadanen");
    await make(v, local("2027-02-21T12:00"), { title: "Quote", direction: "they_owe", owedBy: "Sara", dueAt: "2027-02-23T07:00" });
    const en = await fakeAt(local("2027-02-23T08:00"), async () => (await followUps({ ...v, lang: "en" }, v.email)).filter((n) => n.kind === "todo"));
    expect(en).toMatchObject([{ title: "Overdue: «Quote»", body: "Follow up today after 10:00 with Sara, or change the date." }]);
    // At 21:00 the window is tomorrow's: no alert names it.
    const night = computeAgenda([debt({ expectBy: iso(local("2027-02-22T11:00")) })], local("2027-02-22T21:00"), { cal: RAMADAN });
    expect(night.buckets.waiting[0].moment?.why).toBe("ramadan");
    expect(overdueAlerts(night.buckets.waiting, local("2027-02-22T21:00"), "Asia/Riyadh", RAMADAN)).toEqual([]);
  });

  it("the brief counts the item as a chase at 08:00, with its time, and no longer as waiting", async () => {
    const at8 = briefAgenda(computeAgenda([debt({ dueAt: iso(local("2027-02-23T07:00")) })], local("2027-02-23T08:00"), { cal: RAMADAN }));
    expect(at8).toMatchObject({ chase: 1, waiting: 0, chaseAfter: { count: 1, time: "10:00" } });
    // At 21:00 the window is tomorrow's: waiting.
    const night = briefAgenda(computeAgenda([debt({ expectBy: iso(local("2027-02-22T11:00")) })], local("2027-02-22T21:00"), { cal: RAMADAN }));
    expect(night).toMatchObject({ chase: 0, waiting: 1 });
    expect(night.chaseAfter).toBeUndefined();
    // Two windows, 07:00-09:00 and 13:00-15:00: one chaseable now, one at 13:00.
    const two: CalData = { ...RAMADAN, ramadanHours: [{ from: "07:00", to: "09:00" }, { from: "13:00", to: "15:00" }] };
    const mixed = briefAgenda(computeAgenda([debt({ expectBy: iso(local("2027-02-23T07:30")) }), debt({ id: "s00000000000004a2", expectBy: iso(local("2027-02-23T10:00")) })], local("2027-02-23T08:00"), { cal: two }));
    expect(mixed).toMatchObject({ chase: 2, waiting: 0, chaseAfter: { count: 1, time: "13:00" } });

    const u = await workspace("al480brief");
    await make(u, local("2027-02-21T12:00"), { title: "Quote", direction: "they_owe", owedBy: "أحمد", dueAt: "2027-02-23T07:00" });
    const brief = (await fakeAt(local("2027-02-23T08:00"), () => runDaily(u)))!;
    expect(brief.agenda).toMatchObject({ chase: 1, waiting: 0 });
    expect(brief.text).toContain("0 بانتظار غيرك، 1 حان وقت متابعتها (اليوم بعد 10:00)");
    const v = await workspace("al480briefen", { ...ALERT_BRAND, languages: ["en"] });
    await make(v, local("2027-02-21T12:00"), { title: "Quote", direction: "they_owe", owedBy: "Sara", dueAt: "2027-02-23T07:00" });
    expect((await fakeAt(local("2027-02-23T08:00"), () => runDaily(v)))!.text).toContain("0 waiting on others, 1 to follow up (today after 10:00)");
  });

  it("the wrap's 'first for' line names the day and time its list is read at (ruling R14), in Latin digits", async () => {
    const w = (day: string, tomorrowAt: number): Wrap => ({ day, zone: "Asia/Riyadh", completed: [], approved: 0, rejected: 0, fellOverdue: [], tomorrow: ["Quote"], tomorrowAt });
    const line = (x: Wrap, lang: "ar" | "en") => wrapText(x, lang).body;
    expect(line(w("2026-10-05", local("2026-10-06T09:00")), "ar")).toBe("• أول ما ينتظرك غداً 9 ص: «Quote»");
    expect(line(w("2026-10-05", local("2026-10-06T09:00")), "en")).toBe("• First for tomorrow at 9 AM: «Quote»");
    // A Riyadh Thursday: Sunday 08:00.
    expect(line(w("2026-10-08", local("2026-10-11T08:00")), "ar")).toBe("• أول ما ينتظرك الأحد 8 ص: «Quote»");
    expect(line(w("2026-10-08", local("2026-10-11T08:00")), "en")).toBe("• First for Sunday at 8 AM: «Quote»");
    // Ramadan: the 10:00 window, a half-hour window, an afternoon one.
    expect(line(w("2027-02-23", local("2027-02-24T10:00")), "ar")).toBe("• أول ما ينتظرك غداً 10 ص: «Quote»");
    expect(line(w("2027-02-23", local("2027-02-24T10:00")), "en")).toBe("• First for tomorrow at 10 AM: «Quote»");
    expect(line(w("2027-02-23", local("2027-02-24T10:30")), "en")).toBe("• First for tomorrow at 10:30 AM: «Quote»");
    expect(line(w("2027-02-23", local("2027-02-24T13:00")), "ar")).toBe("• أول ما ينتظرك غداً 1 م: «Quote»");
    // A week or more away (Eid, then the Saudi day in lieu): the date as well.
    expect(line(w("2027-03-08", local("2027-03-15T08:00")), "ar")).toBe("• أول ما ينتظرك الاثنين 15 مارس 8 ص: «Quote»");
    expect(line(w("2027-03-08", local("2027-03-15T08:00")), "en")).toBe("• First for Monday, March 15 at 8 AM: «Quote»");
    expect(line(w("2027-03-08", local("2027-03-15T08:00")), "ar")).not.toMatch(/[٠-٩]/);

    // Built from the store: a Thursday wrap reads Sunday 08:00, a Ramadan wrap the 10:00 window.
    const u = await workspace("al480wrap");
    await make(u, local("2026-10-07T09:00"), { title: "Quote from Ahmad", direction: "they_owe", owedBy: "Ahmad", dueAt: "2026-10-07T10:00" });
    const thu = await fakeAt(local("2026-10-08T18:00"), () => buildWrap(u.email, local("2026-10-08T18:00")));
    expect(thu.tomorrowAt).toBe(local("2026-10-11T08:00"));
    expect(wrapText(thu, "en").body).toContain("• First for Sunday at 8 AM: «Quote from Ahmad»");
    const v = await workspace("al480wrapram");
    await make(v, local("2027-02-21T12:00"), { title: "Quote", direction: "they_owe", owedBy: "أحمد", dueAt: "2027-02-23T11:00" });
    const ram = await fakeAt(local("2027-02-23T21:30"), () => buildWrap(v.email, local("2027-02-23T21:30")));
    expect(ram.tomorrowAt).toBe(local("2027-02-24T10:00"));
    expect(wrapText(ram, "ar").body).toContain("• أول ما ينتظرك غداً 10 ص: «Quote»");
  });
});
