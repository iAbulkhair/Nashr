import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DAY_MS, monthStartUtc, paceStart, runway, runwayLine } from "@/lib/usage-view";

/**
 * Rule 315 (what the owner sees): the runway line under the credits and the chat messages. At the average daily pace
 * since the period started, does what is left reach the renewal (or the trial's end), and if not, around which day does
 * it run out. Pure, so every edge is pinned here with fixed dates.
 */
const MONTH = "2026-10-01T00:00:00.000Z";
const NEXT = "2026-11-01";
const at = (iso: string) => new Date(iso);

describe("rule 315: the runway helper", () => {
  it("nothing used yet: no pace to project", () => {
    expect(runway({ used: 0, left: 250, periodStart: MONTH, resetAt: NEXT, now: at("2026-10-10T00:00:00Z") })).toEqual({ kind: "unused" });
  });

  it("nothing left: out, whether used up or an allowance of 0", () => {
    expect(runway({ used: 250, left: 0, periodStart: MONTH, resetAt: NEXT, now: at("2026-10-10T00:00:00Z") })).toEqual({ kind: "out" });
    expect(runway({ used: 0, left: 0, periodStart: MONTH, resetAt: NEXT, now: at("2026-10-10T00:00:00Z") })).toEqual({ kind: "out" });
    expect(runway({ used: 10, left: -3, periodStart: MONTH, resetAt: NEXT, now: at("2026-10-10T00:00:00Z") })).toEqual({ kind: "out" });
  });

  it("a slow pace lasts until the renewal", () => {
    // 10 days, 50 used: 5 a day; 200 left lasts 40 days, past 2026-11-01.
    expect(runway({ used: 50, left: 200, periodStart: MONTH, resetAt: NEXT, now: at("2026-10-11T00:00:00Z") })).toEqual({ kind: "lasts" });
  });

  it("a fast pace runs out before the renewal, on the projected UTC day", () => {
    // 10 days, 100 used: 10 a day; 150 left lasts 15 days from 2026-10-11 → 2026-10-26.
    expect(runway({ used: 100, left: 150, periodStart: MONTH, resetAt: NEXT, now: at("2026-10-11T00:00:00Z") })).toEqual({ kind: "runs_out", on: "2026-10-26" });
  });

  it("running out exactly at the renewal counts as lasting", () => {
    // 10 days, 100 used: 10 a day; 210 left lasts 21 days from 2026-10-11 → exactly 2026-11-01T00:00Z.
    expect(runway({ used: 100, left: 210, periodStart: MONTH, resetAt: NEXT, now: at("2026-10-11T00:00:00Z") })).toEqual({ kind: "lasts" });
  });

  it("the start of the month: the pace is measured over at least one day", () => {
    // One hour in, 20 used. Over one hour that is 480 a day and 230 left would run out the same day; over the one-day
    // floor it is 20 a day, 230 left lasts 11.5 days from 01:00 → 2026-10-12.
    expect(runway({ used: 20, left: 230, periodStart: MONTH, resetAt: NEXT, now: at("2026-10-01T01:00:00Z") })).toEqual({ kind: "runs_out", on: "2026-10-12" });
    // A period start after now (a skewed clock) is the same one-day floor, never a negative pace.
    expect(runway({ used: 20, left: 230, periodStart: "2026-10-02T00:00:00Z", resetAt: NEXT, now: at("2026-10-01T01:00:00Z") })).toEqual({ kind: "runs_out", on: "2026-10-12" });
  });

  it("a trial has no renewal: its end is trialEnds", () => {
    const created = "2026-10-05T12:00:00Z";
    const trialEnds = new Date(Date.parse(created) + 3 * DAY_MS).toISOString();
    // 2 days in, 10 of 30 messages: 5 a day, 20 left lasts 4 days, past the trial's end.
    expect(runway({ used: 10, left: 20, periodStart: created, resetAt: null, trialEnds, now: at("2026-10-07T12:00:00Z") })).toEqual({ kind: "lasts" });
    // 2 days in, 26 used: 13 a day, 4 left lasts under a day → 2026-10-07.
    expect(runway({ used: 26, left: 4, periodStart: created, resetAt: null, trialEnds, now: at("2026-10-07T12:00:00Z") })).toEqual({ kind: "runs_out", on: "2026-10-07" });
  });

  it("a period that already ended (a trial past its end): no runway, never 'lasts until' a day that is gone", () => {
    const created = "2026-10-01T12:00:00Z";
    const trialEnds = "2026-10-04T12:00:00Z";
    // Two days after the trial ended: a slow pace would otherwise "last until your trial ends on 2026-10-04".
    expect(runway({ used: 2, left: 28, periodStart: created, resetAt: null, trialEnds, now: at("2026-10-06T12:00:00Z") })).toBeNull();
    // A fast pace would otherwise project a run-out day, also past.
    expect(runway({ used: 28, left: 2, periodStart: created, resetAt: null, trialEnds, now: at("2026-10-06T12:00:00Z") })).toBeNull();
    // Exactly at the end counts as ended.
    expect(runway({ used: 2, left: 28, periodStart: created, resetAt: null, trialEnds, now: at(trialEnds) })).toBeNull();
    // A renewal date already reached (a stale page) is the same.
    expect(runway({ used: 50, left: 200, periodStart: MONTH, resetAt: NEXT, now: at("2026-11-02T00:00:00Z") })).toBeNull();
    // One minute before the end it still projects.
    expect(runway({ used: 2, left: 28, periodStart: created, resetAt: null, trialEnds, now: at("2026-10-04T11:59:00Z") })).toEqual({ kind: "lasts" });
    // Used up or unused say so whatever the date: those sentences name no date that could be gone.
    expect(runway({ used: 30, left: 0, periodStart: created, resetAt: null, trialEnds, now: at("2026-10-06T12:00:00Z") })).toEqual({ kind: "out" });
    expect(runway({ used: 0, left: 30, periodStart: created, resetAt: null, trialEnds, now: at("2026-10-06T12:00:00Z") })).toEqual({ kind: "unused" });
    // And no sentence comes of it.
    for (const lang of ["ar", "en"] as const) {
      expect(runwayLine(runway({ used: 2, left: 28, periodStart: created, resetAt: null, trialEnds, now: at("2026-10-06T12:00:00Z") }), { lang, what: "messages", trial: true, nextReset: "2026-11-01", trialEnds: "2026-10-04" })).toBeNull();
      expect(runwayLine(runway({ used: 20, left: 30, periodStart: created, resetAt: null, trialEnds, now: at("2026-10-06T12:00:00Z") }), { lang, what: "credits", trial: true, nextReset: "2026-11-01", trialEnds: "2026-10-04" })).toBeNull();
    }
  });

  it("with no readable end at all, the projected day is given as is", () => {
    expect(runway({ used: 100, left: 150, periodStart: MONTH, resetAt: null, now: at("2026-10-11T00:00:00Z") })).toEqual({ kind: "runs_out", on: "2026-10-26" });
    expect(runway({ used: 100, left: 150, periodStart: MONTH, resetAt: null, trialEnds: "not a date", now: at("2026-10-11T00:00:00Z") })).toEqual({ kind: "runs_out", on: "2026-10-26" });
  });

  it("NaN and unreadable inputs never produce NaN or a broken date", () => {
    const now = at("2026-10-11T00:00:00Z");
    expect(runway({ used: NaN, left: 200, periodStart: MONTH, resetAt: NEXT, now })).toEqual({ kind: "unused" });
    expect(runway({ used: 50, left: NaN, periodStart: MONTH, resetAt: NEXT, now })).toEqual({ kind: "out" });
    expect(runway({ used: Infinity, left: 200, periodStart: MONTH, resetAt: NEXT, now })).toEqual({ kind: "unused" });
    expect(runway({ used: 50, left: 200, periodStart: "garbage", resetAt: NEXT, now })).toBeNull();
    expect(runway({ used: 50, left: 200, periodStart: MONTH, resetAt: NEXT, now: "garbage" })).toBeNull();
    expect(runway({ used: 50, left: 200, periodStart: NaN, resetAt: NEXT, now })).toBeNull();
    // A balance so large its run-out day is past the last representable date: it lasts when there is an end, else nothing.
    expect(runway({ used: 1, left: 1e15, periodStart: MONTH, resetAt: NEXT, now })).toEqual({ kind: "lasts" });
    expect(runway({ used: 1, left: 1e15, periodStart: MONTH, resetAt: null, now })).toBeNull();
  });

  it("dates come back as YYYY-MM-DD, never through a locale formatter", () => {
    const r = runway({ used: 100, left: 150, periodStart: MONTH, resetAt: NEXT, now: at("2026-10-11T00:00:00Z") });
    expect(r?.kind === "runs_out" && r.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const src = readFileSync("src/lib/usage-view.ts", "utf8");
    expect(src).not.toMatch(/Intl\.|toLocale/);
    // Shared with client components: it must stay import-free.
    expect(src.split("\n").filter((l) => /^\s*import\s|\brequire\(/.test(l))).toEqual([]);
  });
});

describe("rule 315: the runway sentence", () => {
  const base = { trial: false, nextReset: "2026-11-01", trialEnds: "2026-10-08" };
  const LANGS = ["ar", "en"] as const;

  it("says nothing when nothing is used yet or the dates were unreadable", () => {
    for (const lang of LANGS) {
      expect(runwayLine({ kind: "unused" }, { ...base, lang, what: "credits" })).toBeNull();
      expect(runwayLine(null, { ...base, lang, what: "messages" })).toBeNull();
    }
  });

  it("credits: lasts until the renewal, or the trial's end; runs out around the day", () => {
    expect(runwayLine({ kind: "lasts" }, { ...base, lang: "en", what: "credits" })).toBe("At this pace your credits last until the renewal on 2026-11-01.");
    expect(runwayLine({ kind: "lasts" }, { ...base, lang: "ar", what: "credits" })).toBe("بهذا المعدل يكفي رصيدك حتى التجديد في 2026-11-01.");
    expect(runwayLine({ kind: "lasts" }, { ...base, trial: true, lang: "en", what: "credits" })).toBe("At this pace your credits last until your trial ends on 2026-10-08.");
    expect(runwayLine({ kind: "lasts" }, { ...base, trial: true, lang: "ar", what: "credits" })).toBe("بهذا المعدل يكفي رصيدك حتى نهاية التجربة في 2026-10-08.");
    expect(runwayLine({ kind: "runs_out", on: "2026-10-20" }, { ...base, lang: "en", what: "credits" })).toBe("At this pace your credits run out around 2026-10-20.");
    expect(runwayLine({ kind: "runs_out", on: "2026-10-20" }, { ...base, lang: "ar", what: "credits" })).toBe("بهذا المعدل ينفد رصيدك نحو 2026-10-20.");
  });

  it("messages: what happens after they run out follows the owner's choice; a trial pauses until a subscription", () => {
    const on = { ...base, what: "messages" as const, overflowOn: true };
    const off = { ...base, what: "messages" as const, overflowOn: false };
    expect(runwayLine({ kind: "runs_out", on: "2026-10-20" }, { ...off, lang: "en" })).toBe("At this pace your messages run out around 2026-10-20, then chat pauses until 2026-11-01.");
    expect(runwayLine({ kind: "runs_out", on: "2026-10-20" }, { ...on, lang: "en" })).toBe("At this pace your messages run out around 2026-10-20, then chat continues on credits.");
    expect(runwayLine({ kind: "runs_out", on: "2026-10-20" }, { ...off, lang: "ar" })).toBe("بهذا المعدل تنفد رسائلك نحو 2026-10-20، ثم تتوقف الدردشة حتى 2026-11-01.");
    expect(runwayLine({ kind: "runs_out", on: "2026-10-20" }, { ...on, lang: "ar" })).toBe("بهذا المعدل تنفد رسائلك نحو 2026-10-20، ثم تستمر الدردشة على الكريدت.");
    expect(runwayLine({ kind: "out" }, { ...off, lang: "en" })).toBe("This month's messages are used up: chat is paused until 2026-11-01.");
    expect(runwayLine({ kind: "out" }, { ...on, lang: "en" })).toBe("This month's messages are used up: chat continues on credits until the renewal.");
    expect(runwayLine({ kind: "out" }, { ...off, trial: true, lang: "en" })).toBe("The trial's messages are used up: chat is paused until a subscription is activated.");
    expect(runwayLine({ kind: "lasts" }, { ...off, lang: "en" })).toBe("At this pace your messages last until the renewal on 2026-11-01.");
    expect(runwayLine({ kind: "lasts" }, { ...off, trial: true, lang: "ar" })).toBe("بهذا المعدل تكفي رسائلك حتى نهاية التجربة في 2026-10-08.");
  });

  it("messages used up with 'continue on credits' on but the balance below the hold: chat is paused, not continuing", () => {
    const on = { ...base, what: "messages" as const, overflowOn: true, shortOf: 5 };
    expect(runwayLine({ kind: "out" }, { ...on, lang: "en" })).toBe("This month's messages are used up, and chat is paused: your balance is below the 5 credits a message on credits needs.");
    expect(runwayLine({ kind: "out" }, { ...on, lang: "ar" })).toBe("استُخدمت رسائل هذا الشهر، والدردشة متوقفة: رصيدك أقل من 5 كريدت، وهو أقل ما تحتاجه الرسالة على الكريدت.");
    // `shortOf` only matters with the switch on, and only once the messages are used up.
    expect(runwayLine({ kind: "out" }, { ...on, overflowOn: false, lang: "en" })).toBe("This month's messages are used up: chat is paused until 2026-11-01.");
    expect(runwayLine({ kind: "out" }, { ...on, shortOf: undefined, lang: "en" })).toBe("This month's messages are used up: chat continues on credits until the renewal.");
    expect(runwayLine({ kind: "runs_out", on: "2026-10-20" }, { ...on, lang: "en" })).toBe("At this pace your messages run out around 2026-10-20, then chat continues on credits.");
  });

  it("chat turned off for the account (an allowance of 0): not available, contact support, no renewal date", () => {
    for (const trial of [false, true]) {
      const off = { ...base, trial, what: "messages" as const, chatOff: true };
      expect(runwayLine({ kind: "out" }, { ...off, lang: "en" })).toBe("Chat is not available on this account. Contact support.");
      expect(runwayLine({ kind: "out" }, { ...off, lang: "ar" })).toBe("الدردشة غير متاحة في هذا الحساب. تواصل مع الدعم.");
    }
    // With "continue on credits" on, the account still chats on credits: that sentence wins.
    expect(runwayLine({ kind: "out" }, { ...base, what: "messages", chatOff: true, overflowOn: true, lang: "en" })).toBe("This month's messages are used up: chat continues on credits until the renewal.");
    // Credits are not chat: chatOff never changes the credit sentence.
    expect(runwayLine({ kind: "out" }, { ...base, what: "credits", chatOff: true, lang: "en" })).toBe("The credits are used up until the renewal on 2026-11-01.");
  });

  it("every kind has a sentence in both languages, and the Arabic one is Arabic", () => {
    const kinds = [{ kind: "out" }, { kind: "lasts" }, { kind: "runs_out", on: "2026-10-20" }] as const;
    for (const r of kinds) for (const what of ["credits", "messages"] as const) for (const trial of [false, true]) {
      const en = runwayLine(r, { ...base, trial, lang: "en", what });
      const ar = runwayLine(r, { ...base, trial, lang: "ar", what });
      expect(en, `${r.kind} ${what} ${trial}`).toMatch(/^[A-Z]/);
      expect(ar, `${r.kind} ${what} ${trial}`).toMatch(/[؀-ۿ]/);
      expect(ar).not.toBe(en);
    }
  });
});

describe("rule 315: when the pace is measured from", () => {
  it("the month starts at 00:00 UTC on the 1st", () => {
    expect(monthStartUtc(at("2026-10-17T23:59:59Z")).toISOString()).toBe(MONTH);
    expect(monthStartUtc(at("2026-12-31T23:00:00Z")).toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("the later of the month's start and the account's creation; an unreadable creation is the month's start", () => {
    const now = at("2026-10-20T00:00:00Z");
    expect(paceStart("2026-10-12T08:00:00Z", now).toISOString()).toBe("2026-10-12T08:00:00.000Z");
    expect(paceStart("2025-03-01T00:00:00Z", now).toISOString()).toBe(MONTH);
    expect(paceStart("nope", now).toISOString()).toBe(MONTH);
    expect(paceStart(undefined, now).toISOString()).toBe(MONTH);
  });
});
