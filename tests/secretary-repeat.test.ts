import { describe, expect, it } from "vitest";
import {
  SKIP_RESULT, addMonthsClamped, defaultCal, gregorianNext, noteText, repeatText, weekStartOf, weekdayOf, type CalData, type SecRepeat,
} from "@/lib/secretary-agenda";

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
