import { describe, expect, it, vi } from "vitest";
import { json, newMember, newUser, params, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { appDict } from "@/lib/app-i18n";
import * as listRoute from "@/app/api/secretary/route";
import * as itemRoute from "@/app/api/secretary/[id]/route";
import {
  OWNER_ONLY, SEC_KEYS, SEC_OPEN_MAX, SERIES_ID, agendaFor, changeItem, createItem, fireReminder, getItem, listOpenItems, mutateItem, newSeriesId, parseOwnerChange, parseRepeat, runSecretaryTool,
} from "@/lib/secretary";
import { saveTask, updateTask, type Task } from "@/lib/brand";
import { runTool } from "@/lib/chat";
import { runHandoffNote } from "@/lib/secretary-handoff";
import { SEC_TOOL_DEFS } from "@/lib/secretary";
import { wrapText, type Wrap } from "@/lib/secretary-evening";
import {
  AUTO_CLOSE_RESULT, SKIP_RESULT, resultText, addDays, addMonthsClamped, defaultCal, gregorianNext, noteText, repeatText, weekStartOf, weekdayOf, zoneDay, type CalData, type SecItem, type SecRepeat,
} from "@/lib/secretary-agenda";
import { hijriMonthStart, nextOccurrence, workCalendar, type SecCalendar } from "@/lib/secretary-calendar";
import { hijriDate } from "@/lib/seasons";

import { acct } from "@/lib/auth";
const z = "Asia/Riyadh";
const at = (day: string, hm = "12:00") => Date.parse(`${day}T${hm}:00+03:00`);
const day = (iso: string) => iso.slice(0, 10);
const localDay = (iso: string) => new Date(Date.parse(iso) + 3 * 3600_000).toISOString().slice(0, 10);

describe("rule 490: month and year candidates clamp per candidate from the anchor", () => {
  const cal = defaultCal(z);
  const rule = (o: Partial<SecRepeat>): SecRepeat => ({ every: "month", interval: 1, anchor: "2026-01-31", weekStart: 0, ...o });

  it("31 Jan → 28 Feb → 31 Mar", () => {
    const a = gregorianNext(rule({}), at("2026-01-31", "23:59"), at("2026-01-31"), z, cal)!;
    expect(a.dueAt.slice(0, 10)).toBe("2026-02-28");
    expect(a.allDay).toBe(true);
    const b = gregorianNext(rule({}), Date.parse(a.dueAt), at("2026-02-28"), z, cal)!;
    expect(b.dueAt.slice(0, 10)).toBe("2026-03-31");
  });

  it("29 Feb 2028 → 28 Feb 2029 → … → 29 Feb 2032", () => {
    const r = rule({ every: "year", anchor: "2028-02-29" });
    const days: string[] = [];
    let prev = at("2028-02-29", "23:59");
    for (let i = 0; i < 4; i++) {
      const n = gregorianNext(r, prev, prev, z, cal)!;
      days.push(day(n.dueAt));
      prev = Date.parse(n.dueAt);
    }
    expect(days).toEqual(["2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]);
  });

  it("monthDay -1 is the last day of every month", () => {
    const r = rule({ anchor: "2026-01-31", monthDay: -1 });
    const days: string[] = [];
    let prev = at("2026-01-31", "23:59");
    for (let i = 0; i < 3; i++) {
      const n = gregorianNext(r, prev, prev, z, cal)!;
      days.push(day(n.dueAt));
      prev = Date.parse(n.dueAt);
    }
    expect(days).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("addMonthsClamped never feeds a clamped day back and handles year ends", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonthsClamped("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonthsClamped("2026-01-15", 1, -1)).toBe("2026-02-28");
    expect(addMonthsClamped("2026-01-15", 1, 31)).toBe("2026-02-28");
    expect(addMonthsClamped("2026-01-15", 12)).toBe("2027-01-15");
  });
});

describe("rule 491: week grid, workdays, no pile-up, reschedule, timed vs all-day", () => {
  const cal = defaultCal(z);

  it("weekdayOf and weekStartOf", () => {
    // 2026-10-03 is a Saturday.
    expect(weekdayOf("2026-10-03")).toBe(6);
    expect(weekStartOf("2026-10-03", 0)).toBe("2026-09-27");
    expect(weekStartOf("2026-09-27", 0)).toBe("2026-09-27");
    expect(weekStartOf("2026-10-03", 1)).toBe("2026-09-28");
    expect(weekStartOf("2026-10-03", 6)).toBe("2026-10-03");
  });

  it("every 2 weeks on Sun+Tue keeps its grid after a close 3 weeks late and opens ONE copy", () => {
    // Anchor Sunday 2026-01-04; week start Sunday; blocks 0, 2, 4 … carry Sunday and Tuesday.
    const rule: SecRepeat = { every: "week", interval: 2, anchor: "2026-01-04", weekStart: 0, weekdays: [0, 2] };
    // On time: Sun 4 Jan done, next is Tue 6 Jan.
    const a = gregorianNext(rule, at("2026-01-04", "23:59"), at("2026-01-04"), z, cal)!;
    expect(day(a.dueAt)).toBe("2026-01-06");
    // Tue 6 Jan copy is closed 3 weeks late (27 Jan, a Tuesday of an off block: blocks are 4 Jan, 18 Jan, 1 Feb).
    const late = at("2026-01-27", "10:00");
    const b = gregorianNext(rule, at("2026-01-06", "23:59"), late, z, cal)!;
    // One copy, on the grid: the next block is the week of 1 Feb; Sunday 1 Feb.
    expect(day(b.dueAt)).toBe("2026-02-01");
    // And after that, Tuesday 3 Feb, then the grid skips a week: 15 Feb.
    const c = gregorianNext(rule, Date.parse(b.dueAt), Date.parse(b.dueAt), z, cal)!;
    expect(day(c.dueAt)).toBe("2026-02-03");
    const d = gregorianNext(rule, Date.parse(c.dueAt), Date.parse(c.dueAt), z, cal)!;
    expect(day(d.dueAt)).toBe("2026-02-15");
  });

  it("week with no weekdays uses the anchor's weekday", () => {
    const rule: SecRepeat = { every: "week", interval: 1, anchor: "2026-01-04", weekStart: 0 };
    const n = gregorianNext(rule, at("2026-01-04", "23:59"), at("2026-01-04"), z, cal)!;
    expect(day(n.dueAt)).toBe("2026-01-11");
  });

  it("a week rule never opens before its anchor", () => {
    // Anchor is Tuesday 6 Jan; Sunday is in the anchor's block but earlier than the anchor.
    const rule: SecRepeat = { every: "week", interval: 1, anchor: "2026-01-06", weekStart: 0, weekdays: [0, 2] };
    const n = gregorianNext(rule, at("2025-12-01"), at("2025-12-01"), z, cal)!;
    expect(day(n.dueAt)).toBe("2026-01-06");
  });

  it("workday skips the weekend and a quiet Eid day from CalData", () => {
    // Riyadh weekend is Friday and Saturday. Thursday 2026-03-19 → Sunday 22 Mar normally.
    const rule: SecRepeat = { every: "workday", interval: 1, anchor: "2026-03-15", weekStart: 0 };
    const plain = gregorianNext(rule, at("2026-03-19", "23:59"), at("2026-03-19"), z, cal)!;
    expect(day(plain.dueAt)).toBe("2026-03-22");
    // Sunday 22 and Monday 23 Mar are quiet (Eid): the next workday is Tuesday 24.
    const eid: CalData = { ...cal, quiet: { "2026-03-22": { kind: "eid_fitr" }, "2026-03-23": { kind: "eid_fitr" } } };
    const withEid = gregorianNext(rule, at("2026-03-19", "23:59"), at("2026-03-19"), z, eid)!;
    expect(day(withEid.dueAt)).toBe("2026-03-24");
  });

  it("day with an interval counts from the anchor", () => {
    const rule: SecRepeat = { every: "day", interval: 3, anchor: "2026-01-01", weekStart: 0 };
    const n = gregorianNext(rule, at("2026-01-01", "23:59"), at("2026-01-01"), z, cal)!;
    expect(day(n.dueAt)).toBe("2026-01-04");
    // Closed late: still on the 3-day grid (1, 4, 7, 10 …).
    const late = gregorianNext(rule, at("2026-01-04", "23:59"), at("2026-01-09"), z, cal)!;
    expect(day(late.dueAt)).toBe("2026-01-10");
  });

  it("a timed copy whose time passed today opens on the next date; an all-day copy opens today", () => {
    const timed: SecRepeat = { every: "day", interval: 1, anchor: "2026-05-01", weekStart: 0, time: "09:00" };
    // Closed at 10:00 on 5 May, the copy's previous due was 4 May 09:00. Today's 09:00 has passed.
    const t = gregorianNext(timed, at("2026-05-04", "09:00"), at("2026-05-05", "10:00"), z, cal)!;
    expect(t.allDay).toBe(false);
    expect(localDay(t.dueAt)).toBe("2026-05-06");
    expect(Date.parse(t.dueAt)).toBe(at("2026-05-06", "09:00"));
    // Closed at 08:00 on 5 May: today's 09:00 is still ahead.
    const t2 = gregorianNext(timed, at("2026-05-04", "09:00"), at("2026-05-05", "08:00"), z, cal)!;
    expect(Date.parse(t2.dueAt)).toBe(at("2026-05-05", "09:00"));

    const allDay: SecRepeat = { every: "day", interval: 1, anchor: "2026-05-01", weekStart: 0 };
    const a = gregorianNext(allDay, at("2026-05-04", "23:59"), at("2026-05-05", "10:00"), z, cal)!;
    expect(a.allDay).toBe(true);
    expect(localDay(a.dueAt)).toBe("2026-05-05");
    expect(Date.parse(a.dueAt)).toBe(at("2026-05-05", "23:59"));
  });

  it("a reschedule moves one copy; the next copy is built from the anchor grid and the rule's time (R36)", () => {
    const rule: SecRepeat = { every: "week", interval: 1, anchor: "2026-01-04", weekStart: 0, time: "09:00" };
    // The Sunday 11 Jan copy was moved to Wednesday 14 Jan at 23:59 (a reschedule form's time); closed on the 14th.
    const moved = at("2026-01-14", "23:59");
    const n = gregorianNext(rule, moved, at("2026-01-14", "20:00"), z, cal)!;
    expect(n.allDay).toBe(false);
    expect(Date.parse(n.dueAt)).toBe(at("2026-01-18", "09:00"));
  });

  it("a rescheduled copy of an all-day rule still opens the next copy all-day on the grid (R36)", () => {
    const rule: SecRepeat = { every: "week", interval: 1, anchor: "2026-01-04", weekStart: 0 };
    // The copy was moved to a timed 23:59 on Wednesday 14 Jan; the rule has no time, so the next copy is all-day on Sunday 18 Jan.
    const n = gregorianNext(rule, at("2026-01-14", "23:59"), at("2026-01-14", "20:00"), z, cal)!;
    expect(n.allDay).toBe(true);
    expect(localDay(n.dueAt)).toBe("2026-01-18");
    expect(Date.parse(n.dueAt)).toBe(at("2026-01-18", "23:59"));
  });

  it("until ends the series (null), inclusive of the last day", () => {
    const rule: SecRepeat = { every: "day", interval: 1, anchor: "2026-01-01", weekStart: 0, until: "2026-01-03" };
    const last = gregorianNext(rule, at("2026-01-02", "23:59"), at("2026-01-02"), z, cal)!;
    expect(day(last.dueAt)).toBe("2026-01-03");
    expect(gregorianNext(rule, Date.parse(last.dueAt), at("2026-01-03"), z, cal)).toBeNull();
  });

  it("malformed data cannot loop: interval 0, empty weekdays and an all-quiet calendar all end", () => {
    const zero: SecRepeat = { every: "day", interval: 0, anchor: "2026-01-01", weekStart: 0 };
    expect(gregorianNext(zero, at("2026-01-01", "23:59"), at("2026-01-01"), z, cal)).not.toBeNull();
    const none: SecRepeat = { every: "week", interval: 1, anchor: "2026-01-04", weekStart: 0, weekdays: [] };
    expect(day(gregorianNext(none, at("2026-01-04", "23:59"), at("2026-01-04"), z, cal)!.dueAt)).toBe("2026-01-11");
    const allQuiet: CalData = { ...cal, weekend: [0, 1, 2, 3, 4, 5, 6] };
    expect(gregorianNext({ every: "workday", interval: 1, anchor: "2026-01-01", weekStart: 0 }, at("2026-01-01"), at("2026-01-01"), z, allQuiet)).toBeNull();
  });

  it("an anchor years in the past still finds the grid date", () => {
    const rule: SecRepeat = { every: "month", interval: 1, anchor: "2000-01-15", weekStart: 0 };
    const n = gregorianNext(rule, at("2026-06-15", "23:59"), at("2026-06-15"), z, cal)!;
    expect(day(n.dueAt)).toBe("2026-07-15");
  });
});

describe("rule 501: repeatText, the two_open note and the skip result", () => {
  const base = { interval: 1, anchor: "2026-01-04", weekStart: 0 } as const;

  it("«يتكرر كل يوم أحد» / 'Repeats every Sunday'", () => {
    const r: SecRepeat = { ...base, every: "week" };
    expect(repeatText(r, "ar")).toBe("يتكرر كل يوم أحد");
    expect(repeatText(r, "en")).toBe("Repeats every Sunday");
    expect(repeatText({ ...r, weekdays: [2, 0] }, "en")).toBe("Repeats every Sunday and Tuesday");
    expect(repeatText({ ...r, weekdays: [0, 2] }, "ar")).toBe("يتكرر كل يوم أحد ويوم ثلاثاء");
  });

  it("dual and plural forms: every 2 weeks, 2 days, 3 days, 2 months, 2 years", () => {
    expect(repeatText({ ...base, every: "week", interval: 2, weekdays: [0, 2] }, "ar")).toBe("يتكرر كل أسبوعين، يوم أحد ويوم ثلاثاء");
    expect(repeatText({ ...base, every: "week", interval: 2, weekdays: [0, 2] }, "en")).toBe("Repeats every 2 weeks on Sunday and Tuesday");
    expect(repeatText({ ...base, every: "day", interval: 2 }, "ar")).toBe("يتكرر كل يومين");
    expect(repeatText({ ...base, every: "day", interval: 3 }, "ar")).toBe("يتكرر كل 3 أيام");
    expect(repeatText({ ...base, every: "day", interval: 11 }, "ar")).toBe("يتكرر كل 11 يومًا");
    expect(repeatText({ ...base, every: "day", interval: 1 }, "ar")).toBe("يتكرر كل يوم");
    expect(repeatText({ ...base, every: "day", interval: 3 }, "en")).toBe("Repeats every 3 days");
    expect(repeatText({ ...base, every: "month", interval: 2 }, "ar")).toBe("يتكرر كل شهرين، يوم 4");
    expect(repeatText({ ...base, every: "year", interval: 2 }, "ar")).toBe("يتكرر كل سنتين، في 4 يناير");
    expect(repeatText({ ...base, every: "year", interval: 2 }, "en")).toBe("Repeats every 2 years on 4 January");
    expect(repeatText({ ...base, every: "workday" }, "ar")).toBe("يتكرر كل يوم عمل");
    expect(repeatText({ ...base, every: "workday" }, "en")).toBe("Repeats every working day");
  });

  it("monthly: the day, the last day, and Hijri months with Latin digits", () => {
    expect(repeatText({ ...base, every: "month", monthDay: 15 }, "en")).toBe("Repeats every month on day 15");
    expect(repeatText({ ...base, every: "month", monthDay: -1 }, "ar")).toBe("يتكرر كل شهر، آخر يوم");
    expect(repeatText({ ...base, every: "month", monthDay: -1 }, "en")).toBe("Repeats every month on the last day");
    expect(repeatText({ ...base, every: "hmonth", monthDay: 1 }, "ar")).toBe("يتكرر كل شهر هجري، يوم 1");
    expect(repeatText({ ...base, every: "hmonth", monthDay: -1 }, "en")).toBe("Repeats every Hijri month on the last day");
    expect(repeatText({ ...base, every: "hyear" }, "ar", { month: 9, day: 1 })).toBe("يتكرر كل سنة هجرية، في 1 رمضان");
    expect(repeatText({ ...base, every: "hyear" }, "en", { month: 9, day: 1 })).toBe("Repeats every Hijri year on 1 Ramadan");
    expect(repeatText({ ...base, every: "hyear" }, "en")).toBe("Repeats every Hijri year");
    expect(repeatText({ ...base, every: "hyear" }, "ar", { month: 12, day: 10 })).toBe("يتكرر كل سنة هجرية، في 10 ذو الحجة");
    // Never Arabic-Indic digits, in either language.
    for (const lang of ["ar", "en"] as const) {
      expect(repeatText({ ...base, every: "month", interval: 12, monthDay: 15, until: "2027-01-01", count: 20 }, lang)).not.toMatch(/[٠-٩]/);
    }
  });

  it("time, until and count are said", () => {
    const r: SecRepeat = { ...base, every: "day", time: "09:30", until: "2026-12-31", count: 5 };
    expect(repeatText(r, "en")).toBe("Repeats every day at 09:30, until 2026-12-31, 5 times");
    expect(repeatText(r, "ar")).toBe("يتكرر كل يوم الساعة 09:30، حتى 2026-12-31، 5 مرات");
  });

  it("noteText words two_open in both languages, and SKIP_RESULT is a fixed non-empty result", () => {
    expect(noteText({ kind: "two_open", text: "" }, "ar")).toBe("النسخة التالية مفتوحة ومعدّلة — صار عندك نسختان");
    expect(noteText({ kind: "two_open", text: "" }, "en")).toBe("The next copy is open and was edited; there are now two");
    expect(SKIP_RESULT.length).toBeGreaterThan(0);
    expect(SKIP_RESULT.length).toBeLessThan(200);
  });
});

// Rules 492 and 493. Every Hijri date below was read from ICU (Umm al-Qura, Riyadh) in a throwaway script, and the tests
// check them again through `hijriDate`, the one lookup `seasons.ts` allows.
const hOf = (d: string) => { const h = hijriDate(new Date(Date.parse(`${d}T09:00:00Z`)), z); return `${h.y}-${h.m}-${h.day}`; };
const settings = (hijriFix: SecCalendar["hijriFix"] = {}): SecCalendar => ({
  v: 1, weekend: null, ramadanHours: null, hijriFix, holidays: { add: [], remove: [] }, updatedAt: "2026-10-02T09:00:00.000Z", updatedBy: "admin@example.com",
});
const NOW = at("2026-10-03");
const hRule = (o: Partial<SecRepeat>): SecRepeat => ({ every: "hmonth", interval: 1, anchor: "2026-08-13", weekStart: 0, ...o });
/** The local day of a series' next copy, after the copy due at the end of `prev`. */
const nextDay = (r: SecRepeat, prev: string, cal: CalData, n = 1) => {
  const due = Date.parse(`${prev}T23:59:00+03:00`);
  const out = nextOccurrence(r, new Date(due).toISOString(), due, z, cal, n); // closed on its due date: `now` is that moment
  return out ? localDay(out.dueAt) : null;
};

describe("rule 492: Hijri monthly and yearly occurrences", () => {
  const cal = workCalendar(null, z, NOW);

  it("Hijri 30 → 29 → 30 (dates rechecked against ICU in the test)", () => {
    // 1448: Safar has 30 days, Rabi al-awwal 29, Rabi al-thani 30.
    expect(hOf("2026-08-13")).toBe("1448-2-30");
    const r = hRule({});
    const a = nextDay(r, "2026-08-13", cal)!;
    const b = nextDay(r, a, cal)!;
    expect([a, b]).toEqual(["2026-09-11", "2026-10-11"]);
    expect(hOf(a)).toBe("1448-3-29");
    expect(hOf(b)).toBe("1448-4-30");
    // The clamped 29 is never fed back: the day after it is the anchor's 30 again, not 29.
    expect(nextDay(r, b, cal)).toBe("2026-11-10");
    expect(hOf("2026-11-10")).toBe("1448-5-30");
  });

  it("an hmonth rule with monthDay -1 lands on the last day of each Hijri month", () => {
    const r = hRule({ monthDay: -1, anchor: "2026-07-14" });
    expect(nextDay(r, "2026-07-14", cal)).toBe("2026-08-13"); // Safar's 30th
    expect(nextDay(r, "2026-08-13", cal)).toBe("2026-09-11"); // Rabi al-awwal's 29th
  });

  it("an interval of 2 skips a Hijri month, and a timed copy keeps its local time", () => {
    const r = hRule({ interval: 2, anchor: "2026-06-16", time: "09:30" });
    const out = nextOccurrence(r, "2026-06-16T06:30:00.000Z", Date.parse("2026-06-16T06:30:00.000Z"), z, cal, 1)!;
    expect(out.allDay).toBe(false);
    expect(out.dueAt).toBe("2026-08-14T06:30:00.000Z"); // 1 Rabi al-awwal 1448, 09:30 in Riyadh
    expect(hOf("2026-08-14")).toBe("1448-3-1");
  });

  it("a hijriFix shifts the hmonth copy that falls on 1 Shawwal or 1 Dhu al-Hijjah", () => {
    expect(hOf("2027-03-09")).toBe("1448-10-1");
    expect(hOf("2027-05-07")).toBe("1448-12-1");
    const fixed = workCalendar(settings({ "1448": { shawwal1: "2027-03-10", dhulhijja1: "2027-05-06" } }), z, NOW);
    expect(fixed.hijriFix).toEqual({ "1448": { shawwal1: "2027-03-10", dhulhijja1: "2027-05-06" } });
    expect(nextDay(hRule({ anchor: "2027-02-08", monthDay: 1 }), "2027-02-08", cal)).toBe("2027-03-09");
    expect(nextDay(hRule({ anchor: "2027-02-08", monthDay: 1 }), "2027-02-08", fixed)).toBe("2027-03-10");
    expect(nextDay(hRule({ anchor: "2027-04-08", monthDay: 1 }), "2027-04-08", cal)).toBe("2027-05-07");
    expect(nextDay(hRule({ anchor: "2027-04-08", monthDay: 1 }), "2027-04-08", fixed)).toBe("2027-05-06");
    // A fix more than a day from Umm al-Qura, or for a past year, is not read: CalData carries only what the calendar reads.
    expect(workCalendar(settings({ "1448": { shawwal1: "2027-03-12" }, "1447": { shawwal1: "2026-03-20" } }), z, NOW).hijriFix).toBeUndefined();
    expect(cal.hijriFix).toBeUndefined();
  });

  it("hijriMonthStart: Umm al-Qura, the fix on months 10 and 12, and a Ramadan the fix would stretch to 31 days starts a day later", () => {
    expect(hijriMonthStart(1448, 10, z)).toBe("2027-03-09");
    expect(hijriMonthStart(1448, 10, z, { "1448": { shawwal1: "2027-03-08" } })).toBe("2027-03-08");
    expect(hijriMonthStart(1448, 10, z, { "1448": { shawwal1: "2027-03-11" } })).toBe("2027-03-09"); // 2 days off: ignored
    expect(hijriMonthStart(1448, 9, z, { "1448": { shawwal1: "2027-03-10" } })).toBe("2027-02-08"); // 30 days: untouched
    // 1451's Ramadan has 30 days (2030-01-05 to 2030-02-04); Eid a day later would make 31, so Ramadan starts a day later.
    expect(hijriMonthStart(1451, 9, z)).toBe("2030-01-05");
    expect(hijriMonthStart(1451, 10, z)).toBe("2030-02-04");
    expect(hijriMonthStart(1451, 9, z, { "1451": { shawwal1: "2030-02-05" } })).toBe("2030-01-06");
    expect(hijriMonthStart(1451, 10, z, { "1451": { shawwal1: "2030-02-05" } })).toBe("2030-02-05");
    expect(hijriMonthStart(1451, 9, z, { "1451": { shawwal1: "2030-02-03" } })).toBe("2030-01-05");
  });

  it("hyear keeps the anchor's Hijri month and day", () => {
    expect(hOf("2026-10-23")).toBe("1448-5-12");
    const r = hRule({ every: "hyear", anchor: "2026-10-23" });
    const a = nextDay(r, "2026-10-23", cal)!;
    const b = nextDay(r, a, cal)!;
    expect(hOf(a)).toBe("1449-5-12");
    expect(hOf(b)).toBe("1450-5-12");
    const two = nextDay({ ...r, interval: 2 }, "2026-10-23", cal)!;
    expect(hOf(two)).toBe("1450-5-12");
    // 30 Safar 1448 clamps to 29 Safar 1449 (that Safar has 29 days: 5 July to 2 August 2027; 3 August is 1 Rabi al-awwal).
    const s = hRule({ every: "hyear", anchor: "2026-08-13" });
    expect(hOf(nextDay(s, "2026-08-13", cal)!)).toBe("1449-2-29");
  });
});

describe("rule 493: the series ends on count or until, and the search is bounded", () => {
  const cal = workCalendar(null, z, NOW);
  const prevIso = (d: string) => new Date(Date.parse(`${d}T23:59:00+03:00`)).toISOString();
  const next = (r: SecRepeat, d: string, n: number, c: CalData = cal) => nextOccurrence(r, prevIso(d), Date.parse(prevIso(d)), z, c, n);

  it("n >= count gives null; a date after until gives null", () => {
    const r = hRule({ count: 3 });
    expect(next(r, "2026-08-13", 2)).not.toBeNull();
    expect(next(r, "2026-08-13", 3)).toBeNull();
    expect(next(r, "2026-08-13", 4)).toBeNull();
    const g: SecRepeat = { every: "week", interval: 1, anchor: "2026-10-04", weekStart: 0, count: 2 };
    expect(next(g, "2026-10-04", 1)).not.toBeNull();
    expect(next(g, "2026-10-04", 2)).toBeNull();
    // Until is inclusive: the next Hijri copy is 11 September, the next weekly one 11 October.
    expect(next(hRule({ until: "2026-09-11" }), "2026-08-13", 1)?.dueAt.slice(0, 10)).toBe("2026-09-11");
    expect(next(hRule({ until: "2026-09-10" }), "2026-08-13", 1)).toBeNull();
    expect(next({ ...g, count: undefined, until: "2026-10-11" }, "2026-10-04", 1)).not.toBeNull();
    expect(next({ ...g, count: undefined, until: "2026-10-10" }, "2026-10-04", 1)).toBeNull();
  });

  it("an impossible rule returns null within 366 × interval days instead of looping", () => {
    // Every day of the week is a weekend day, so a workday rule has nothing to find.
    const allOff: CalData = { ...cal, weekend: [0, 1, 2, 3, 4, 5, 6] };
    const w: SecRepeat = { every: "workday", interval: 1, anchor: "2026-10-04", weekStart: 0 };
    expect(next(w, "2026-10-04", 1, allOff)).toBeNull();
    // An anchor beyond the search bound (a year of candidates from the later of the closed copy and today) has none.
    const far = (o: Partial<SecRepeat>) => nextOccurrence(hRule({ anchor: "2200-01-01", ...o }), prevIso("2026-08-13"), Date.parse(prevIso("2026-08-13")), z, cal, 1);
    expect(far({ interval: 3 })).toBeNull();
    expect(far({ every: "hyear", interval: 3 })).toBeNull();
    // A malformed previous date or anchor gives null, never a throw.
    expect(nextOccurrence(hRule({}), "not a date", NOW, z, cal, 1)).toBeNull();
    expect(next(hRule({ anchor: "nonsense" }), "2026-08-13", 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Rules 494 and 495: validation, first date, reminder, time of day (R36-R38, R42, R53); skip, stop and ending a series.

const create = (body: unknown) => listRoute.POST(json("/api/secretary", "POST", body));
const patch = (id: string, body: unknown) => itemRoute.PATCH(json(`/api/secretary/${id}`, "PATCH", body), params({ id }));
async function login() {
  const u = await newUser("secrep");
  await signIn(u.email);
  return u;
}
async function add(body: Record<string, unknown>): Promise<SecItem> {
  const r = await create(body);
  const j = await r.json();
  expect(r.status, JSON.stringify(j)).toBe(200);
  return j.item as SecItem;
}
const inDays = (d: number, hh = 10) => `${zoneDay(Date.now() + d * 864e5, z)}T${String(hh).padStart(2, "0")}:00`;
const web = { actor: "owner", via: "web" } as const;
const chat = { actor: "reem", via: "chat" } as const;
const HOUR = 3600_000;

describe("rule 494: a repeat needs a due date, from every caller", () => {
  it("an end date before the item's due day is repeat_until_before_due (400, field repeat) on create and reschedule; the due day itself is allowed", async () => {
    const u = await login();
    const due = inDays(8, 11);
    const before = zoneDay(Date.now() + 5 * 864e5, z);
    const r = await create({ title: "Post", dueAt: due, repeat: { every: "day", interval: 10, until: before } });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ ok: false, error: "repeat_until_before_due", field: "repeat" });
    const ok = await add({ title: "Post", dueAt: due, repeat: { every: "day", until: zoneDay(Date.now() + 8 * 864e5, z) } });
    const moved = await patch(ok.id, { action: "reschedule", dueAt: inDays(12, 11) });
    expect(moved.status).toBe(400);
    expect(await moved.json()).toMatchObject({ ok: false, error: "repeat_until_before_due" });
    expect(await getItem(acct(u), ok.id)).toMatchObject({ rev: 1, dueAt: ok.dueAt });
  });
  it("update with dueAt null, reschedule to null and todo_update clear_due all answer repeat_needs_due (400, field dueAt)", async () => {
    const u = await login();
    const it1 = await add({ title: "Weekly report", dueAt: inDays(1, 9), repeat: { every: "week" } });
    expect(it1.repeat).toMatchObject({ every: "week", interval: 1, time: "09:00" });
    for (const body of [{ dueAt: null }, { action: "reschedule", dueAt: null }]) {
      const r = await patch(it1.id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toMatchObject({ ok: false, error: "repeat_needs_due", field: "dueAt" });
    }
    const t = await runSecretaryTool(u, "todo_update", { id: it1.id, clear_due: true }, { who: chat, lang: "en" });
    expect(t.isError).toBe(true);
    expect(t.text).toContain("needs a due date");
    expect(t.text).toContain("(field: dueAt)");
    expect(await getItem(acct(u), it1.id)).toMatchObject({ rev: 1, dueAt: it1.dueAt });
  });

  it("setting repeat on an undated item gives it the first occurrence, all-day, and mints the series (R42)", async () => {
    const u = await login();
    const plain = await add({ title: "No date yet" });
    expect(plain.dueAt).toBeNull();
    expect(plain.series).toBeUndefined();
    const r = await patch(plain.id, { repeat: { every: "day" } });
    const j = await r.json();
    expect(r.status, JSON.stringify(j)).toBe(200);
    const it2 = j.item as SecItem;
    const today = zoneDay(Date.now(), z);
    expect(it2.allDay).toBe(true);
    expect(localDay(it2.dueAt!)).toBe(today);
    expect(it2.repeat).toMatchObject({ every: "day", interval: 1, anchor: today });
    expect(it2.repeat!.time).toBeUndefined();
    expect(it2.series!.id).toMatch(SERIES_ID);
    expect(it2.series!.n).toBe(1);
    // created with a repeat and no date: the same
    const born = await add({ title: "Born recurring", repeat: { every: "day", interval: 2 } });
    expect(born).toMatchObject({ allDay: true });
    expect(localDay(born.dueAt!)).toBe(today);
    expect(born.series!.id).toMatch(SERIES_ID);
    // the rule is stored in the owner's scope only
    expect(await getItem(acct(u), born.id)).toMatchObject({ repeat: { every: "day", interval: 2 } });
  });

  it("a weekly rule on an undated item opens on the first matching day, not on today", async () => {
    await login();
    const today = zoneDay(Date.now(), z);
    const other = (weekdayOf(today) + 3) % 7;
    const it1 = await add({ title: "Midweek thing", repeat: { every: "week", weekdays: [other] } });
    expect(weekdayOf(localDay(it1.dueAt!))).toBe(other);
    expect(it1.repeat!.anchor).toBe(localDay(it1.dueAt!));
  });

  it("a reminder on a recurring open item sets remindBefore; clear_remind deletes it; a reminder later than the due date applies to this copy only (R37)", async () => {
    const u = await login();
    const it1 = await add({ title: "Standup", dueAt: inDays(2, 10), repeat: { every: "day" } });
    let r = await patch(it1.id, { remindAt: inDays(2, 9) });
    let cur = (await r.json()).item as SecItem;
    expect(cur.repeat!.remindBefore).toBe(60);
    expect(cur.remindAt).toBeTruthy();
    r = await patch(it1.id, { remindAt: null });
    cur = (await r.json()).item as SecItem;
    expect("remindBefore" in cur.repeat!).toBe(false);
    expect(cur.remindAt).toBeNull();
    r = await patch(it1.id, { remindAt: inDays(2, 9) });
    expect(((await r.json()).item as SecItem).repeat!.remindBefore).toBe(60);
    // after the due time: this copy only, and the rule's remindBefore goes
    r = await patch(it1.id, { remindAt: inDays(2, 12) });
    cur = (await r.json()).item as SecItem;
    expect(cur.remindAt).toBeTruthy();
    expect("remindBefore" in cur.repeat!).toBe(false);
    // more than a week before: this copy only
    const far = await add({ title: "Monthly", dueAt: inDays(20, 10), repeat: { every: "month" } });
    r = await patch(far.id, { remindAt: inDays(5, 9) });
    cur = (await r.json()).item as SecItem;
    expect(cur.remindAt).toBeTruthy();
    expect("remindBefore" in cur.repeat!).toBe(false);
    // an item without a repeat is not touched by any of this
    const one = await add({ title: "One-off", dueAt: inDays(2, 10) });
    r = await patch(one.id, { remindAt: inDays(2, 9) });
    expect(((await r.json()).item as SecItem).repeat).toBeUndefined();
    expect(await getItem(acct(u), far.id)).toMatchObject({ rev: 2 });
  });

  it("parseRepeat refuses interval 0 or 100, hyear above 10, a past until, count 0 or 1000, weekdays of 8 (repeat_invalid)", () => {
    const now = at("2026-10-03");
    const bad = (v: unknown) => expect(parseRepeat(v, now, z), JSON.stringify(v)).toMatchObject({ ok: false, error: "repeat_invalid", status: 400, field: "repeat" });
    bad({ every: "day", interval: 0 });
    bad({ every: "day", interval: 100 });
    bad({ every: "day", interval: 1.5 });
    bad({ every: "hyear", interval: 11 });
    bad({ every: "day", until: "2026-10-02" });
    bad({ every: "day", until: "2026-02-30" });
    bad({ every: "day", until: "tomorrow" });
    bad({ every: "day", count: 0 });
    bad({ every: "day", count: 1000 });
    bad({ every: "week", weekdays: [8] });
    bad({ every: "week", weekdays: [] });
    bad({ every: "month", monthDay: 32 });
    bad({ every: "hmonth", monthDay: 31 });
    bad({ every: "month", remindBefore: 10081 });
    bad({ every: "month", remindBefore: -1 });
    bad({ every: "fortnight" });
    bad("daily");
    bad([]);
    bad({});
    expect(parseRepeat({ every: "hyear", interval: 10 }, now, z)).toMatchObject({ ok: true, repeat: { every: "hyear", interval: 10 } });
    expect(parseRepeat({ every: "day", interval: 99, until: "2026-10-03", count: 999, remindBefore: 10080 }, now, z)).toMatchObject({ ok: true });
    expect(parseRepeat({ every: "workday", interval: 3 }, now, z)).toMatchObject({ ok: true, repeat: { every: "workday", interval: 1 } });
    expect(parseRepeat({ every: "week", weekdays: [2, 0, 2] }, now, z)).toMatchObject({ ok: true, repeat: { weekdays: [0, 2] } });
    expect(parseRepeat({ every: "month", monthDay: -1 }, now, z)).toMatchObject({ ok: true, repeat: { monthDay: -1 } });
    expect(parseRepeat(null, now, z)).toEqual({ ok: true, repeat: null });
    // the rule's own anchor, week start and time are never read from the input
    expect(parseRepeat({ every: "day", anchor: "2020-01-01", weekStart: 3, time: "03:00" }, now, z)).toEqual({ ok: true, repeat: { every: "day", interval: 1 } });
  });

  it("editing a daily 09:00 item to 14:00 through update makes the next copy 14:00; a reschedule of one copy does not (R53)", async () => {
    const u = await login();
    const it1 = await add({ title: "Daily check", dueAt: inDays(1, 9), repeat: { every: "day" } });
    expect(it1.repeat!.time).toBe("09:00");
    const anchor = it1.repeat!.anchor;
    let r = await patch(it1.id, { action: "reschedule", dueAt: inDays(2, 16) });
    let cur = (await r.json()).item as SecItem;
    expect(cur.repeat).toMatchObject({ time: "09:00", anchor });
    r = await patch(it1.id, { dueAt: inDays(1, 14) });
    cur = (await r.json()).item as SecItem;
    expect(cur.repeat).toMatchObject({ time: "14:00", anchor });
    const cal = defaultCal(z);
    const next = nextOccurrence(cur.repeat!, cur.dueAt!, Date.now(), z, cal, 1)!;
    expect(new Date(Date.parse(next.dueAt) + 3 * HOUR).toISOString().slice(11, 16)).toBe("14:00");
    // an all-day edit drops the time
    r = await patch(it1.id, { dueAt: inDays(1, 0).slice(0, 10) });
    cur = (await r.json()).item as SecItem;
    expect(cur.allDay).toBe(true);
    expect(cur.repeat!.time).toBeUndefined();
    expect((await getItem(acct(u), it1.id))!.repeat).toMatchObject({ every: "day" });
  });

  it("resending the same dueAt after a one-off reschedule keeps the rule's time; a real time change updates it (R53)", async () => {
    await login();
    const it1 = await add({ title: "Daily sync", dueAt: inDays(1, 9), repeat: { every: "day" } });
    let r = await patch(it1.id, { action: "reschedule", dueAt: inDays(2, 16) });
    let cur = (await r.json()).item as SecItem;
    expect(cur.repeat!.time).toBe("09:00");
    // the same dueAt sent again changes nothing about the rule
    r = await patch(it1.id, { dueAt: inDays(2, 16) });
    cur = (await r.json()).item as SecItem;
    expect(cur.repeat!.time).toBe("09:00");
    // a date-only move to the same clock time keeps it too
    r = await patch(it1.id, { dueAt: inDays(3, 16) });
    cur = (await r.json()).item as SecItem;
    expect(cur.repeat!.time).toBe("09:00");
    // a real change of the time of day moves it
    r = await patch(it1.id, { dueAt: inDays(3, 17) });
    cur = (await r.json()).item as SecItem;
    expect(cur.repeat!.time).toBe("17:00");
  });

  it("createItem refuses a repeat from source agent; chat and MCP may set one", async () => {
    const u = await newUser("secagent");
    const r = await createItem(u, { title: "From an agent", repeat: { every: "day" } }, { actor: "dana", via: "chat", source: "agent" });
    expect(r).toMatchObject({ ok: false, error: "owner_only", status: 403, field: "repeat" });
    const ok = await createItem(u, { title: "From chat", dueAt: inDays(1), repeat: { every: "day" } }, { ...chat, source: "chat" });
    expect(ok).toMatchObject({ ok: true });
    const mcp = await createItem(u, { title: "From mcp", dueAt: inDays(1), repeat: { every: "week" } }, { actor: "mcp", via: "mcp", source: "mcp" });
    expect(mcp).toMatchObject({ ok: true });
  });
});

describe("rule 495: skip, stop and ending a series are owner-only", () => {
  it("skip needs todo.close through the PATCH route; a member gets 403", async () => {
    const o = await login();
    const it1 = await add({ title: "Water the plants", dueAt: inDays(1, 9), repeat: { every: "day" } });
    expect(OWNER_ONLY.has("skip")).toBe(true);
    expect(parseOwnerChange({ action: "skip" }, Date.now(), z)).toEqual({ action: "skip" });
    const member = await newMember(o, "member", "secrepm");
    await signIn(member.email);
    const r = await patch(it1.id, { action: "skip" });
    expect(r.status).toBe(403);
    expect(await getItem(acct(o), it1.id)).toMatchObject({ completedAt: null, rev: 1 });
    await signIn(o.email);
    expect((await patch(it1.id, { action: "skip" })).status).toBe(200);
  });

  it("skip closes with SKIP_RESULT and sets closedBy; it needs a repeat; delete ends the series and opens nothing", async () => {
    const o = await login();
    const it1 = await add({ title: "Water the plants", dueAt: inDays(1, 9), repeat: { every: "day" } });
    const plain = await add({ title: "No repeat", dueAt: inDays(1, 9) });
    const bad = await patch(plain.id, { action: "skip" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "bad_action" });
    const r = await patch(it1.id, { action: "skip" });
    const cur = (await r.json()).item as SecItem;
    expect(cur).toMatchObject({ result: SKIP_RESULT, closedBy: { actor: "owner", login: o.email }, proposedDone: null, snoozeUntil: null });
    expect(cur.completedAt).toBeTruthy();
    expect(SKIP_RESULT).toBe("skipped");
    // The skipped copy is the series' closed copy (rule 496).
    expect(await db.zrangeWithScores(SEC_KEYS.series(acct(o), cur.series!.id))).toEqual([{ member: it1.id, score: Date.parse(cur.completedAt!) }]);
    // The skip opened the next copy of that series (rule 497).
    const skipNext = (await getItem(acct(o), cur.nextId!))!;
    expect(skipNext).toMatchObject({ series: { id: cur.series!.id, n: 2 }, completedAt: null, deletedAt: null });
    // delete: the copy goes, nothing else opens, and it never joins the series' closed copies
    const d = await add({ title: "Delete me", dueAt: inDays(1, 9), repeat: { every: "day" } });
    const deleted = (await (await patch(d.id, { action: "delete" })).json()).item as SecItem;
    expect(deleted.nextId).toBeUndefined();
    expect(await db.get(SEC_KEYS.spawn(acct(o), d.id))).toBeNull();
    expect(await db.zrangeWithScores(SEC_KEYS.series(acct(o), d.series!.id))).toEqual([]);
    expect(await db.smembers(SEC_KEYS.seriesList(acct(o)))).toEqual([cur.series!.id]);
    const open = await listOpenItems(acct(o));
    expect(open.map((x) => x.id).sort()).toEqual([plain.id, skipNext.id].sort());
    expect(open.filter((x) => x.series?.id === d.series!.id)).toEqual([]);
  });

  it("closedBy is set by complete and confirm_done and cleared by reopen, and the audit line carries repeat and closedBy", async () => {
    const o = await login();
    const a = await add({ title: "A", dueAt: inDays(1), repeat: { every: "day" } });
    const r1 = await patch(a.id, { action: "complete", result: "done" });
    expect(((await r1.json()).item as SecItem).closedBy).toEqual({ actor: "owner", login: o.email });
    const r2 = await patch(a.id, { action: "reopen" });
    expect("closedBy" in ((await r2.json()).item as SecItem)).toBe(false);
    const b = await add({ title: "B", dueAt: inDays(1) });
    await changeItem(acct(o), b.id, { action: "propose_done", evidence: "it is done" }, chat);
    const r3 = await patch(b.id, { action: "confirm_done" });
    expect(((await r3.json()).item as SecItem).closedBy).toMatchObject({ actor: "owner" });
    const log = (await db.lrange(SEC_KEYS.audit(acct(o)), 0, -1)).map((x) => JSON.parse(x));
    expect(log.find((l) => l.id === a.id && l.action === "complete").diff).toContain("closedBy=");
    expect(log.find((l) => l.id === a.id && l.action === "create").diff).toContain("title=");
  });

  it("stop_repeat on the page needs todo.write and keeps series for the CSV", async () => {
    const o = await login();
    const it1 = await add({ title: "Weekly", dueAt: inDays(1, 9), repeat: { every: "week" } });
    const plain = await add({ title: "Plain", dueAt: inDays(1, 9) });
    const member = await newMember(o, "member", "secrepm2");
    await signIn(member.email);
    expect((await patch(plain.id, { action: "stop_repeat" })).status).toBe(400);
    const r = await patch(it1.id, { action: "stop_repeat" });
    const cur = (await r.json()).item as SecItem;
    expect(r.status).toBe(200);
    expect(cur.repeat).toBeNull();
    expect(cur.series).toMatchObject({ n: 1 });
    expect(cur.series!.id).toMatch(SERIES_ID);
    expect(OWNER_ONLY.has("stop_repeat")).toBe(false);
    expect(parseOwnerChange({ action: "stop_repeat" }, Date.now(), z)).toEqual({ action: "stop_repeat" });
  });

  it("from chat or MCP, stop_repeat, an early until and count <= n answer owner_only", async () => {
    const o = await login();
    const it1 = await add({ title: "Weekly", dueAt: inDays(2, 9), repeat: { every: "day" } });
    const cal = defaultCal(z);
    const expectOwner = async (c: Parameters<typeof changeItem>[2]) => {
      const r = await changeItem(acct(o), it1.id, c, chat, undefined, z, cal);
      expect(r, JSON.stringify(c)).toMatchObject({ ok: false, error: "owner_only", status: 403, field: "repeat" });
    };
    await expectOwner({ action: "stop_repeat" });
    await expectOwner({ action: "update", fields: { repeat: null } });
    await expectOwner({ action: "update", fields: { repeat: { every: "day", interval: 1, count: 1 } } });
    await expectOwner({ action: "update", fields: { repeat: { every: "day", interval: 1, until: zoneDay(Date.now(), z) } } });
    expect(await getItem(acct(o), it1.id)).toMatchObject({ rev: 1, repeat: { every: "day" } });
    // a count or until that still leaves the next copy is fine, and so is another cadence
    const ok = await changeItem(acct(o), it1.id, { action: "update", fields: { repeat: { every: "day", interval: 1, count: 5, until: zoneDay(Date.now() + 30 * 864e5, z) } } }, chat, undefined, z, cal);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.ok && ok.item.series!.id).toBe(it1.series!.id);
    const wk = await changeItem(acct(o), it1.id, { action: "update", fields: { repeat: { every: "week", interval: 2 } } }, { actor: "mcp", via: "mcp" }, undefined, z, cal);
    expect(wk).toMatchObject({ ok: true });
    // the owner in the app may do all of it
    const mine = mutateItem(structuredClone(it1), { action: "update", fields: { repeat: { every: "day", interval: 1, count: 1 } } }, web, Date.now(), z, cal);
    expect(mine).toMatchObject({ ok: true });
  });

  it("repeat null from chat on an item with no repeat is a harmless no-op (R39)", async () => {
    const o = await login();
    const plain = await add({ title: "One-off", dueAt: inDays(2, 9) });
    const r = await changeItem(acct(o), plain.id, { action: "update", fields: { repeat: null, priority: 1 } }, chat, undefined, z, defaultCal(z));
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.item.repeat).toBeNull();
  });

  it("a new repeat rule keeps the old reminder unless the input sets one", async () => {
    const o = await login();
    const it1 = await add({ title: "Standup", dueAt: inDays(2, 10), repeat: { every: "day" } });
    let r = await patch(it1.id, { remindAt: inDays(2, 9) });
    expect(((await r.json()).item as SecItem).repeat!.remindBefore).toBe(60);
    r = await patch(it1.id, { repeat: { every: "week" } });
    const cur = (await r.json()).item as SecItem;
    expect(cur.repeat).toMatchObject({ every: "week", remindBefore: 60 });
    // an explicit value in the input wins
    r = await patch(it1.id, { repeat: { every: "week", remindBefore: 15 } });
    expect(((await r.json()).item as SecItem).repeat!.remindBefore).toBe(15);
    expect(await getItem(acct(o), it1.id)).toMatchObject({ repeat: { remindBefore: 15 } });
  });

  it("the word for a skipped result is translated wherever a result is shown", async () => {
    expect(resultText(SKIP_RESULT, "ar")).toBe("تخطيت هالمرة");
    expect(resultText(SKIP_RESULT, "en")).toBe("Skipped this time");
    expect(resultText("sent the invoice", "ar")).toBe("sent the invoice");
    expect(resultText(null, "en")).toBe("");
    expect(appDict.ar.todo.skipped).toBe(resultText(SKIP_RESULT, "ar"));
    expect(appDict.en.todo.skipped).toBe(resultText(SKIP_RESULT, "en"));
    const o = await login();
    const it1 = await add({ title: "Skipped one", dueAt: inDays(1), repeat: { every: "day" } });
    await patch(it1.id, { action: "skip" });
    const t = await runSecretaryTool(o, "agenda_get", { include_done: true }, { who: chat, lang: "en" });
    expect(t.text).toContain("Skipped this time");
    expect(t.text).not.toContain("result: \"skipped\"");
    // The evening wrap names a skipped copy in words too.
    const w: Wrap = { day: zoneDay(Date.now(), z), zone: z, completed: [{ title: "Skipped one", result: SKIP_RESULT, auto: false }], approved: 0, rejected: 0, fellOverdue: [], tomorrow: [], tomorrowAt: Date.now() };
    expect(wrapText(w, "en").body).toContain("«Skipped one»: Skipped this time");
    expect(wrapText(w, "ar").body).toContain("«Skipped one»: تخطيت هالمرة");
  });

  it("every new error has a tool sentence and both page sentences; the owner_only sentence names stopping a repeat", async () => {
    const o = await login();
    const it1 = await add({ title: "x", dueAt: inDays(1), repeat: { every: "day" } });
    const r = await runSecretaryTool(o, "todo_update", { id: it1.id, clear_due: true }, { who: chat, lang: "en" });
    expect(r.text).toMatch(/needs a due date/);
    for (const lang of ["ar", "en"] as const) {
      const e = appDict[lang].todo.errors;
      for (const k of ["repeat_invalid", "repeat_needs_due", "repeat_until_before_due", "keep_limit", "owner_only"]) expect(e[k], `${lang} ${k}`).toBeTruthy();
    }
    const stop = await changeItem(acct(o), it1.id, { action: "stop_repeat" }, chat);
    expect(stop.ok).toBe(false);
    if (!stop.ok) {
      const { toolError } = await import("@/lib/secretary");
      expect(toolError(stop)).toContain("stop or end a repeat");
    }
    expect(newSeriesId()).toMatch(SERIES_ID);
    expect(newSeriesId()).not.toBe(newSeriesId());
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Task 5: the next copy, on every close path (rules 497, 498, 499).

const owner = (email: string) => ({ actor: "owner", via: "web", login: email }) as const;
const done = async (id: string) => {
  const r = await patch(id, { action: "complete", result: "ok" });
  const j = await r.json();
  expect(r.status, JSON.stringify(j)).toBe(200);
  return j.item as SecItem;
};
const reopen = async (id: string) => {
  const r = await patch(id, { action: "reopen" });
  const j = await r.json();
  expect(r.status, JSON.stringify(j)).toBe(200);
  return j.item as SecItem;
};
const daily = (title = "Daily", hh = 9) => add({ title, dueAt: inDays(1, hh), repeat: { every: "day" } });
const openOf = async (scope: string) => (await listOpenItems(scope)).map((x) => x.id).sort();
const auditOf = async (scope: string) => (await db.lrange(SEC_KEYS.audit(scope), 0, -1)).map((x) => JSON.parse(x) as { action: string; actor: string; id: string; diff: string });
const ORPHAN = "s0123456789abcdef";
const record = (o: Partial<SecItem> = {}): SecItem => ({
  id: ORPHAN, kind: "task", title: "Orphan", description: "", result: null, direction: "i_owe", owedBy: "owner", owedTo: null,
  dueAt: new Date(Date.now() + 3 * 864e5).toISOString(), allDay: false, snoozeUntil: null, priority: 1, critical: false, links: {}, source: "owner", notes: [],
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, rev: 1, ...o,
});
const twoOpen = (it: SecItem) => it.notes.filter((n) => n.kind === "two_open");

describe("rule 497: exactly one next copy", () => {
  it("a pre-seeded claim plus an orphan record: the spawn reuses that exact id and overwrites nothing", async () => {
    const o = await login();
    const a = await daily();
    const orphan = record();
    await Promise.all([db.set(SEC_KEYS.item(acct(o), ORPHAN), orphan), db.setNx(SEC_KEYS.spawn(acct(o), a.id), ORPHAN, 172800)]);
    const closed = await done(a.id);
    expect(closed.nextId).toBe(ORPHAN);
    expect(await getItem(acct(o), ORPHAN)).toEqual(orphan);
    expect(await db.get(SEC_KEYS.spawn(acct(o), a.id))).toBe(ORPHAN);
    expect(await openOf(acct(o))).toEqual([ORPHAN]);
  });

  it("a pre-seeded claim naming a soft-deleted record is stale: a new id is minted and the claim overwritten", async () => {
    const o = await login();
    const a = await daily();
    const dead = record({ deletedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() });
    await Promise.all([db.set(SEC_KEYS.item(acct(o), ORPHAN), dead), db.setNx(SEC_KEYS.spawn(acct(o), a.id), ORPHAN, 172800)]);
    const closed = await done(a.id);
    expect(closed.nextId).toMatch(/^s[a-f0-9]{16}$/);
    expect(closed.nextId).not.toBe(ORPHAN);
    expect(await db.get(SEC_KEYS.spawn(acct(o), a.id))).toBe(closed.nextId);
    expect(await getItem(acct(o), ORPHAN)).toEqual(dead);
    expect(await getItem(acct(o), closed.nextId!)).toMatchObject({ completedAt: null, deletedAt: null, series: { id: a.series!.id, n: 2 } });
    expect(await openOf(acct(o))).toEqual([closed.nextId]);
  });

  it("a failure after round 1 (nextId set, no new copy) and a retry give one copy at the claimed id", async () => {
    const o = await login();
    const a = await daily();
    const set = db.set.bind(db);
    let failed = 0;
    const spy = vi.spyOn(db, "set").mockImplementation(async (key: string, value: unknown, ttl?: number) => {
      if (key.startsWith(`sec:item:${acct(o)}:`) && key !== SEC_KEYS.item(acct(o), a.id) && !failed++) throw new Error("killed");
      return set(key, value, ttl);
    });
    const close = () => changeItem(acct(o), a.id, { action: "complete", result: "ok" }, owner(o.email), undefined, z, defaultCal(z));
    await expect(close()).rejects.toThrow("killed");
    spy.mockRestore();
    // Round 1 landed: the closed copy names the claimed id, whose record does not exist. Nothing shows twice.
    const half = (await getItem(acct(o), a.id))!;
    const claimed = await db.get<string>(SEC_KEYS.spawn(acct(o), a.id));
    expect(half.completedAt).toBeTruthy();
    expect(half.nextId).toBe(claimed);
    expect(await getItem(acct(o), claimed!)).toBeNull();
    expect(await openOf(acct(o))).toEqual([]);
    // The retry opens the copy at that id.
    const r = await close();
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.item.nextId).toBe(claimed);
    expect(await getItem(acct(o), claimed!)).toMatchObject({ completedAt: null, series: { id: a.series!.id, n: 2 }, rev: 1 });
    expect(await openOf(acct(o))).toEqual([claimed]);
    // Once the next copy is alive, a further close is the usual 409 and opens nothing.
    expect(await close()).toMatchObject({ ok: false, error: "completed", status: 409 });
    expect(await openOf(acct(o))).toEqual([claimed]);
    expect(await getItem(acct(o), a.id)).toMatchObject({ result: "ok", nextId: claimed });
  });

  it("reopen then re-close within 2 days opens a new id, and sec:deleted holds no open item", async () => {
    const o = await login();
    const a = await daily();
    const b = (await done(a.id)).nextId!;
    const re = await reopen(a.id);
    expect(re.nextId).toBeUndefined();
    expect(await db.get(SEC_KEYS.spawn(acct(o), a.id))).toBeNull();
    const c = (await done(a.id)).nextId!;
    expect(c).toMatch(/^s[a-f0-9]{16}$/);
    expect(c).not.toBe(b);
    expect(await openOf(acct(o))).toEqual([c]);
    const del = (await db.zrangeWithScores(SEC_KEYS.deleted(acct(o)))).map((m) => m.member);
    expect(del).toEqual([b]);
    const rows = await Promise.all(del.map((id) => getItem(acct(o), id)));
    expect(rows.every((x) => !!x?.deletedAt && !x.completedAt)).toBe(true);
    expect(await getItem(acct(o), c)).toMatchObject({ deletedAt: null, completedAt: null, series: { n: 2 } });
  });

  it("a re-close while the next copy is alive opens nothing", async () => {
    const o = await login();
    const a = await daily();
    const b = (await done(a.id)).nextId!;
    const c = (await done(b)).nextId!;
    // B is done, so the reopen of A keeps it (and its own next copy C stays open).
    expect((await reopen(a.id)).nextId).toBe(b);
    const again = await done(a.id);
    expect(again.nextId).toBe(b);
    expect(await openOf(acct(o))).toEqual([c]);
    expect(await db.smembers(SEC_KEYS.all(acct(o)))).toHaveLength(3);
  });

  it("nextId naming a missing record spawns again", async () => {
    const o = await login();
    const MISSING = "s00000000000000ff";
    const a = await daily();
    await db.set(SEC_KEYS.item(acct(o), a.id), { ...(await getItem(acct(o), a.id))!, nextId: MISSING });
    const closed = await done(a.id);
    expect(closed.nextId).toMatch(/^s[a-f0-9]{16}$/);
    expect(await getItem(acct(o), closed.nextId!)).toMatchObject({ completedAt: null, title: "Daily", series: { id: a.series!.id, n: 2 } });
    expect(await openOf(acct(o))).toEqual([closed.nextId]);
    // With a claim naming that missing record, the claimed id is the one used.
    const a2 = await daily("Second");
    await Promise.all([db.set(SEC_KEYS.item(acct(o), a2.id), { ...(await getItem(acct(o), a2.id))!, nextId: MISSING }), db.setNx(SEC_KEYS.spawn(acct(o), a2.id), MISSING, 172800)]);
    expect((await done(a2.id)).nextId).toBe(MISSING);
    expect(await getItem(acct(o), MISSING)).toMatchObject({ title: "Second", completedAt: null, series: { id: a2.series!.id, n: 2 } });
  });

  it("two concurrent complete calls: one wins, the other answers completed 409, and there is one next copy", async () => {
    const o = await login();
    const a = await daily();
    const rs = await Promise.all([patch(a.id, { action: "complete", result: "one" }), patch(a.id, { action: "complete", result: "two" })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const bodies = await Promise.all(rs.map((r) => r.json()));
    expect(bodies.find((b) => !b.ok)).toMatchObject({ error: "completed" });
    const open = await listOpenItems(acct(o));
    expect(open).toHaveLength(1);
    expect(open[0].series).toEqual({ id: a.series!.id, n: 2 });
    expect((await auditOf(acct(o))).filter((l) => l.action === "spawn")).toHaveLength(1);
  });

  it("a soft-deleted next copy: the owner's re-close of the done copy opens a new one; while the next copy is alive it is 409", async () => {
    const o = await login();
    const a = await daily();
    const b = (await done(a.id)).nextId!;
    // The next copy is alive: a re-close is the usual 409 and opens nothing.
    const alive = await patch(a.id, { action: "complete", result: "again" });
    expect(alive.status).toBe(409);
    expect(await alive.json()).toMatchObject({ error: "completed" });
    expect(await openOf(acct(o))).toEqual([b]);
    // The owner deletes the next copy; the re-close finishes the spawn at a new id and answers 200.
    expect((await patch(b, { action: "delete" })).status).toBe(200);
    expect(await openOf(acct(o))).toEqual([]);
    const again = await done(a.id);
    const c = again.nextId!;
    expect(c).toMatch(/^s[a-f0-9]{16}$/);
    expect(c).not.toBe(b);
    expect(again.result).toBe("ok");
    expect(await db.get(SEC_KEYS.spawn(acct(o), a.id))).toBe(c);
    expect(await getItem(acct(o), c)).toMatchObject({ completedAt: null, deletedAt: null, series: { id: a.series!.id, n: 2 } });
    expect((await getItem(acct(o), b))!.deletedAt).toBeTruthy();
    expect(await getItem(acct(o), a.id)).toMatchObject({ nextId: c });
    expect(await openOf(acct(o))).toEqual([c]);
    // With the new copy alive, a further re-close is 409 again and opens nothing.
    expect((await patch(a.id, { action: "complete", result: "third" })).status).toBe(409);
    expect(await openOf(acct(o))).toEqual([c]);
  });

  it("closing the last copy of a count series opens nothing", async () => {
    const o = await login();
    const a = await add({ title: "Twice", dueAt: inDays(1, 9), repeat: { every: "day", count: 2 } });
    const b = (await done(a.id)).nextId!;
    expect(await getItem(acct(o), b)).toMatchObject({ completedAt: null, series: { id: a.series!.id, n: 2 } });
    const last = await done(b);
    expect(last.nextId).toBeUndefined();
    expect(await db.get(SEC_KEYS.spawn(acct(o), b))).toBeNull();
    expect(await openOf(acct(o))).toEqual([]);
    expect(await db.smembers(SEC_KEYS.all(acct(o)))).toHaveLength(2);
    expect((await auditOf(acct(o))).filter((l) => l.action === "spawn")).toHaveLength(1);
  });

  it("a spawn checks neither the open-items cap nor the create allowance (R40)", async () => {
    const o = await login();
    const a = await daily();
    const fill = Array.from({ length: SEC_OPEN_MAX - 1 }, (_, i) => `x${i}`);
    await Promise.all(fill.map((m, i) => db.zadd(SEC_KEYS.open(acct(o)), Date.now() + i, m)));
    expect(await db.zcard(SEC_KEYS.open(acct(o)))).toBe(SEC_OPEN_MAX);
    const rate = `rate:sec:create:${o.email}`;
    const before = await db.get(rate);
    const b = (await done(a.id)).nextId!;
    expect(await getItem(acct(o), b)).toMatchObject({ completedAt: null, deletedAt: null, series: { id: a.series!.id, n: 2 } });
    expect(await db.zcard(SEC_KEYS.open(acct(o)))).toBe(SEC_OPEN_MAX);
    expect(await db.get(rate)).toEqual(before);
  });
});

describe("rule 498: what the next copy carries", () => {
  it("links, notes, result, proposedDone and closedBy are not copied; expectBy is null; the date and time come from the rule", async () => {
    const o = await login();
    const a = await add({ title: "Call the team", description: "Weekly numbers", kind: "follow_up", dueAt: inDays(1, 9), priority: 2, critical: true, repeat: { every: "day" } });
    const stored = (await getItem(acct(o), a.id))!;
    await db.set(SEC_KEYS.item(acct(o), a.id), {
      ...stored, links: { taskId: "abcdef0123456789" }, notes: [{ at: stored.createdAt, by: "owner", text: "a note", private: false }],
      snoozeUntil: new Date(Date.now() + HOUR).toISOString(), lastChasedAt: stored.createdAt, handoffFrom: "sami", expectBy: new Date(Date.now() + 864e5).toISOString(),
      proposedDone: { at: stored.createdAt, by: "reem", evidence: "it was done" },
    });
    const closed = await changeItem(acct(o), a.id, { action: "confirm_done", result: "called" }, owner(o.email), undefined, z, defaultCal(z));
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.item).toMatchObject({ result: "called", closedBy: { actor: "owner", login: o.email } });
    const n = (await getItem(acct(o), closed.item.nextId!))!;
    expect(n).toMatchObject({
      title: "Call the team", description: "Weekly numbers", kind: "follow_up", direction: "i_owe", owedBy: "owner", priority: 2, critical: true, source: "owner", rev: 1,
      result: null, links: {}, notes: [], proposedDone: null, snoozeUntil: null, lastChasedAt: null, expectBy: null, completedAt: null, deletedAt: null, expiresAt: null, remindAt: null,
      allDay: false, series: { id: a.series!.id, n: 2 }, repeat: stored.repeat,
    });
    for (const k of ["closedBy", "handoffFrom", "nextId"]) expect(k in n, k).toBe(false);
    expect(localDay(n.dueAt!)).toBe(zoneDay(Date.now() + 2 * 864e5, z));
    expect(new Date(Date.parse(n.dueAt!) + 3 * HOUR).toISOString().slice(11, 16)).toBe("09:00");
    expect(Math.abs(Date.parse(n.createdAt) - Date.now())).toBeLessThan(60_000);
    expect((await auditOf(acct(o))).find((l) => l.action === "spawn")).toMatchObject({ actor: "rule", id: n.id });
  });

  it("closeLinked opens the next copy too, and the copy carries no link, so it does not close again", async () => {
    const o = await login();
    const task: Task = { id: "abababababab0001", type: "social", channel: "instagram", title: "Post", body: "b", status: "pending", createdAt: new Date().toISOString(), lang: "ar" };
    await saveTask(acct(o), task, true);
    const a = await add({ title: "Wait for the post", dueAt: inDays(1, 9), taskId: task.id, repeat: { every: "day" } });
    await updateTask(acct(o), task.id, (t) => ({ ...t, status: "approved" }));
    expect((await agendaFor(acct(o))).closed).toBe(1);
    const closed = (await getItem(acct(o), a.id))!;
    expect(closed).toMatchObject({ result: AUTO_CLOSE_RESULT, closedBy: { actor: "rule" } });
    const n = (await getItem(acct(o), closed.nextId!))!;
    expect(n).toMatchObject({ links: {}, completedAt: null, series: { id: a.series!.id, n: 2 } });
    expect((await agendaFor(acct(o))).closed).toBe(0);
    expect(await openOf(acct(o))).toEqual([n.id]);
  });

  it("a reminder fires, then complete: the next copy has a reminder at remindBefore", async () => {
    const o = await login();
    const a = await add({ title: "Standup", dueAt: inDays(1, 10), repeat: { every: "day" } });
    const withRem = (await (await patch(a.id, { remindAt: inDays(1, 9) })).json()).item as SecItem;
    expect(withRem.repeat!.remindBefore).toBe(60);
    expect(await fireReminder(acct(o), a.id, Date.parse(withRem.remindAt!), null, async () => {})).toMatchObject({ remindAt: withRem.remindAt });
    expect(await getItem(acct(o), a.id)).toMatchObject({ remindAt: null, repeat: { remindBefore: 60 } });
    const n = (await getItem(acct(o), (await done(a.id)).nextId!))!;
    expect(n.repeat!.remindBefore).toBe(60);
    expect(Date.parse(n.dueAt!) - Date.parse(n.remindAt!)).toBe(60 * 60_000);
    expect(await db.zrangeWithScores(SEC_KEYS.due(acct(o)))).toEqual([{ member: n.id, score: Date.parse(n.remindAt!) }]);
  });

  it("clear_remind, then complete: the next copy has none", async () => {
    const o = await login();
    const a = await add({ title: "Standup", dueAt: inDays(1, 10), repeat: { every: "day" } });
    await patch(a.id, { remindAt: inDays(1, 9) });
    const t = await runSecretaryTool(o, "todo_update", { id: a.id, clear_remind: true }, { who: chat, lang: "en" });
    expect(t.isError).toBe(false);
    expect("remindBefore" in (await getItem(acct(o), a.id))!.repeat!).toBe(false);
    const n = (await getItem(acct(o), (await done(a.id)).nextId!))!;
    expect(n.remindAt).toBeNull();
    expect(await db.zrangeWithScores(SEC_KEYS.due(acct(o)))).toEqual([]);
  });

  it("closing a weekly copy 3 weeks late opens one copy at the next date", async () => {
    const o = await login();
    const start = zoneDay(Date.now() - 21 * 864e5, z);
    const a = await add({ title: "Weekly", dueAt: `${start}T09:00`, repeat: { every: "week" } });
    const closed = await done(a.id);
    const open = await listOpenItems(acct(o));
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(closed.nextId);
    let k = 1;
    while (at(addDays(start, 7 * k), "09:00") <= Date.now()) k++;
    expect(localDay(open[0].dueAt!)).toBe(addDays(start, 7 * k));
    expect(open[0].series).toEqual({ id: a.series!.id, n: 2 });
  });
});

describe("rule 499: reopen and the next copy", () => {
  it("an untouched next copy is deleted, audit series_reopen by rule", async () => {
    const o = await login();
    const a = await daily();
    const b = (await done(a.id)).nextId!;
    const re = await reopen(a.id);
    expect(re.nextId).toBeUndefined();
    expect(twoOpen(re)).toEqual([]);
    expect(await db.get(SEC_KEYS.spawn(acct(o), a.id))).toBeNull();
    expect((await getItem(acct(o), b))!.deletedAt).toBeTruthy();
    expect(await openOf(acct(o))).toEqual([a.id]);
    expect((await auditOf(acct(o))).find((l) => l.action === "series_reopen")).toMatchObject({ actor: "rule", id: b });
  });

  it("a next copy whose reminder already fired is still untouched (R35)", async () => {
    const o = await login();
    const a = await add({ title: "Standup", dueAt: inDays(1, 10), repeat: { every: "day" } });
    await patch(a.id, { remindAt: inDays(1, 9) });
    const b = (await getItem(acct(o), (await done(a.id)).nextId!))!;
    expect(b.remindAt).toBeTruthy();
    await fireReminder(acct(o), b.id, Date.parse(b.remindAt!), null, async () => {});
    expect(await getItem(acct(o), b.id)).toMatchObject({ rev: 2, remindAt: null });
    await reopen(a.id);
    expect((await getItem(acct(o), b.id))!.deletedAt).toBeTruthy();
    expect(await openOf(acct(o))).toEqual([a.id]);
  });

  it("an edited next copy stays: two open copies, the two_open note, nextId and the claim kept (R34)", async () => {
    const o = await login();
    const a = await daily();
    const b = (await done(a.id)).nextId!;
    expect((await patch(b, { title: "Daily, moved" })).status).toBe(200);
    const re = await reopen(a.id);
    expect(re.nextId).toBe(b);
    expect(await db.get(SEC_KEYS.spawn(acct(o), a.id))).toBe(b);
    expect(twoOpen(re)).toHaveLength(1);
    expect(noteText(twoOpen(re)[0], "ar")).toContain("نسختان");
    expect(await openOf(acct(o))).toEqual([a.id, b].sort());
    expect(await getItem(acct(o), b)).toMatchObject({ rev: 2, title: "Daily, moved", deletedAt: null });
    expect((await auditOf(acct(o))).some((l) => l.action === "series_reopen")).toBe(false);
  });

  it("closing the reopened copy again then opens nothing", async () => {
    const o = await login();
    const a = await daily();
    const b = (await done(a.id)).nextId!;
    await patch(b, { title: "Daily, moved" });
    await reopen(a.id);
    expect(await openOf(acct(o))).toEqual([a.id, b].sort());
    expect((await done(a.id)).nextId).toBe(b);
    expect(await openOf(acct(o))).toEqual([b]);
    expect(await db.smembers(SEC_KEYS.all(acct(o)))).toHaveLength(2);
  });

  it("A → B (done) → C (open): reopening A leaves A and C open and writes the two_open note (R49)", async () => {
    const o = await login();
    const a = await daily();
    const b = (await done(a.id)).nextId!;
    const c = (await done(b)).nextId!;
    const re = await reopen(a.id);
    expect(re.nextId).toBe(b);
    expect(twoOpen(re)).toHaveLength(1);
    expect(await openOf(acct(o))).toEqual([a.id, c].sort());
    expect(await getItem(acct(o), b)).toMatchObject({ deletedAt: null, nextId: c });
  });

  it("a lock timeout on the next copy answers 503, writes nothing, and keeps nextId and the claim (R48)", async () => {
    const o = await login();
    const a = await daily();
    const b = (await done(a.id)).nextId!;
    const before = (await getItem(acct(o), a.id))!;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    try {
      expect(await db.lock(SEC_KEYS.lock(acct(o), b), 30)).toBe(true);
      const p = patch(a.id, { action: "reopen" });
      await vi.advanceTimersByTimeAsync(4000);
      const r = await p;
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ ok: false, error: "lock_timeout" });
    } finally {
      vi.useRealTimers();
    }
    await db.unlock(SEC_KEYS.lock(acct(o), b));
    expect(await getItem(acct(o), a.id)).toEqual(before);
    expect(await db.get(SEC_KEYS.spawn(acct(o), a.id))).toBe(b);
    expect(await getItem(acct(o), b)).toMatchObject({ rev: 1, deletedAt: null });
    // A failed read of the next copy fails closed the same way.
    const get = db.get.bind(db);
    const spy = vi.spyOn(db, "get").mockImplementation((async (key: string) => {
      if (key === SEC_KEYS.item(acct(o), b)) throw new Error("down");
      return get(key);
    }) as typeof db.get);
    const r2 = await patch(a.id, { action: "reopen" });
    spy.mockRestore();
    expect(r2.status).toBe(503);
    expect(await getItem(acct(o), a.id)).toEqual(before);
    expect(await getItem(acct(o), b)).toMatchObject({ rev: 1, deletedAt: null });
  });

  it("at the open-items cap, reopening A with an untouched open B succeeds (R52)", async () => {
    const o = await login();
    const a = await daily("Untouched next");
    const b = (await done(a.id)).nextId!;
    const a2 = await daily("Edited next");
    const b2 = (await done(a2.id)).nextId!;
    await patch(b2, { title: "Edited next, moved" });
    const fill = Array.from({ length: SEC_OPEN_MAX - 2 }, (_, i) => `x${i}`);
    await Promise.all(fill.map((m, i) => db.zadd(SEC_KEYS.open(acct(o)), Date.now() + i, m)));
    expect(await db.zcard(SEC_KEYS.open(acct(o)))).toBe(SEC_OPEN_MAX);
    // An edited next copy stays, so that reopen would add an open item: the cap refuses it and nothing changes.
    const refused = await patch(a2.id, { action: "reopen" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "open_limit" });
    expect(await getItem(acct(o), a2.id)).toMatchObject({ nextId: b2 });
    expect((await getItem(acct(o), a2.id))!.completedAt).toBeTruthy();
    // An untouched one is deleted: the open count does not change.
    await reopen(a.id);
    expect((await getItem(acct(o), b))!.deletedAt).toBeTruthy();
    expect(await db.zcard(SEC_KEYS.open(acct(o)))).toBe(SEC_OPEN_MAX);
  });
});

describe("rule 500: who may set a repeat through chat and MCP", () => {
  const noor = { actor: "noor", via: "chat" } as const;
  const mcp = { actor: "mcp", via: "mcp" } as const;
  const bucket = (email: string) => `rate:sec:write:${email}`;

  it("Noor's todo_create with repeat is refused, saves nothing and leaves rate:sec:write null", async () => {
    const u = await login();
    const r = await runSecretaryTool(u, "todo_create", { title: "Weekly", due: inDays(1, 9), repeat: { every: "week" } }, { who: noor, lang: "en", agent: "noor" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Not done: only the owner or Reem sets a repeat. Nothing was saved.");
    expect(await listOpenItems(acct(u))).toHaveLength(0);
    expect(await db.get(bucket(acct(u)))).toBeNull();
    const ar = await runSecretaryTool(u, "todo_update", { id: "s0123456789abcdef", repeat: null }, { who: noor, lang: "ar", agent: "noor" });
    expect(ar.text).toContain("لم يتم: التكرار يضبطه المالك أو ريم");
    expect(await db.get(bucket(acct(u)))).toBeNull();
  });

  it("an agent that is not named is refused too, and a plain call without repeat still works for Noor", async () => {
    const u = await login();
    const none = await runSecretaryTool(u, "todo_create", { title: "x", due: inDays(1), repeat: { every: "day" } }, { who: { actor: "reem", via: "chat" }, lang: "en" });
    expect(none.isError).toBe(true);
    expect(await db.get(bucket(acct(u)))).toBeNull();
    const ok = await runSecretaryTool(u, "todo_create", { title: "Plain", due: inDays(1) }, { who: noor, lang: "en", agent: "noor" });
    expect(ok.isError).toBe(false);
  });

  it("ask_noor (via MCP, agent noor, runTool) is refused the same way", async () => {
    const u = await login();
    const out = await runTool(u, "todo_create", { title: "Weekly", due: inDays(1, 9), repeat: { every: "week" } }, [], [], undefined, { agent: "noor", via: "mcp", lang: "en" });
    expect(out).toContain("only the owner or Reem sets a repeat");
    expect(await listOpenItems(acct(u))).toHaveLength(0);
    expect(await db.get(bucket(acct(u)))).toBeNull();
  });

  it("Reem in chat sets a repeat and the answer says the rule", async () => {
    const u = await login();
    const actions: string[] = [];
    const out = await runTool(u, "todo_create", { title: "Report", due: inDays(1, 9), repeat: { every: "week", interval: 2, weekdays: [0, 2], month_day: 5, remind_before: 60 } }, actions, [], undefined, { agent: "reem", lang: "en" });
    expect(out).toContain("Repeats: Repeats every 2 weeks on Sunday and Tuesday at 09:00");
    const [it1] = await listOpenItems(acct(u));
    expect(it1.repeat).toMatchObject({ every: "week", interval: 2, weekdays: [0, 2], time: "09:00", remindBefore: 60 });
    expect(it1.repeat).not.toHaveProperty("monthDay");
    expect(it1.repeat).not.toHaveProperty("month_day");
    const line = await runSecretaryTool(u, "agenda_get", {}, { who: chat, lang: "en", agent: "reem" });
    expect(line.text).toContain("repeats: Repeats every 2 weeks on Sunday and Tuesday at 09:00");
  });

  it("the owner's MCP assistant sets and changes a repeat, and a bad rule saves nothing", async () => {
    const u = await login();
    const c = await runSecretaryTool(u, "todo_create", { title: "Monthly", due: inDays(1, 9), repeat: { every: "month", month_day: -1 } }, { who: mcp, lang: "en" });
    expect(c.isError, c.text).toBe(false);
    expect(c.text).toContain("Repeats every month on the last day");
    const id = c.id!;
    const up = await runSecretaryTool(u, "todo_update", { id, repeat: { every: "day", interval: 3 } }, { who: mcp, lang: "en" });
    expect(up.isError, up.text).toBe(false);
    expect(up.text).toContain("repeats: Repeats every 3 days");
    const bad = await runSecretaryTool(u, "todo_update", { id, repeat: { every: "day", interval: 500 } }, { who: mcp, lang: "en" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("repeat rule is not valid");
    expect((await getItem(acct(u), id))!.repeat).toMatchObject({ every: "day", interval: 3 });
  });

  it("a Hijri yearly rule is worded with its Hijri date in the item line", async () => {
    const u = await login();
    const c = await runSecretaryTool(u, "todo_create", { title: "Anniversary", due: inDays(2, 9), repeat: { every: "hyear" } }, { who: mcp, lang: "en" });
    expect(c.isError, c.text).toBe(false);
    expect(c.text).toMatch(/Repeats every Hijri year on \d{1,2} [A-Z]/);
    const g = await runSecretaryTool(u, "agenda_get", {}, { who: mcp, lang: "en" });
    expect(g.text).toMatch(/repeats: Repeats every Hijri year on \d{1,2} [A-Z]/);
  });

  it("stop_repeat over MCP and over chat is owner_only and changes nothing", async () => {
    const u = await login();
    const it1 = await add({ title: "Daily", dueAt: inDays(1, 9), repeat: { every: "day" } });
    for (const [who, agent] of [[mcp, undefined], [chat, "reem"]] as const) {
      const r = await runSecretaryTool(u, "todo_update", { id: it1.id, stop_repeat: true, title: "Renamed" }, { who, lang: "en", ...(agent ? { agent } : {}) });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Only the owner can");
      expect(r.text).toContain("(field: repeat)");
    }
    const r2 = await runSecretaryTool(u, "todo_update", { id: it1.id, repeat: null }, { who: mcp, lang: "en" });
    expect(r2.isError).toBe(true);
    expect(await getItem(acct(u), it1.id)).toMatchObject({ rev: 1, title: "Daily", repeat: { every: "day" } });
    const r3 = await runSecretaryTool(u, "todo_create", { title: "x", stop_repeat: true }, { who: mcp, lang: "en" });
    expect(r3.isError).toBe(true);
    expect(await listOpenItems(acct(u))).toHaveLength(1);
  });

  it("a filler stop_repeat:false (or null) is no stop attempt: the other fields apply and a plain create works", async () => {
    const u = await login();
    const it1 = await add({ title: "Daily", dueAt: inDays(1, 9), repeat: { every: "day" } });
    for (const filler of [false, null]) {
      const r = await runSecretaryTool(u, "todo_update", { id: it1.id, stop_repeat: filler, title: `Renamed ${String(filler)}` }, { who: chat, lang: "en", agent: "reem" });
      expect(r.isError, r.text).toBe(false);
      expect((await getItem(acct(u), it1.id))!.title).toBe(`Renamed ${String(filler)}`);
    }
    expect((await getItem(acct(u), it1.id))!.repeat).toMatchObject({ every: "day" });
    const c = await runSecretaryTool(u, "todo_create", { title: "Plain", stop_repeat: false }, { who: mcp, lang: "en" });
    expect(c.isError, c.text).toBe(false);
  });

  it("Reem setting until or count through the tool: owner_only when it would end the series at once, allowed otherwise", async () => {
    const u = await login();
    const mk = async (title: string) => {
      const r = await runSecretaryTool(u, "todo_create", { title, due: inDays(3, 9), repeat: { every: "day" } }, { who: chat, lang: "en", agent: "reem" });
      expect(r.isError, r.text).toBe(false);
      return r.id!;
    };
    const id = await mk("Series");
    const call = (repeat: Record<string, unknown>) => runSecretaryTool(u, "todo_update", { id, repeat }, { who: chat, lang: "en", agent: "reem" });
    // The item is copy 1 of its series: a count of 1 ends it with this copy.
    const c1 = await call({ every: "day", count: 1 });
    expect(c1.isError).toBe(true);
    expect(c1.text).toContain("(field: repeat)");
    // The next date is 4 days out: an until before it ends the series with this copy.
    const u1 = await call({ every: "day", until: zoneDay(Date.now() + 3 * 864e5, z) });
    expect(u1.isError).toBe(true);
    expect(u1.text).toContain("(field: repeat)");
    expect((await getItem(acct(u), id))!.repeat).toEqual(expect.not.objectContaining({ count: 1 }));
    expect((await getItem(acct(u), id))!.repeat?.until).toBeUndefined();
    const c2 = await call({ every: "day", count: 5 });
    expect(c2.isError, c2.text).toBe(false);
    expect((await getItem(acct(u), id))!.repeat).toMatchObject({ every: "day", count: 5 });
    const u2 = await call({ every: "day", until: zoneDay(Date.now() + 20 * 864e5, z) });
    expect(u2.isError, u2.text).toBe(false);
    expect((await getItem(acct(u), id))!.repeat?.until).toBe(zoneDay(Date.now() + 20 * 864e5, z));
  });

  it("an out-of-range remind_before through the tool is repeat_invalid and writes nothing", async () => {
    const u = await login();
    const r = await runSecretaryTool(u, "todo_create", { title: "x", due: inDays(1, 9), repeat: { every: "day", remind_before: 20000 } }, { who: chat, lang: "en", agent: "reem" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("repeat rule is not valid");
    expect(await listOpenItems(acct(u))).toHaveLength(0);
    const it1 = await add({ title: "Daily", dueAt: inDays(1, 9), repeat: { every: "day" } });
    const up = await runSecretaryTool(u, "todo_update", { id: it1.id, repeat: { every: "day", remind_before: 20000 } }, { who: chat, lang: "en", agent: "reem" });
    expect(up.isError).toBe(true);
    expect(up.text).toContain("repeat rule is not valid");
    expect(await getItem(acct(u), it1.id)).toMatchObject({ rev: 1, repeat: { every: "day" } });
  });

  it("a handoff note never carries repeat", async () => {
    const u = await login();
    const r = await runHandoffNote(u, { to: "owner", kind: "blocked", body: "I cannot publish the weekly post without the owner's approval of the offer", repeat: { every: "day" }, stop_repeat: true }, { agent: "noor", lang: "en" });
    expect(r.isError, r.text).toBe(false);
    const open = await listOpenItems(acct(u));
    expect(open).toHaveLength(1);
    expect(open[0].repeat).toBeFalsy();
    expect(open[0].series).toBeUndefined();
  });

  it("the tool schema has no minimum, maximum, minLength or maxLength and every object has additionalProperties:false", () => {
    const walk = (n: unknown, path: string, seen: string[]) => {
      if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`, seen));
      if (!n || typeof n !== "object") return;
      const o = n as Record<string, unknown>;
      for (const k of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "exclusiveMinimum", "exclusiveMaximum"]) expect(o, `${path}.${k}`).not.toHaveProperty(k);
      if (o.type === "object") { expect(o.additionalProperties, path).toBe(false); seen.push(path); }
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`, seen);
    };
    const objects: string[] = [];
    for (const d of SEC_TOOL_DEFS) walk(d.schema, d.name, objects);
    expect(objects).toContain("todo_create.properties.repeat");
    expect(objects).toContain("todo_update.properties.repeat");
    const rep = (SEC_TOOL_DEFS.find((d) => d.name === "todo_create")!.schema.properties.repeat) as { required: string[]; properties: { every: { enum: string[] } } };
    expect(rep.required).toEqual(["every"]);
    expect(rep.properties.every.enum).toHaveLength(7);
  });
});
