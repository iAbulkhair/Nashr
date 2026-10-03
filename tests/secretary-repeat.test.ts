import { describe, expect, it } from "vitest";
import { json, newMember, newUser, params, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { appDict } from "@/lib/app-i18n";
import * as listRoute from "@/app/api/secretary/route";
import * as itemRoute from "@/app/api/secretary/[id]/route";
import {
  OWNER_ONLY, SEC_KEYS, SERIES_ID, changeItem, createItem, getItem, mutateItem, newSeriesId, parseOwnerChange, parseRepeat, runSecretaryTool,
} from "@/lib/secretary";
import {
  SKIP_RESULT, resultText, addMonthsClamped, defaultCal, gregorianNext, noteText, repeatText, weekStartOf, weekdayOf, zoneDay, type CalData, type SecItem, type SecRepeat,
} from "@/lib/secretary-agenda";
import { hijriMonthStart, nextOccurrence, workCalendar, type SecCalendar } from "@/lib/secretary-calendar";
import { hijriDate } from "@/lib/seasons";

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
    expect(await getItem(u.email, it1.id)).toMatchObject({ rev: 1, dueAt: it1.dueAt });
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
    expect(await getItem(u.email, born.id)).toMatchObject({ repeat: { every: "day", interval: 2 } });
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
    expect(await getItem(u.email, far.id)).toMatchObject({ rev: 2 });
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
    expect((await getItem(u.email, it1.id))!.repeat).toMatchObject({ every: "day" });
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
    expect(await getItem(o.email, it1.id)).toMatchObject({ completedAt: null, rev: 1 });
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
    expect(await db.zrangeWithScores(SEC_KEYS.series(o.email, cur.series!.id))).toEqual([{ member: it1.id, score: Date.parse(cur.completedAt!) }]);
    // delete: the copy goes, nothing else opens, and it never joins the series' closed copies
    const d = await add({ title: "Delete me", dueAt: inDays(1, 9), repeat: { every: "day" } });
    expect((await patch(d.id, { action: "delete" })).status).toBe(200);
    expect(await db.zrangeWithScores(SEC_KEYS.series(o.email, d.series!.id))).toEqual([]);
    expect(await db.smembers(SEC_KEYS.seriesList(o.email))).toEqual([cur.series!.id]);
    const open = (await db.zrangeWithScores(SEC_KEYS.open(o.email))).map((m) => m.member);
    expect(open).toEqual([plain.id]);
  });

  it("closedBy is set by complete and confirm_done and cleared by reopen, and the audit line carries repeat and closedBy", async () => {
    const o = await login();
    const a = await add({ title: "A", dueAt: inDays(1), repeat: { every: "day" } });
    const r1 = await patch(a.id, { action: "complete", result: "done" });
    expect(((await r1.json()).item as SecItem).closedBy).toEqual({ actor: "owner", login: o.email });
    const r2 = await patch(a.id, { action: "reopen" });
    expect("closedBy" in ((await r2.json()).item as SecItem)).toBe(false);
    const b = await add({ title: "B", dueAt: inDays(1) });
    await changeItem(o.email, b.id, { action: "propose_done", evidence: "it is done" }, chat);
    const r3 = await patch(b.id, { action: "confirm_done" });
    expect(((await r3.json()).item as SecItem).closedBy).toMatchObject({ actor: "owner" });
    const log = (await db.lrange(SEC_KEYS.audit(o.email), 0, -1)).map((x) => JSON.parse(x));
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
      const r = await changeItem(o.email, it1.id, c, chat, undefined, z, cal);
      expect(r, JSON.stringify(c)).toMatchObject({ ok: false, error: "owner_only", status: 403, field: "repeat" });
    };
    await expectOwner({ action: "stop_repeat" });
    await expectOwner({ action: "update", fields: { repeat: null } });
    await expectOwner({ action: "update", fields: { repeat: { every: "day", interval: 1, count: 1 } } });
    await expectOwner({ action: "update", fields: { repeat: { every: "day", interval: 1, until: zoneDay(Date.now(), z) } } });
    expect(await getItem(o.email, it1.id)).toMatchObject({ rev: 1, repeat: { every: "day" } });
    // a count or until that still leaves the next copy is fine, and so is another cadence
    const ok = await changeItem(o.email, it1.id, { action: "update", fields: { repeat: { every: "day", interval: 1, count: 5, until: zoneDay(Date.now() + 30 * 864e5, z) } } }, chat, undefined, z, cal);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.ok && ok.item.series!.id).toBe(it1.series!.id);
    const wk = await changeItem(o.email, it1.id, { action: "update", fields: { repeat: { every: "week", interval: 2 } } }, { actor: "mcp", via: "mcp" }, undefined, z, cal);
    expect(wk).toMatchObject({ ok: true });
    // the owner in the app may do all of it
    const mine = mutateItem(structuredClone(it1), { action: "update", fields: { repeat: { every: "day", interval: 1, count: 1 } } }, web, Date.now(), z, cal);
    expect(mine).toMatchObject({ ok: true });
  });

  it("repeat null from chat on an item with no repeat is a harmless no-op (R39)", async () => {
    const o = await login();
    const plain = await add({ title: "One-off", dueAt: inDays(2, 9) });
    const r = await changeItem(o.email, plain.id, { action: "update", fields: { repeat: null, priority: 1 } }, chat, undefined, z, defaultCal(z));
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
    expect(await getItem(o.email, it1.id)).toMatchObject({ repeat: { remindBefore: 15 } });
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
  });

  it("every new error has a tool sentence and both page sentences; the owner_only sentence names stopping a repeat", async () => {
    const o = await login();
    const it1 = await add({ title: "x", dueAt: inDays(1), repeat: { every: "day" } });
    const r = await runSecretaryTool(o, "todo_update", { id: it1.id, clear_due: true }, { who: chat, lang: "en" });
    expect(r.text).toMatch(/needs a due date/);
    for (const lang of ["ar", "en"] as const) {
      const e = appDict[lang].todo.errors;
      for (const k of ["repeat_invalid", "repeat_needs_due", "keep_limit", "owner_only"]) expect(e[k], `${lang} ${k}`).toBeTruthy();
    }
    const stop = await changeItem(o.email, it1.id, { action: "stop_repeat" }, chat);
    expect(stop.ok).toBe(false);
    if (!stop.ok) {
      const { toolError } = await import("@/lib/secretary");
      expect(toolError(stop)).toContain("stop or end a repeat");
    }
    expect(newSeriesId()).toMatch(SERIES_ID);
    expect(newSeriesId()).not.toBe(newSeriesId());
  });
});
