import { describe, expect, it } from "vitest";
import {
  SKIP_RESULT, addMonthsClamped, defaultCal, gregorianNext, noteText, repeatText, weekStartOf, weekdayOf, type CalData, type SecRepeat,
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
    // 30 Safar 1448 clamps to 29 Safar 1449 (that Safar has 29 days: 5 July to 3 August 2027).
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
    const t0 = Date.now();
    expect(next(w, "2026-10-04", 1, allOff)).toBeNull();
    // An anchor beyond the search bound (a year of candidates from the later of the closed copy and today) has none.
    const far = (o: Partial<SecRepeat>) => nextOccurrence(hRule({ anchor: "2200-01-01", ...o }), prevIso("2026-08-13"), Date.parse(prevIso("2026-08-13")), z, cal, 1);
    expect(far({ interval: 3 })).toBeNull();
    expect(far({ every: "hyear", interval: 3 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
    // A malformed previous date or anchor gives null, never a throw.
    expect(nextOccurrence(hRule({}), "not a date", NOW, z, cal, 1)).toBeNull();
    expect(next(hRule({ anchor: "nonsense" }), "2026-08-13", 1)).toBeNull();
  });
});
