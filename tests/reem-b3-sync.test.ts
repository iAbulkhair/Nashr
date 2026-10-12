/**
 * Reem B3, reading the chosen calendar's events and keeping the busy meetings (spec
 * 2026-10-05-secretary-reem-b3-calendar-read-design.md §6 and §7 steps 4-5, rulings P1 and R6). Rule 914: the keep
 * filter for both providers, private events stored without a title, titles cleaned and cut, the 300 limit, malformed
 * events dropped, all-day events stored as local-midnight bounds in the brand's zone, and `fetchEvents` (only the chosen
 * calendar, the status mapping, nothing of the response text leaving the function).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAL_TITLE_MAX, keepGoogle, keepGraph, limitMeetings, meetingTitle, type GEvent, type GraphEvent, type Meeting } from "@/lib/secretary-meetings";
import { GOOGLE_API, GRAPH, fetchEvents } from "@/lib/secretary-gcal";
import type { CalLink } from "@/lib/secretary-cal-link";

const Z = "Asia/Riyadh" as const;
const g = (o: Partial<GEvent> = {}): GEvent => ({ summary: "Call", start: { dateTime: "2026-10-05T09:00:00+03:00" }, end: { dateTime: "2026-10-05T10:00:00+03:00" }, ...o });
const m = (o: Partial<GraphEvent> = {}): GraphEvent => ({ subject: "Call", start: { dateTime: "2026-10-05T06:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-05T07:00:00.0000000", timeZone: "UTC" }, isAllDay: false, showAs: "busy", ...o });

describe("rule 914: events of the chosen calendar, filtered to the busy meetings Reem respects", () => {
  it("Google: a timed busy event is kept with its instants as UTC ISO", () => {
    expect(keepGoogle(g(), Z)).toEqual({ start: "2026-10-05T06:00:00.000Z", end: "2026-10-05T07:00:00.000Z", title: "Call", allDay: false });
  });

  it("dropped: cancelled, declined by the owner, and free (both providers)", () => {
    expect(keepGoogle(g({ status: "cancelled" }), Z)).toBeNull();
    expect(keepGoogle(g({ attendees: [{ self: true, responseStatus: "declined" }] }), Z)).toBeNull();
    expect(keepGoogle(g({ attendees: [{ self: false, responseStatus: "declined" }, { self: true, responseStatus: "accepted" }] }), Z)).not.toBeNull();
    expect(keepGoogle(g({ transparency: "transparent" }), Z)).toBeNull();
    expect(keepGraph(m({ isCancelled: true }), Z)).toBeNull();
    expect(keepGraph(m({ responseStatus: { response: "declined" } }), Z)).toBeNull();
    expect(keepGraph(m({ showAs: "free" }), Z)).toBeNull();
    expect(keepGraph(m({ responseStatus: { response: "accepted" } }), Z)).not.toBeNull();
  });

  it("an all-day event is kept only when busy", () => {
    const gAll = { summary: "Offsite", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } } as GEvent;
    expect(keepGoogle(gAll, Z)).toMatchObject({ allDay: true, title: "Offsite" });
    expect(keepGoogle({ ...gAll, transparency: "transparent" }, Z)).toBeNull();
    const mAll = (o: Partial<GraphEvent>) => m({ isAllDay: true, start: { dateTime: "2026-10-04T21:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-05T21:00:00.0000000", timeZone: "UTC" }, ...o });
    expect(keepGraph(mAll({ showAs: "busy" }), Z)).toMatchObject({ allDay: true });
    expect(keepGraph(mAll({ showAs: "oof" }), Z)).toMatchObject({ allDay: true });
    expect(keepGraph(m({ showAs: "oof" }), Z)).toMatchObject({ allDay: false });
    expect(keepGraph(mAll({ showAs: "tentative" }), Z)).toBeNull();
    expect(keepGraph(mAll({ showAs: "free" }), Z)).toBeNull();
    expect(keepGraph(mAll({ showAs: undefined }), Z)).toBeNull();
  });

  it("a private event is kept with no title at all and private: true (ruling P1), and readers show Busy", () => {
    const a = keepGoogle(g({ summary: "Secret deal", visibility: "private" }), Z)!;
    const b = keepGraph(m({ subject: "Secret deal", sensitivity: "private" }), Z)!;
    for (const x of [a, b]) {
      expect(x.title).toBe("");
      expect(x.private).toBe(true);
      expect(JSON.stringify(x)).not.toContain("Secret");
      expect(meetingTitle(x, "ar")).toBe("مشغول");
      expect(meetingTitle(x, "en")).toBe("Busy");
    }
    expect(keepGoogle(g({ visibility: "default" }), Z)!.private).toBeUndefined();
    expect(keepGraph(m({ sensitivity: "normal" }), Z)!.private).toBeUndefined();
  });

  it("confidential and personal events are private too (ruling R12)", () => {
    for (const x of [keepGoogle(g({ summary: "Secret", visibility: "confidential" }), Z)!, keepGraph(m({ subject: "Secret", sensitivity: "confidential" }), Z)!, keepGraph(m({ subject: "Secret", sensitivity: "personal" }), Z)!]) {
      expect(x).toMatchObject({ title: "", private: true });
      expect(JSON.stringify(x)).not.toContain("Secret");
    }
  });

  it("an untitled event that is not private shows Busy too (ruling R14)", () => {
    const x = keepGoogle(g({ summary: undefined }), Z)!;
    expect(x.title).toBe("");
    expect(x.private).toBeUndefined();
    expect(meetingTitle(x, "ar")).toBe("مشغول");
    expect(meetingTitle(x, "en")).toBe("Busy");
    expect(meetingTitle({ ...x, title: "Launch" }, "en")).toBe("Launch");
  });

  it("a Graph event whose times are not in UTC is dropped, the answer to a `Prefer` that was ignored", () => {
    const at = (timeZone: string) => ({ dateTime: "2026-10-05T09:00:00.0000000", timeZone });
    expect(keepGraph(m({ start: at("Arab Standard Time"), end: at("UTC") }), Z)).toBeNull();
    expect(keepGraph(m({ start: at("UTC"), end: at("Arab Standard Time") }), Z)).toBeNull();
    expect(keepGraph(m({ start: { dateTime: "2026-10-05T09:00:00.0000000", timeZone: 5 as unknown as string } }), Z)).toBeNull();
    for (const ok of ["UTC", "utc", "Etc/UTC"]) expect(keepGraph(m({ start: { dateTime: "2026-10-05T06:00:00.0000000", timeZone: ok }, end: { dateTime: "2026-10-05T07:00:00.0000000", timeZone: ok } }), Z)).not.toBeNull();
    expect(keepGraph(m({ start: { dateTime: "2026-10-05T06:00:00.0000000" }, end: { dateTime: "2026-10-05T07:00:00.0000000" } }), Z)).not.toBeNull();
  });

  it("a 500-character title becomes 120 characters with control characters stripped", () => {
    expect(CAL_TITLE_MAX).toBe(120);
    const long = `a\u0000b‮${"x".repeat(500)}`;
    for (const t of [keepGoogle(g({ summary: long }), Z)!.title, keepGraph(m({ subject: long }), Z)!.title]) {
      expect(t.length).toBe(120);
      expect(t).not.toMatch(/[\u0000-\u001f‮]/);
      expect(t.startsWith("abxx")).toBe(true);
    }
    expect(keepGoogle(g({ summary: "  Team\n\tsync  " }), Z)!.title).toBe("Team sync");
    // A cut never leaves half of an emoji.
    const emoji = keepGoogle(g({ summary: `${"y".repeat(119)}😀tail` }), Z)!.title;
    expect(emoji).toBe("y".repeat(119));
  });

  it("limitMeetings sorts by start and keeps at most 300", () => {
    const list: Meeting[] = Array.from({ length: 400 }, (_, i) => {
      const s = Date.UTC(2026, 9, 5) + (399 - i) * 60_000;
      return { start: new Date(s).toISOString(), end: new Date(s + 30_000).toISOString(), title: `m${399 - i}`, allDay: false };
    });
    const out = limitMeetings(list);
    expect(out).toHaveLength(300);
    expect(out[0].title).toBe("m0");
    expect(out[299].title).toBe("m299");
    expect(limitMeetings([])).toEqual([]);
  });

  it("graph times without Z are UTC; malformed events are dropped, never thrown", () => {
    expect(keepGraph(m({ start: { dateTime: "2026-10-05T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-05T09:30:00.0000000", timeZone: "UTC" } }), Z)!.start).toBe("2026-10-05T09:00:00.000Z");
    expect(keepGraph(m({ end: undefined }), Z)).toBeNull();
    expect(keepGoogle(g({ end: undefined }), Z)).toBeNull();
    expect(keepGoogle(g({ start: { dateTime: "yesterday" } }), Z)).toBeNull();
    expect(keepGoogle(g({ start: { dateTime: "2026-10-05T09:00:00" } }), Z)).toBeNull();
    expect(keepGoogle(g({ end: { dateTime: "2026-10-05T08:00:00+03:00" } }), Z)).toBeNull();
    expect(keepGoogle(g({ start: { date: "2026-13-45" }, end: { date: "2026-13-46" } }), Z)).toBeNull();
    expect(keepGraph(m({ start: { dateTime: "nope" } }), Z)).toBeNull();
    for (const bad of [null, undefined, 5, "x", [], { start: 3, end: 4 }, { summary: {}, start: { dateTime: {} }, end: [] }]) {
      expect(() => keepGoogle(bad as GEvent, Z)).not.toThrow();
      expect(() => keepGraph(bad as GraphEvent, Z)).not.toThrow();
      expect(keepGoogle(bad as GEvent, Z)).toBeNull();
      expect(keepGraph(bad as GraphEvent, Z)).toBeNull();
    }
    expect(keepGoogle(g({ summary: { a: 1 } as unknown as string }), Z)!.title).toBe("");
    expect(keepGoogle(g({ attendees: "x" as unknown as GEvent["attendees"] }), Z)).not.toBeNull();
  });

  it("Google all-day start.date becomes the brand zone's local midnight as a UTC instant (ruling R6)", () => {
    const e = keepGoogle({ summary: "Day", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } } as GEvent, Z)!;
    expect(e).toMatchObject({ start: "2026-10-04T21:00:00.000Z", end: "2026-10-05T21:00:00.000Z", allDay: true });
    const dubai = keepGoogle({ summary: "Day", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } } as GEvent, "Asia/Dubai")!;
    expect(dubai.start).toBe("2026-10-04T20:00:00.000Z");
  });

  it("a 2-day Google all-day event spans 48 hours of local time", () => {
    const e = keepGoogle({ summary: "Trip", start: { date: "2026-10-05" }, end: { date: "2026-10-07" } } as GEvent, Z)!;
    expect(Date.parse(e.end) - Date.parse(e.start)).toBe(48 * 3_600_000);
    expect(e.start).toBe("2026-10-04T21:00:00.000Z");
  });

  it("Graph all-day, both forms of times for Riyadh 5 Oct, give the same local-midnight bounds (ruling R6)", () => {
    const forms: [string, string][] = [
      ["2026-10-05T00:00:00.0000000", "2026-10-06T00:00:00.0000000"], // UTC midnight
      ["2026-10-04T21:00:00.0000000", "2026-10-05T21:00:00.0000000"], // the event's own local midnight in UTC
    ];
    for (const [s, e] of forms) {
      const k = keepGraph(m({ isAllDay: true, start: { dateTime: s, timeZone: "UTC" }, end: { dateTime: e, timeZone: "UTC" } }), Z)!;
      expect(k.start).toBe("2026-10-04T21:00:00.000Z");
      expect(k.end).toBe("2026-10-05T21:00:00.000Z");
      expect(k.allDay).toBe(true);
    }
    // Dubai (+4): the same two forms.
    for (const [s, e] of [["2026-10-05T00:00:00.0000000", "2026-10-06T00:00:00.0000000"], ["2026-10-04T20:00:00.0000000", "2026-10-05T20:00:00.0000000"]]) {
      const k = keepGraph(m({ isAllDay: true, start: { dateTime: s, timeZone: "UTC" }, end: { dateTime: e, timeZone: "UTC" } }), "Asia/Dubai")!;
      expect(k).toMatchObject({ start: "2026-10-04T20:00:00.000Z", end: "2026-10-05T20:00:00.000Z" });
    }
  });
});

describe("rule 914: fetchEvents reads the chosen calendar only", () => {
  const CAL_ID = "brand@group.calendar.google.com";
  const link = (provider: "gcal" | "mscal", calendarId: string | null = CAL_ID): CalLink => ({ v: 1, provider, login: "o@x.example", account: "o@x.example", proof: "declaration", ...(calendarId === null ? {} : { calendarId }), state: "ok", tokens: "sealed", connectedAt: 0, rev: 1 }) as CalLink;
  const FROM = Date.UTC(2026, 9, 5);
  const TO = FROM + 7 * 86_400_000;
  let calls: { url: string; headers: Record<string, string>; signal?: AbortSignal | null }[] = [];
  const stub = (res: () => Response | Promise<Response>) => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal });
      return res();
    }));
  };
  afterEach(() => vi.unstubAllGlobals());

  it("Google: one request to the fixed host for the chosen id, with only the selected fields and a timeout", async () => {
    stub(() => Response.json({ items: [{ summary: "A" }, { summary: "B" }] }));
    const r = await fetchEvents(link("gcal"), "tok", FROM, TO);
    expect(r).toEqual({ ok: true, raw: [{ summary: "A" }, { summary: "B" }] });
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe(`${GOOGLE_API}/calendar/v3/calendars/${encodeURIComponent(CAL_ID)}/events`);
    expect(u.searchParams.get("timeMin")).toBe(new Date(FROM).toISOString());
    expect(u.searchParams.get("timeMax")).toBe(new Date(TO).toISOString());
    expect(u.searchParams.get("singleEvents")).toBe("true");
    expect(u.searchParams.get("orderBy")).toBe("startTime");
    expect(u.searchParams.get("maxResults")).toBe("300");
    expect(u.searchParams.get("fields")).toBe("items(status,summary,start,end,transparency,visibility,attendees(self,responseStatus))");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(calls[0].signal).toBeTruthy();
  });

  it("Google: a calendar id with slashes and dots stays inside the path (encoded), and an empty page is an empty list", async () => {
    stub(() => Response.json({}));
    const evil = "../../users/me/calendarList?x=1#";
    expect(await fetchEvents(link("gcal", evil), "tok", FROM, TO)).toEqual({ ok: true, raw: [] });
    const u = new URL(calls[0].url);
    expect(u.origin).toBe(GOOGLE_API);
    expect(u.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(evil)}/events`);
    expect(u.hash).toBe("");
  });

  it("Microsoft: calendarView of the chosen calendar only, UTC preferred, only the selected fields", async () => {
    stub(() => Response.json({ value: [{ subject: "A" }] }));
    const r = await fetchEvents(link("mscal", "AAMk/id=="), "tok", FROM, TO);
    expect(r).toEqual({ ok: true, raw: [{ subject: "A" }] });
    expect(calls).toHaveLength(1);
    const url = calls[0].url;
    expect(url.startsWith(`${GRAPH}/me/calendars/${encodeURIComponent("AAMk/id==")}/calendarView?`)).toBe(true);
    expect(url).not.toContain("/me/events");
    expect(url).not.toContain("/me/calendar/");
    const u = new URL(url);
    expect(u.searchParams.get("startDateTime")).toBe(new Date(FROM).toISOString());
    expect(u.searchParams.get("endDateTime")).toBe(new Date(TO).toISOString());
    expect(u.searchParams.get("$select")).toBe("subject,start,end,isAllDay,showAs,isCancelled,sensitivity,responseStatus");
    expect(u.searchParams.get("$top")).toBe("300");
    expect(calls[0].headers.Prefer).toBe('outlook.timezone="UTC"');
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
  });

  it("no chosen calendar means no request at all", async () => {
    stub(() => Response.json({ items: [] }));
    expect(await fetchEvents(link("gcal", null), "tok", FROM, TO)).toEqual({ ok: false, kind: "gone" });
    expect(calls).toHaveLength(0);
  });

  it("a calendar id of . or .. makes no request (a dot segment would leave the calendar path)", async () => {
    stub(() => Response.json({ items: [] }));
    for (const id of [".", ".."]) for (const p of ["gcal", "mscal"] as const) expect(await fetchEvents(link(p, id), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry" });
    expect(calls).toHaveLength(0);
  });

  it("401 is auth, 404 is gone, 503 with Retry-After 120 is retry with 120, and nothing of the body leaks", async () => {
    stub(() => new Response("SECRET PROVIDER TEXT", { status: 401 }));
    expect(await fetchEvents(link("gcal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "auth" });
    stub(() => new Response("SECRET PROVIDER TEXT", { status: 404 }));
    expect(await fetchEvents(link("mscal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "gone" });
    stub(() => new Response("SECRET PROVIDER TEXT", { status: 503, headers: { "Retry-After": "120" } }));
    expect(await fetchEvents(link("gcal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry", retryAfterS: 120 });
    stub(() => new Response("x", { status: 429, headers: { "Retry-After": "30" } }));
    expect(await fetchEvents(link("mscal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry", retryAfterS: 30 });
    stub(() => new Response("x", { status: 500 }));
    expect(await fetchEvents(link("gcal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry" });
    stub(() => new Response("x", { status: 503, headers: { "Retry-After": "soon" } }));
    expect(await fetchEvents(link("gcal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry" });
    stub(() => new Response("x", { status: 503, headers: { "Retry-After": "999999" } }));
    expect(await fetchEvents(link("gcal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry", retryAfterS: 3600 });
  });

  it("a network error, a timeout, a body that is not JSON and an items value that is not a list are retry, logging only the error name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    stub(() => {
      throw Object.assign(new Error("connect ECONNRESET secret-host"), { name: "TypeError" });
    });
    expect(await fetchEvents(link("gcal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry" });
    stub(() => {
      throw new DOMException("took too long, secret", "TimeoutError");
    });
    expect(await fetchEvents(link("mscal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry" });
    stub(() => new Response("<html>SECRET</html>", { status: 200 }));
    expect(await fetchEvents(link("gcal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry" });
    stub(() => Response.json({ items: "nope" }));
    expect(await fetchEvents(link("gcal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry" });
    stub(() => Response.json({}));
    expect(await fetchEvents(link("mscal"), "tok", FROM, TO)).toEqual({ ok: false, kind: "retry" });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toMatch(/secret|SECRET|ECONNRESET|tok/);
    log.mockRestore();
  });
});
