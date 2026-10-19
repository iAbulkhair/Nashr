import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderToReadableStream } from "react-dom/server.edge";
import { claudeOn } from "./helpers/model";
import { json, newMember, newUser, params, signIn, signOut, type Fixture, seedActiveBrand } from "./helpers/session";
import { db } from "@/lib/db";
import { type User } from "@/lib/auth";
import { storedPersonId } from "@/lib/keys";
import { AGENT_IDS } from "@/lib/agents";
import { appDict } from "@/lib/app-i18n";
import { saveBrand, type Brand } from "@/lib/brand";
import { saveBrands, scopeFor } from "@/lib/brands";
import { wipeAccount } from "@/lib/account";
import { CHAT_TOOL_NAMES, CONTACT_AWAY_TOOL, history, push, runTool, statusFor, system, toolsFor, type ToolCtx } from "@/lib/chat";
import {
  OWNER_ALIASES, SEC_KEYS, SEC_READS_PER_HOUR, SEC_WRITES_PER_HOUR, agendaFor, calFor, changeItem, createItem, getItem, secretaryDaily, toolError, type Who,
} from "@/lib/secretary";
import { buildWrap } from "@/lib/secretary-evening";
import { addDays, partyKey, zoneDay, type SecItem } from "@/lib/secretary-agenda";
import { COUNTRY_CAL, eidDays, parseCalendar, upcomingQuiet, workCalendar, type EidDay, type SecCalendar } from "@/lib/secretary-calendar";
import {
  AWAY_AHEAD_DAYS, AWAY_KEEP_DAYS, AWAY_MAX, AWAY_PROPOSAL_TTL_S, cleanAway, decideAwayProposal, endAway, listAway, proposeAway, setAway, type AwayProposal,
} from "@/lib/secretary-away";
import * as itemRoute from "@/app/api/secretary/[id]/route";
import * as listRoute from "@/app/api/secretary/route";
import * as awayRoute from "@/app/api/secretary/away/route";
import * as calRoute from "@/app/api/secretary/calendar/route";
import * as propRoute from "@/app/api/secretary/away/proposals/[id]/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { AwayProposalCard, awayCardRefusal } from "@/components/app/ChatPanel";
import { awayCall } from "@/components/app/AwayPanel";
import { calBody, withAdded, withEid, withHolidayOff, withHours, withWeekend, yearlyValue } from "@/components/app/WorkingDaysPanel";
import { localDay } from "@/components/app/useOneWrite";
import Page from "@/app/[lang]/app/todo/page";

// The app router only exists inside Next: the to-do page's client components get a router whose refresh does nothing.
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

/**
 * Rules 478-487 in docs/system/tests.md: Reem phase 3 A1, the store side of the brand's work calendar and of contacts
 * who are away (spec docs/superpowers/specs/2026-10-02-secretary-reem-phase3a-design.md). Rule 478: the calendar
 * (`sec:cal:{scope}`) and the away map (`sec:away:{scope}`) are read wherever the agenda or a date is computed. Rules
 * 481-487 (away contacts, the Working days route, `contact_away`, the page) follow; 479-480 (the alerts) are pinned in
 * secretary-calendar.test.ts. Every date below is pinned: a test that needs "now" fakes Date only (timers run) and
 * restores the real clock, because the real calendars hold Ramadan, Eid and Saudi days in lieu (ruling R4a).
 */
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const BRAND: Brand = { name: "محمصة ريف", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-09-29" };
const DUBAI_BRAND: Brand = { ...BRAND, timeZone: "Asia/Dubai" };
/** A local wall-clock time "YYYY-MM-DDTHH:mm" in Riyadh (UTC+3) or Dubai (UTC+4). */
const local = (s: string, z: "Asia/Riyadh" | "Asia/Dubai" = "Asia/Riyadh") => Date.parse(`${s}:00${z === "Asia/Dubai" ? "+04:00" : "+03:00"}`);
const iso = (ms: number) => new Date(ms).toISOString();
/** Runs `fn` with Date (only) faked at `ms`, and always gives the real clock back. */
async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
/** Working days settings as the admin's PUT stores them (Task 8), every field but the case's at its default. */
const settings = (p: Partial<SecCalendar>): SecCalendar => ({ v: 1, weekend: null, ramadanHours: null, hijriFix: {}, holidays: { add: [], remove: [] }, updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: "admin@test.example", ...p });
/** An away entry as the page's PUT stores it (Task 7): field `partyKey(label)`, value `{ label, until, by, via, at }`. */
const awayEntry = (label: string, until: string) => ({ label, until, by: "owner@test.example", via: "web", at: "2026-10-01T00:00:00.000Z" });
const OWNER: Who & { source: "owner" } = { actor: "owner", via: "web", source: "owner" };
async function owner(prefix: string, brand: Brand = BRAND, fx: Fixture = {}): Promise<User> {
  const u = await newUser(prefix, fx);
  await saveBrand(u.email, brand);
  return u;
}
async function make(u: User, raw: Record<string, unknown>): Promise<SecItem> {
  const r = await createItem(u, raw, OWNER);
  if (!r.ok) throw new Error(`createItem: ${r.error}`);
  return r.item;
}
const patch = (id: string, body: unknown) => itemRoute.PATCH(json(`/api/secretary/${id}`, "PATCH", body), params({ id }));
/** The local day an item's chase clock (`expectBy`) names, in Riyadh. */
const expectDay = (it: SecItem | null) => (it?.expectBy ? zoneDay(Date.parse(it.expectBy)) : null);

describe("rule 478: the brand's work calendar and away map are read wherever the agenda or a date is computed", () => {
  it("calFor reads the brand, sec:cal and sec:away: the zone, the effective calendar, and the away map with endedAt once until has passed (ruling R3)", async () => {
    const u = await owner("awcal", DUBAI_BRAND);
    await db.set(SEC_KEYS.cal(u.email), settings({ weekend: [5] }));
    await Promise.all([
      db.hset(SEC_KEYS.away(u.email), partyKey("أحمد")!, awayEntry("أحمد", "2026-10-08")),
      // Stored as a JSON string: read the same way.
      db.hset(SEC_KEYS.away(u.email), partyKey("Dana K")!, JSON.stringify(awayEntry("Dana K", "2026-10-06"))),
      db.hset(SEC_KEYS.away(u.email), partyKey("Sara")!, awayEntry("Sara", "2026-10-05")),
      // Malformed values are left out, silently.
      db.hset(SEC_KEYS.away(u.email), "bad1", "{not json"),
      db.hset(SEC_KEYS.away(u.email), "bad2", awayEntry("X", "2026-13-01")),
      db.hset(SEC_KEYS.away(u.email), "bad3", { until: "2026-10-08" }),
      db.hset(SEC_KEYS.away(u.email), "bad4", ["2026-10-08"]),
      db.hset(SEC_KEYS.away(u.email), "bad5", { label: "Y", until: "8 Oct" }),
    ]);
    const gets = vi.spyOn(db, "get"), hashes = vi.spyOn(db, "hgetall");
    // Tuesday 6 October 2026 in Dubai.
    const c = await calFor(u.email, local("2026-10-06T12:00", "Asia/Dubai"));
    expect(c.zone).toBe("Asia/Dubai");
    expect(c.cal.weekend).toEqual([5]);
    expect(c.cal.weekStart).toBe(6);
    expect(c.away).toEqual({
      [partyKey("أحمد")!]: { label: "أحمد", until: "2026-10-08" },
      // Today is the last away day: not ended yet.
      "dana k": { label: "Dana K", until: "2026-10-06" },
      sara: { label: "Sara", until: "2026-10-05", endedAt: "2026-10-05" },
    });
    expect(gets.mock.calls.filter(([k]) => k === SEC_KEYS.cal(u.email))).toHaveLength(1);
    expect(hashes.mock.calls.filter(([k]) => k === SEC_KEYS.away(u.email))).toHaveLength(1);

    // Nothing stored, or a value that is not settings: the country's defaults and nobody away.
    const v = await owner("awcal0", DUBAI_BRAND);
    await db.set(SEC_KEYS.cal(v.email), "weekend=5");
    const d = await calFor(v.email, local("2026-10-06T12:00", "Asia/Dubai"));
    expect(d).toMatchObject({ zone: "Asia/Dubai", away: {} });
    expect(d.cal.weekend).toEqual([6, 0]);
    expect(d.cal.weekStart).toBe(1);
  });

  it("agendaFor classifies with the brand's calendar and away map, and returns both", async () => {
    // A Riyadh brand whose weekend is Friday alone: Saturday is a working day.
    const u = await owner("awagenda");
    await db.set(SEC_KEYS.cal(u.email), settings({ weekend: [5] }));
    await db.hset(SEC_KEYS.away(u.email), partyKey("سارة")!, awayEntry("سارة", "2026-10-08"));
    await at(local("2026-10-01T09:00"), async () => {
      await make(u, { title: "Quote", direction: "they_owe", owedBy: "أحمد", dueAt: "2026-10-01T10:00" });
      await make(u, { title: "Samples", direction: "they_owe", owedBy: "ساره", dueAt: "2026-10-01T10:00" });
    });
    // Saturday 3 October 12:00: the zone's own weekend would hold the quote until Sunday; this brand's does not.
    const a = await agendaFor(u.email, local("2026-10-03T12:00"));
    expect(a.buckets.overdue.map((e) => e.item.title)).toEqual(["Quote"]);
    const away = a.buckets.waiting.find((e) => e.item.title === "Samples");
    // Back after Thursday 8 October; Friday 9 is this brand's weekend, so the chase is Saturday 10 October at 08:00.
    expect(away?.moment).toMatchObject({ why: "away", until: "2026-10-08", at: local("2026-10-10T08:00") });
    expect(a.cal.weekend).toEqual([5]);
    expect(a.away[partyKey("سارة")!]).toEqual({ label: "سارة", until: "2026-10-08" });
  });

  it("a Saudi brand's they-owe item gets its two working days around Eid al-Fitr 1448: Thursday 4 March → Monday 8 March, Sunday 7 March → Monday 15 March", async () => {
    const u = await owner("aweid");
    // Eid al-Fitr 1448 in Saudi Arabia is 9-12 March 2027; Friday 12 March is also the weekend (so `quiet`, which lists
    // only days off the weekend, leaves it out), and Sunday 14 March is the day in lieu (ruling R4a). The Sunday case
    // therefore lands on Monday 15 March, the first working day after it, not on the 14th.
    const cal = workCalendar(null, "Asia/Riyadh", local("2027-03-07T10:00"));
    expect(["2027-03-08", "2027-03-09", "2027-03-10", "2027-03-11", "2027-03-12", "2027-03-13", "2027-03-14", "2027-03-15"].map((d) => cal.quiet[d]?.kind ?? null)).toEqual([null, "eid_fitr", "eid_fitr", "eid_fitr", null, null, "holiday", null]);
    expect(cal.weekend).toEqual([5, 6]);

    const thu = await at(local("2027-03-04T10:00"), () => make(u, { title: "Thursday's quote", direction: "they_owe", owedBy: "أحمد" }));
    expect(expectDay(thu)).toBe("2027-03-08");
    expect(thu.expectBy).toBe(iso(local("2027-03-08T10:00")));

    await at(local("2027-03-07T10:00"), async () => {
      expect(expectDay(await make(u, { title: "Sunday's quote", direction: "they_owe", owedBy: "أحمد" }))).toBe("2027-03-15");
      // The chat and MCP tools reach the same two functions.
      const out = await runTool(u, "todo_create", { title: "From chat", direction: "they_owe", owed_by: "أحمد" }, [], [], undefined, { lang: "en" });
      const id = /\[id=(s[a-f0-9]{16})\]/.exec(out)![1];
      expect(expectDay(await getItem(u.email, id))).toBe("2027-03-15");
      const mine = await make(u, { title: "Mine, then theirs" });
      expect(await runTool(u, "todo_update", { id: mine.id, direction: "they_owe", owed_by: "أحمد" }, [], [], undefined, { lang: "en" })).toMatch(/^Updated/);
      expect(expectDay(await getItem(u.email, mine.id))).toBe("2027-03-15");
      // A caller that passes no calendar: changeItem reads it (with the zone) for a change that starts a chase clock.
      const dated = await make(u, { title: "Dated", direction: "they_owe", owedBy: "أحمد", dueAt: "2027-03-20T10:00" });
      const r = await changeItem(u.email, dated.id, { action: "reschedule", dueAt: null, allDay: false }, OWNER);
      expect(r.ok && expectDay(r.item)).toBe("2027-03-15");
    });
  });

  it("the PATCH route reads the calendar once and passes it on: the brand's week start for 'next week', its working days for a chase clock", async () => {
    // Thursday 1 October 2026. The login is made at the faked time too: a session older than its user is refused.
    await at(local("2026-10-01T10:00"), async () => {
      const u = await owner("awpatch");
      await db.set(SEC_KEYS.cal(u.email), settings({ weekend: [5] }));
      await signIn(u.email);
      const it = await make(u, { title: "Call back" });
      const gets = vi.spyOn(db, "get");
      const r = await patch(it.id, { action: "snooze", preset: "nextweek" });
      expect(r.status).toBe(200);
      // A Friday-only weekend starts the week on Saturday: next week is Saturday 3 October 09:00, not Sunday.
      expect((await r.json()).item.snoozeUntil).toBe(iso(local("2026-10-03T09:00")));
      expect(gets.mock.calls.filter(([k]) => k === SEC_KEYS.cal(u.email))).toHaveLength(1);
      gets.mockRestore();
    });

    // Saudi defaults, Sunday 7 March 2027: a debt that loses its date gets its clock back past Eid and the day in lieu.
    await at(local("2027-03-07T10:00"), async () => {
      const v = await owner("awpatcheid");
      await signIn(v.email);
      const debt = await make(v, { title: "Invoice", direction: "they_owe", owedBy: "أحمد", dueAt: "2027-03-20T10:00" });
      expect(debt.expectBy).toBeNull();
      const gets = vi.spyOn(db, "get");
      const r = await patch(debt.id, { action: "reschedule", dueAt: null });
      expect(r.status).toBe(200);
      expect(expectDay((await r.json()).item)).toBe("2027-03-15");
      expect(gets.mock.calls.filter(([k]) => k === SEC_KEYS.cal(v.email))).toHaveLength(1);
    });
  });

  it("in a Dubai brand, the evening wrap's 'tomorrow' leaves out a chase whose contact is away", async () => {
    const u = await owner("awwrap", DUBAI_BRAND);
    // Monday 5 October 2026 in Dubai; both are due Tuesday 10:00.
    await at(local("2026-10-05T10:00", "Asia/Dubai"), async () => {
      await make(u, { title: "Quote from Ahmad", direction: "they_owe", owedBy: "Ahmad", dueAt: "2026-10-06T10:00" });
      await make(u, { title: "Invoice from Sara", direction: "they_owe", owedBy: "Sara", dueAt: "2026-10-06T10:00" });
    });
    // Tuesday's wrap: "tomorrow" is Wednesday 09:00.
    const now = local("2026-10-06T18:00", "Asia/Dubai");
    expect((await buildWrap(u.email, now)).tomorrow.sort()).toEqual(["Invoice from Sara", "Quote from Ahmad"]);
    await db.hset(SEC_KEYS.away(u.email), partyKey("Ahmad")!, awayEntry("Ahmad", "2026-10-08"));
    expect((await buildWrap(u.email, now)).tomorrow).toEqual(["Invoice from Sara"]);
  });

  it("the wrap lists a contact's debt that fell due inside a pause when its chase moment comes: Riyadh, due Friday 2 October 10:00, in Sunday's wrap only", async () => {
    const u = await owner("awfell");
    await at(local("2026-10-01T12:00"), async () => {
      await make(u, { title: "Samples from the supplier", direction: "they_owe", owedBy: "المورّد", dueAt: "2026-10-02T10:00" });
      await make(u, { title: "My own report", dueAt: "2026-10-02T10:00" });
    });
    // Friday 18:00: the owner's own item fell overdue at its due time; the debt waits for Sunday 08:00.
    expect((await buildWrap(u.email, local("2026-10-02T18:00"))).fellOverdue).toEqual(["My own report"]);
    expect((await buildWrap(u.email, local("2026-10-03T18:00"))).fellOverdue).toEqual([]);
    // Sunday 18:00: its chase moment, Sunday 08:00, is inside (Saturday 18:00, Sunday 18:00].
    expect((await buildWrap(u.email, local("2026-10-04T18:00"))).fellOverdue).toEqual(["Samples from the supplier"]);
  });

  it("in Ramadan the 21:30 wrap lists a debt that became chaseable today, by its anchor, and puts it first for tomorrow at the 10:00 window (ruling R12)", async () => {
    const u = await owner("awramadan");
    // Ramadan 1448 in Riyadh, default hours 10:00-15:00. Tuesday 23 and Wednesday 24 February 2027 are ordinary Ramadan
    // days (Monday 22 is Founding Day, a quiet day, so the case sits on the Tuesday).
    const cal = workCalendar(null, "Asia/Riyadh", local("2027-02-23T21:30"));
    expect(["2027-02-23", "2027-02-24"].map((d) => [cal.ramadan.includes(d), cal.quiet[d] ?? null])).toEqual([[true, null], [true, null]]);
    expect(cal.ramadanHours).toEqual([{ from: "10:00", to: "15:00" }]);
    await at(local("2027-02-21T12:00"), () => make(u, { title: "Quote", direction: "they_owe", owedBy: "أحمد", dueAt: "2027-02-23T11:00" }));
    const now = local("2027-02-23T21:30");
    // At 21:30 the debt has been chaseable since 11:00 (its anchor), but chasing waits for tomorrow's window (its `at`):
    // the agenda shows it waiting, so neither `at` nor the overdue bucket alone would list it.
    const e = (await agendaFor(u.email, now)).buckets.waiting.find((x) => x.item.title === "Quote");
    expect(e?.moment).toMatchObject({ anchor: local("2027-02-23T11:00"), at: local("2027-02-24T10:00"), why: "ramadan" });
    const w = await buildWrap(u.email, now);
    expect(w.fellOverdue).toEqual(["Quote"]);
    // "Tomorrow" is read at Wednesday's first working moment, 10:00, not at 09:00 when chasing still waits.
    expect(w.tomorrow).toEqual(["Quote"]);
    // The next evening it is not listed again: its anchor is before that window.
    expect((await buildWrap(u.email, local("2027-02-24T21:30"))).fellOverdue).toEqual([]);
  });

  it("a Riyadh Thursday wrap reads 'tomorrow' at Sunday 08:00, the next working morning, so a chaseable debt is listed (ruling R12)", async () => {
    const u = await owner("awthursday");
    await at(local("2026-10-07T09:00"), async () => {
      await make(u, { title: "Quote from Ahmad", direction: "they_owe", owedBy: "Ahmad", dueAt: "2026-10-07T10:00" });
      await make(u, { title: "My report", dueAt: "2026-10-10T12:00" });
      // Chaseable at 08:30 Sunday: after the 08:00 brief, so not yet in "tomorrow".
      await make(u, { title: "Samples from Sara", direction: "they_owe", owedBy: "Sara", dueAt: "2026-10-11T08:30" });
    });
    // Friday 09:00 (the old "tomorrow") is the weekend: the quote has been chaseable since Wednesday 10:00 (anchor) but
    // waits for Sunday 08:00 (at).
    const fri = (await agendaFor(u.email, local("2026-10-09T09:00"))).buckets.waiting.find((x) => x.item.title === "Quote from Ahmad");
    expect(fri?.moment).toMatchObject({ anchor: local("2026-10-07T10:00"), at: local("2026-10-11T08:00"), why: "quiet" });
    expect((await buildWrap(u.email, local("2026-10-08T18:00"))).tomorrow).toEqual(["Quote from Ahmad", "My report"]);
  });

  it("agenda_get JSON-quotes a contact's name after 'owed by' and 'for', never an agent's", async () => {
    const u = await owner("awquote");
    const text = await at(local("2026-10-01T12:00"), async () => {
      await make(u, { title: "Quote", direction: "they_owe", owedBy: "أحمد", dueAt: "2026-10-05T10:00" });
      await make(u, { title: "Brief", direction: "they_owe", owedBy: "sami", dueAt: "2026-10-05T10:00" });
      await make(u, { title: "Offer", owedTo: 'Sara "S"', dueAt: "2026-10-05T10:00" });
      return runTool(u, "agenda_get", {}, [], [], undefined, { lang: "en" });
    });
    expect(text).toContain('· owed by "أحمد" ·');
    expect(text).toContain("· owed by Sami ·");
    expect(text).toContain(`· the owner's (for "Sara \\"S\\"")`);
  });

  it("account deletion removes sec:cal and sec:away of every brand scope (extends rules 201 and 306)", async () => {
    const u = await owner("awwipe");
    await saveBrands(u.email, [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, { id: "b2", name: "Two", createdAt: new Date().toISOString(), status: "active" }]);
    const scopes = [u.email, scopeFor(u.email, "b2")];
    await Promise.all(scopes.flatMap((s) => [db.set(SEC_KEYS.cal(s), settings({ weekend: [5] })), db.hset(SEC_KEYS.away(s), "sara", awayEntry("Sara", "2026-10-08"))]));
    expect(SEC_KEYS.cal(u.email)).toBe(`sec:cal:${u.email}`);
    expect(SEC_KEYS.away(u.email)).toBe(`sec:away:${u.email}`);
    await wipeAccount(u.email);
    expect(await Promise.all(scopes.map((s) => db.get(SEC_KEYS.cal(s))))).toEqual([null, null]);
    expect(await Promise.all(scopes.map((s) => db.hgetall(SEC_KEYS.away(s))))).toEqual([{}, {}]);
  });

  it("GET /api/secretary keeps the calendar and the away map on the server (ruling R11)", async () => {
    const u = await owner("awget");
    await db.set(SEC_KEYS.cal(u.email), settings({ weekend: [5] }));
    await db.hset(SEC_KEYS.away(u.email), partyKey("Sara Q")!, awayEntry("Sara Q", "2099-01-01"));
    await signIn(u.email);
    const j = await (await listRoute.GET(json("/api/secretary", "GET"))).json();
    expect(j.ok).toBe(true);
    expect(Object.keys(j.agenda.buckets).length).toBeGreaterThan(0);
    expect(j.agenda).not.toHaveProperty("cal");
    expect(j.agenda).not.toHaveProperty("away");
    expect(JSON.stringify(j)).not.toContain("Sara Q");
  });

  it("a Working days record the calendar cannot be built from falls back to the defaults, logging the error's name only (ruling R13)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of [{ v: 1, holidays: { add: "x" } }, { v: 1, weekend: [5], ramadanHours: [null] }]) {
      const u = await owner("awbad");
      await db.set(SEC_KEYS.cal(u.email), bad);
      const a = await agendaFor(u.email, local("2026-10-01T12:00"));
      expect(a.cal.weekend, JSON.stringify(bad)).toEqual(bad.weekend ?? [5, 6]);
      expect(a.cal.ramadanHours).toEqual([{ from: "10:00", to: "15:00" }]);
      expect(a.open).toBe(0);
    }
    // Ramadan hours are checked again when the calendar is built: `[null]` reads as the default hours, and the rest of
    // the record (its Friday-only weekend) still applies; only a record the build cannot read at all logs.
    expect(errors.mock.calls).toEqual([["sec calendar unreadable, defaults used", { error: "TypeError" }]]);
  });

  it("stored Ramadan hours are checked again when the calendar is built: hours parseCalendar would refuse (a hand-edited {from: 5}) read as the default 10:00-15:00, so a Ramadan day's agenda still builds", async () => {
    const bad: unknown[] = [[{ from: 5 }], [{ from: "10:00" }], [{ from: "15:00", to: "10:00" }], [{ from: "10:10", to: "15:00" }], [{ from: "09:00", to: "12:00" }, { from: "11:00", to: "13:00" }]];
    for (const hours of bad) {
      const u = await owner("awhours");
      await db.set(SEC_KEYS.cal(u.email), settings({ ramadanHours: hours as SecCalendar["ramadanHours"] }));
      await make(u, { title: "Quote", direction: "they_owe", owedBy: "أحمد", dueAt: "2027-02-23T07:00" });
      const a = await at(local("2027-02-23T08:00"), () => agendaFor(u.email, local("2027-02-23T08:00")));
      expect(a.cal.ramadanHours, JSON.stringify(hours)).toEqual([{ from: "10:00", to: "15:00" }]);
      expect(a.buckets.waiting[0].moment, JSON.stringify(hours)).toMatchObject({ at: local("2027-02-23T10:00"), why: "ramadan" });
    }
    // Hours that check out are the brand's own, and [] (no limit) stays.
    expect(workCalendar(settings({ ramadanHours: [{ from: "09:00", to: "12:00" }] }), "Asia/Riyadh", local("2026-10-01T12:00")).ramadanHours).toEqual([{ from: "09:00", to: "12:00" }]);
    expect(workCalendar(settings({ ramadanHours: [] }), "Asia/Riyadh", local("2026-10-01T12:00")).ramadanHours).toEqual([]);
  });

  it("system() names the brand's week start: a Friday-only weekend starts the week on Saturday", () => {
    const u = { email: "x@test.example", credits: 5, plan: "starter", trialEnds: "2026-10-01" } as User;
    expect(system(BRAND, u, [], "", [], [], "reem")[2].text).toContain("The work week starts on Sunday.");
    expect(system(BRAND, u, [], "", [], [], "reem", undefined, undefined, [5])[2].text).toContain("The work week starts on Saturday.");
    expect(system(DUBAI_BRAND, u, [], "", [], [], "noor")[2].text).toContain("The work week starts on Monday.");
  });

  it("chat() reads sec:cal with its other reads and gives the prompt the brand's week start (a malformed record: the defaults)", async () => {
    const sent: { system: { text: string }[] }[] = [];
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    claudeOn();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        static BadRequestError = class extends Error {};
// The agent-scope classifier streams since the 2026-10-12 build batch (rule 980) and forces its `verdict` tool. It gets
        // no answer here, as when it called the `create` this mock never had, so the scripted turns stay the chat's.
        messages = { stream: (p: { system: { text: string }[] } & { tool_choice?: { name?: string } }) => { if (p.tool_choice?.name === "verdict") throw new Error("no classifier in this test"); sent.push(p); return { finalMessage: async () => ({ model: "m", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "تمام" }] }) }; } };
      },
    }));
    try {
      const u = await owner("awchat");
      await db.set(SEC_KEYS.cal(u.email), settings({ weekend: [5] }));
      const { chat } = await import("@/lib/chat");
      await chat(u, "وش عندي هالأسبوع؟", undefined, "reem");
      expect(sent).toHaveLength(1);
      expect(sent[0].system[2].text).toContain("The work week starts on Saturday.");
      // Ruling R13: a record the calendar cannot be built from never stops a chat turn; the zone's own week start is used.
      vi.spyOn(console, "error").mockImplementation(() => {});
      const v = await owner("awchatbad");
      await db.set(SEC_KEYS.cal(v.email), { v: 1, holidays: { add: "x" } });
      await chat(v, "مرحبا", undefined, "noor");
      expect(sent).toHaveLength(2);
      expect(sent[1].system[2].text).toContain("The work week starts on Sunday.");
    } finally {
      vi.doUnmock("@anthropic-ai/sdk");
      vi.doUnmock("@/lib/model");
      vi.unstubAllEnvs();
    }
  });
});

// Rules 481-483: the away list (`sec:away:{scope}`, src/lib/secretary-away.ts) and its route. "Now" is Tuesday 6 October
// 2026, 12:00 in Riyadh, unless a case says otherwise: today 2026-10-06, yesterday 2026-10-05.
const NOW = local("2026-10-06T12:00");
const PERSON: Who = { actor: "owner", via: "web", login: "owner-login@test.example" };
const awayKeys = async (scope: string) => Object.keys(await db.hgetall(SEC_KEYS.away(scope))).sort();
const auditLines = async (scope: string) => (await db.lrange(SEC_KEYS.audit(scope), 0, -1)).map((x) => JSON.parse(x)).reverse();
const awayGet = () => awayRoute.GET();
const awayPut = (body: unknown) => awayRoute.PUT(json("/api/secretary/away", "PUT", body));
const awayDel = (body: unknown) => awayRoute.DELETE(json("/api/secretary/away", "DELETE", body));

describe("rule 481: an away contact is matched by partyKey, and only a contact can be away", () => {
  it("partyKey maps «أحمد», «احمد», «إحمد», «أحمد» with a trailing space and «أح­مد» with a soft hyphen to one key, and setAway keeps one field for them", async () => {
    const forms = ["احمد", "إحمد", "أح­مد", "أحمد", "أحمد "];
    expect(new Set(forms.map((f) => partyKey(f)))).toEqual(new Set(["احمد"]));
    const u = await owner("aw481a");
    for (const label of forms) expect((await setAway(u.email, { label, until: "2026-10-08" }, PERSON, NOW, "Asia/Riyadh")).ok, label).toBe(true);
    expect(await awayKeys(u.email)).toEqual(["احمد"]);
    // The last write wins, its label cleaned the way an item's party is.
    expect(await db.hgetall(SEC_KEYS.away(u.email))).toEqual({ احمد: { label: "أحمد", until: "2026-10-08", by: PERSON.login, via: "web", at: iso(NOW) } });
  });

  it("refuses the owner and every agent as not_contact, however they are written: «ＤＡＮＡ», 'owner', «أنا», 'reem', 'Me', «انا»; nothing is written", async () => {
    const u = await owner("aw481b");
    for (const label of ["ＤＡＮＡ", "owner", "أنا", "reem", "Me", " YOU ", "انا", ...AGENT_IDS, ...OWNER_ALIASES]) {
      expect(await setAway(u.email, { label, until: "2026-10-08" }, PERSON, NOW, "Asia/Riyadh"), label).toMatchObject({ ok: false, error: "not_contact", field: "label", status: 400 });
    }
    expect(await awayKeys(u.email)).toEqual([]);
    expect(await auditLines(u.email)).toEqual([]);
    // A contact whose name holds an agent's is a contact.
    expect((await setAway(u.email, { label: "Dana Khalid", until: "2026-10-08" }, PERSON, NOW, "Asia/Riyadh")).ok).toBe(true);
  });

  it("a key of 81 characters is too_long (also when NFKC makes a short label long); an empty, invisible or non-string label is bad_request", async () => {
    const u = await owner("aw481c");
    const put = (label: unknown) => setAway(u.email, { label, until: "2026-10-08" }, PERSON, NOW, "Asia/Riyadh");
    expect(await put("a".repeat(81))).toMatchObject({ ok: false, error: "too_long", field: "label", status: 400 });
    // Five characters, each «صلى الله عليه وسلم» once folded: a 90-character key.
    expect(partyKey("ﷺ".repeat(5))).toBeNull();
    expect(await put("ﷺ".repeat(5))).toMatchObject({ ok: false, error: "too_long", field: "label" });
    for (const label of ["", "   ", "­​", 42, null, undefined, ["Sara"]]) {
      expect(await put(label), JSON.stringify(label)).toMatchObject({ ok: false, error: "bad_request", field: "label", status: 400 });
    }
    expect(await awayKeys(u.email)).toEqual([]);
    expect((await put("a".repeat(80))).ok).toBe(true);
  });

  it("a label whose key is __proto__, constructor or prototype is bad_request on set, end and proposal (ruling R22): the store's HGETALL would hide such a field", async () => {
    const u = await owner("aw481e");
    for (const label of ["__proto__", "constructor", "prototype", "Constructor", " PROTOTYPE ", "__PROTO__"]) {
      expect(await setAway(u.email, { label, until: "2026-10-08" }, PERSON, NOW, "Asia/Riyadh"), label).toMatchObject({ ok: false, error: "bad_request", field: "label", status: 400 });
      expect(await endAway(u.email, label, PERSON, NOW, "Asia/Riyadh"), label).toMatchObject({ ok: false, error: "bad_request", field: "label", status: 400 });
      expect(await proposeAway(u.email, { name: label, until: "2026-10-08" }, NOW, "Asia/Riyadh"), label).toMatchObject({ ok: false, error: "bad_request", field: "name", status: 400 });
    }
    expect(await awayKeys(u.email)).toEqual([]);
    expect(await db.smembers(SEC_KEYS.awayProps(u.email))).toEqual([]);
    expect(await auditLines(u.email)).toEqual([]);
    // A name that only holds one of them is a contact.
    expect((await setAway(u.email, { label: "Constructor Co", until: "2026-10-08" }, PERSON, NOW, "Asia/Riyadh")).ok).toBe(true);
  });

  it("an item owed by «احمد» shows as away when the entry is «أحمد»", async () => {
    const u = await owner("aw481d");
    await at(local("2026-10-01T09:00"), () => make(u, { title: "Quote", direction: "they_owe", owedBy: "احمد", dueAt: "2026-10-05T10:00" }));
    expect((await agendaFor(u.email, NOW)).buckets.overdue.map((e) => e.item.title)).toEqual(["Quote"]);
    expect((await setAway(u.email, { label: "أحمد", until: "2026-10-08" }, PERSON, NOW, "Asia/Riyadh")).ok).toBe(true);
    const e = (await agendaFor(u.email, NOW)).buckets.waiting.find((x) => x.item.title === "Quote");
    // Back after Thursday 8 October; Friday and Saturday are the Riyadh weekend: chased Sunday 11 October at 08:00.
    expect(e?.moment).toMatchObject({ why: "away", until: "2026-10-08", at: local("2026-10-11T08:00") });
  });
});

describe("rule 482: the away list's limits: dates, the 200-field cap, the note, ending, the clean-up and the audit", () => {
  it(`until is today to today + ${AWAY_AHEAD_DAYS} days in the brand's zone: yesterday and today + 367 are away_range, a day that is not one is bad_date`, async () => {
    expect([AWAY_MAX, AWAY_AHEAD_DAYS, AWAY_KEEP_DAYS]).toEqual([200, 366, 30]);
    const u = await owner("aw482a");
    const put = (until: unknown, now = NOW, zone: "Asia/Riyadh" | "Asia/Dubai" = "Asia/Riyadh") => setAway(u.email, { label: "Sara", until }, PERSON, now, zone);
    expect(await put("2026-10-05")).toMatchObject({ ok: false, error: "away_range", field: "until", status: 400 });
    expect(await put(addDays("2026-10-06", 367))).toMatchObject({ ok: false, error: "away_range", field: "until" });
    for (const bad of ["2026-02-30", "8 Oct", "2026-10-08T10:00", 20261008, undefined]) expect(await put(bad), String(bad)).toMatchObject({ ok: false, error: "bad_date", field: "until" });
    expect(await awayKeys(u.email)).toEqual([]);
    expect(await put("2026-10-06")).toMatchObject({ ok: true, entry: { until: "2026-10-06" } });
    expect(await put(addDays("2026-10-06", 366))).toMatchObject({ ok: true, entry: { until: "2027-10-07" } });
    // 20:30 UTC is 23:30 in Riyadh and already 00:30 on Wednesday 7 October in Dubai: "today" is the brand's.
    const late = Date.parse("2026-10-06T20:30:00Z");
    expect((await put("2026-10-06", late, "Asia/Riyadh")).ok).toBe(true);
    expect(await put("2026-10-06", late, "Asia/Dubai")).toMatchObject({ ok: false, error: "away_range" });
  });

  it("the 201st field is away_limit even when earlier entries have ended; replacing a stored contact adds no field", async () => {
    const u = await owner("aw482b");
    // 200 fields, three quarters of them ended.
    await Promise.all(Array.from({ length: AWAY_MAX }, (_, i) => db.hset(SEC_KEYS.away(u.email), `c${i}`, awayEntry(`C${i}`, i < 150 ? "2026-09-20" : "2026-10-20"))));
    expect(await setAway(u.email, { label: "New contact", until: "2026-10-09" }, PERSON, NOW, "Asia/Riyadh")).toMatchObject({ ok: false, error: "away_limit", status: 409 });
    expect(await awayKeys(u.email)).toHaveLength(AWAY_MAX);
    expect(await setAway(u.email, { label: "c3", until: "2026-10-09" }, PERSON, NOW, "Asia/Riyadh")).toMatchObject({ ok: true, entry: { label: "c3", until: "2026-10-09" } });
    expect(await awayKeys(u.email)).toHaveLength(AWAY_MAX);
  });

  it("two concurrent PUTs at 199 fields leave 200: one is saved, the other is away_limit", async () => {
    await at(NOW, async () => {
      const u = await owner("aw482c");
      await signIn(u.email);
      await Promise.all(Array.from({ length: AWAY_MAX - 1 }, (_, i) => db.hset(SEC_KEYS.away(u.email), `c${i}`, awayEntry(`C${i}`, "2026-10-20"))));
      const rs = await Promise.all([awayPut({ label: "Sara", until: "2026-10-09" }), awayPut({ label: "Huda", until: "2026-10-09" })]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await awayKeys(u.email)).toHaveLength(AWAY_MAX);
    });
  });

  it("the note goes through cleanLine and is at most 200 characters after cleaning", async () => {
    const u = await owner("aw482d");
    const put = (note: unknown) => setAway(u.email, { label: "Sara", until: "2026-10-09", note }, PERSON, NOW, "Asia/Riyadh");
    expect(await put("  Hajj‮ trip \n back\tSunday  ")).toMatchObject({ ok: true, entry: { note: "Hajj trip back Sunday" } });
    expect((await db.hgetall<{ note?: string }>(SEC_KEYS.away(u.email))).sara.note).toBe("Hajj trip back Sunday");
    expect(await put("x".repeat(201))).toMatchObject({ ok: false, error: "too_long", field: "note", status: 400 });
    expect(await put("x".repeat(200) + "​​")).toMatchObject({ ok: true, entry: { note: "x".repeat(200) } });
    expect(await put(42)).toMatchObject({ ok: false, error: "bad_text", field: "note" });
    // A blank note, or none, is no note.
    const blank = await put("  \n ");
    expect(blank.ok && blank.entry).not.toHaveProperty("note");
    expect((await db.hgetall<object>(SEC_KEYS.away(u.email))).sara).not.toHaveProperty("note");
  });

  it("ending keeps the field with until set to yesterday (the back alert reads it); ending it again changes nothing, and only remove: true deletes a field (rulings R19, R21); an unknown name is not_found", async () => {
    const u = await owner("aw482e");
    await setAway(u.email, { label: "Sara", until: "2026-10-20", note: "Leave" }, PERSON, NOW, "Asia/Riyadh");
    const ended = await endAway(u.email, " SARA ", PERSON, NOW, "Asia/Riyadh");
    expect(ended).toMatchObject({ ok: true, removed: false, changed: true, entry: { label: "Sara", until: "2026-10-05", note: "Leave" } });
    const stored = { sara: { label: "Sara", until: "2026-10-05", note: "Leave", by: PERSON.login, via: "web", at: iso(NOW) } };
    expect(await db.hgetall(SEC_KEYS.away(u.email))).toEqual(stored);
    expect((await calFor(u.email, NOW)).away.sara).toEqual({ label: "Sara", until: "2026-10-05", endedAt: "2026-10-05" });
    // Two ends in a row (a double click on "End now", or the next day): the entry stays as the first end left it, with
    // its back alert.
    expect(await endAway(u.email, "Sara", PERSON, NOW, "Asia/Riyadh")).toMatchObject({ ok: true, removed: false, changed: false, entry: { until: "2026-10-05" } });
    expect(await endAway(u.email, "sara", PERSON, NOW + 864e5, "Asia/Riyadh")).toMatchObject({ ok: true, removed: false, changed: false });
    expect(await db.hgetall(SEC_KEYS.away(u.email))).toEqual(stored);
    // Today was the last away day: ending it now still makes yesterday the last one.
    await setAway(u.email, { label: "Huda", until: "2026-10-06" }, PERSON, NOW, "Asia/Riyadh");
    expect(await endAway(u.email, "Huda", PERSON, NOW, "Asia/Riyadh")).toMatchObject({ ok: true, removed: false, changed: true, entry: { until: "2026-10-05" } });
    // Only an explicit remove deletes the field: an ended one (freeing it for the cap), or a running one.
    expect(await endAway(u.email, "Sara", PERSON, NOW, "Asia/Riyadh", { remove: true })).toMatchObject({ ok: true, removed: true, changed: true, entry: { label: "Sara" } });
    await setAway(u.email, { label: "Nour", until: "2026-10-20" }, PERSON, NOW, "Asia/Riyadh");
    expect(await endAway(u.email, "Nour", PERSON, NOW, "Asia/Riyadh", { remove: true })).toMatchObject({ ok: true, removed: true });
    expect(await awayKeys(u.email)).toEqual(["huda"]);
    expect(await endAway(u.email, "Sara", PERSON, NOW, "Asia/Riyadh", { remove: true })).toMatchObject({ ok: false, error: "not_found", status: 404 });
    expect(await endAway(u.email, "Nobody", PERSON, NOW, "Asia/Riyadh")).toMatchObject({ ok: false, error: "not_found", status: 404 });
    expect(await endAway(u.email, 42, PERSON, NOW, "Asia/Riyadh")).toMatchObject({ ok: false, error: "bad_request", field: "label" });
    expect(await endAway(u.email, "a".repeat(81), PERSON, NOW, "Asia/Riyadh")).toMatchObject({ ok: false, error: "too_long", field: "label" });
  });

  it(`cleanAway removes only fields whose until is more than ${AWAY_KEEP_DAYS} days past (and values that are not entries), all in one round of HDEL`, async () => {
    const u = await owner("aw482f");
    const key = SEC_KEYS.away(u.email);
    await Promise.all([
      db.hset(key, "old31", awayEntry("Old 31", "2026-09-05")),
      db.hset(key, "old30", awayEntry("Old 30", "2026-09-06")),
      db.hset(key, "ended8", awayEntry("Ended 8", "2026-09-28")),
      db.hset(key, "today", awayEntry("Today", "2026-10-06")),
      db.hset(key, "later", awayEntry("Later", "2026-11-01")),
      db.hset(key, "junk", "{not json"),
    ]);
    // Every HDEL is sent before the first one answers: one round, not one after the other.
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const real = db.hdel.bind(db);
    const hdel = vi.spyOn(db, "hdel").mockImplementation(async (k, f) => { await gate; return real(k, f); });
    const run = cleanAway(u.email, NOW, "Asia/Riyadh");
    await vi.waitFor(() => expect(hdel).toHaveBeenCalledTimes(2));
    open();
    expect(await run).toBe(2);
    expect(hdel.mock.calls.map((c) => c[1]).sort()).toEqual(["junk", "old31"]);
    expect(await awayKeys(u.email)).toEqual(["ended8", "later", "old30", "today"]);
    expect((await auditLines(u.email)).map((l) => [l.action, l.actor, l.diff])).toEqual([["away_clean", "cron", "2 away contact(s) ended over 30 days ago"]]);
    hdel.mockRestore();
    // Nothing left to remove: one read, no lock, no audit line.
    const lock = vi.spyOn(db, "lock");
    expect(await cleanAway(u.email, NOW, "Asia/Riyadh")).toBe(0);
    expect(lock).not.toHaveBeenCalled();
    expect(await auditLines(u.email)).toHaveLength(1);
  });

  it("secretaryDaily runs the clean-up next to the purge", async () => {
    const u = await owner("aw482g");
    await Promise.all([db.hset(SEC_KEYS.away(u.email), "old", awayEntry("Old", "2026-08-01")), db.hset(SEC_KEYS.away(u.email), "sara", awayEntry("Sara", "2026-10-09"))]);
    const r = await secretaryDaily(u.email, NOW);
    expect(r).toMatchObject({ purged: 0, closed: 0, awayCleaned: 1 });
    expect(await awayKeys(u.email)).toEqual(["sara"]);
    // A store failure in the clean-up does not stop the daily job (the agenda and the auto-close still run). Fresh
    // modules: an earlier test resets the registry, and the daily job loads secretary-away.ts (and its `db`) by a dynamic
    // import, so the spy must sit on the instance that graph uses. The clean-up's read is the job's first HGETALL.
    vi.resetModules();
    const fresh = { db: (await import("@/lib/db")).db, daily: (await import("@/lib/secretary")).secretaryDaily };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fresh.db, "hgetall").mockRejectedValueOnce(new TypeError("store down"));
    await db.hset(SEC_KEYS.away(u.email), "old", awayEntry("Old", "2026-08-01"));
    expect(await fresh.daily(u.email, NOW)).toMatchObject({ awayCleaned: 0, closed: 0 });
    expect(errors.mock.calls).toContainEqual(["sec away clean-up failed", { error: "TypeError" }]);
    expect(await awayKeys(u.email)).toEqual(["old", "sara"]);
  });

  it("every write leaves an away or away_end audit line with the login, the label and the date", async () => {
    const u = await owner("aw482h");
    await setAway(u.email, { label: "أحمد", until: "2026-10-08", note: "Private note" }, PERSON, NOW, "Asia/Riyadh");
    await setAway(u.email, { label: "احمد", until: "2026-10-09" }, PERSON, NOW, "Asia/Riyadh");
    await endAway(u.email, "أحمد", PERSON, NOW, "Asia/Riyadh");
    // Ending it again changes nothing, so it writes no line (ruling R21); removing it does.
    await endAway(u.email, "أحمد", PERSON, NOW, "Asia/Riyadh");
    await endAway(u.email, "أحمد", PERSON, NOW, "Asia/Riyadh", { remove: true });
    // Refusals write nothing.
    await setAway(u.email, { label: "reem", until: "2026-10-08" }, PERSON, NOW, "Asia/Riyadh");
    await endAway(u.email, "Nobody", PERSON, NOW, "Asia/Riyadh");
    const lines = await auditLines(u.email);
    expect(lines.map((l) => [l.action, l.actor, l.via, l.login, l.diff])).toEqual([
      ["away", "owner", "web", PERSON.login, 'label="أحمد"; until=2026-10-08'],
      ["away", "owner", "web", PERSON.login, 'label="احمد"; until=2026-10-09'],
      ["away_end", "owner", "web", PERSON.login, 'label="احمد"; until=2026-10-05'],
      ["away_end", "owner", "web", PERSON.login, 'label="احمد"; removed'],
    ]);
    // The note stays out of the audit.
    expect(JSON.stringify(lines)).not.toContain("Private note");
  });

  it("the refusals are worded for Reem's tools and the page, with the real limits", () => {
    const words = (error: "not_contact" | "away_range" | "away_limit") => toolError({ ok: false, error, status: 400 });
    expect(words("not_contact")).toMatch(/owner or an agent/);
    expect(words("away_range")).toContain(`${AWAY_AHEAD_DAYS} days`);
    expect(words("away_limit")).toContain(String(AWAY_MAX));
    for (const lang of ["ar", "en"] as const) {
      for (const k of ["not_contact", "away_range", "away_limit", "too_long", "bad_date"]) expect(appDict[lang].todo.errors[k], `${lang}.${k}`).toBeTruthy();
    }
    expect(appDict.ar.todo.errors.away_limit).toContain(String(AWAY_MAX));
    expect(appDict.en.todo.errors.away_limit).toContain(String(AWAY_MAX));
  });
});

describe("rule 483: the away route (GET, PUT, DELETE /api/secretary/away): a session, the role, the rate limit, the caller's scope", () => {
  it("refuses an anonymous caller with 401 on every method, before anything is read", async () => {
    signOut();
    const hashes = vi.spyOn(db, "hgetall");
    expect((await awayGet()).status).toBe(401);
    expect((await awayPut({ label: "Sara", until: "2026-10-09" })).status).toBe(401);
    expect((await awayDel({ label: "Sara" })).status).toBe(401);
    expect(hashes).not.toHaveBeenCalled();
  });

  it("a member reads, marks away and ends; the entry and the audit name the member; only label, until and note are read from the body", async () => {
    await at(NOW, async () => {
      const o = await owner("aw483a");
      const m = await newMember(o, "member", "aw483m");
      await signIn(m.email);
      const r = await awayPut({ label: " Sara ", until: "2026-10-09", note: "Leave", by: "x@evil.example", via: "chat", at: "1999-01-01", scope: "other@test.example", email: "other@test.example", ended: true });
      expect(r.status).toBe(200);
      const entry = { label: "Sara", until: "2026-10-09", note: "Leave", by: m.email, via: "web", at: iso(NOW) };
      expect((await r.json()).entry).toEqual(entry);
      expect(await db.hgetall(SEC_KEYS.away(o.email))).toEqual({ sara: entry });
      expect(await db.hgetall(SEC_KEYS.away("other@test.example"))).toEqual({});
      expect(await (await awayGet()).json()).toEqual({ ok: true, entries: [{ ...entry, ended: false }] });
      const d = await awayDel({ label: "sara", until: "2027-01-01" });
      expect(d.status).toBe(200);
      expect(await d.json()).toMatchObject({ ok: true, removed: false, changed: true, entry: { label: "Sara", until: "2026-10-05" } });
      expect((await (await awayGet()).json()).entries).toEqual([{ ...entry, until: "2026-10-05", ended: true }]);
      expect((await auditLines(o.email)).map((l) => [l.action, l.login])).toEqual([["away", m.email], ["away_end", m.email]]);
      // DELETE is idempotent (ruling R21): a second "End now" is 200 and keeps the ended entry; removing it takes
      // `remove: true`, which must be a boolean.
      const again = await awayDel({ label: "Sara" });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ ok: true, removed: false, changed: false, entry: { until: "2026-10-05" } });
      expect((await (await awayGet()).json()).entries).toEqual([{ ...entry, until: "2026-10-05", ended: true }]);
      expect(await auditLines(o.email)).toHaveLength(2);
      for (const remove of ["yes", 1, null]) expect((await awayDel({ label: "Sara", remove })).status, JSON.stringify(remove)).toBe(400);
      expect(await awayKeys(o.email)).toEqual(["sara"]);
      const gone = await awayDel({ label: "Sara", remove: true });
      expect(gone.status).toBe(200);
      expect(await gone.json()).toMatchObject({ ok: true, removed: true, changed: true });
      expect((await (await awayGet()).json()).entries).toEqual([]);
      expect((await auditLines(o.email)).map((l) => [l.action, l.login, l.diff])).toEqual([["away", m.email, 'label="Sara"; until=2026-10-09'], ["away_end", m.email, 'label="Sara"; until=2026-10-05'], ["away_end", m.email, 'label="Sara"; removed']]);
      // Refusals keep their code and field; a body that is not an object is bad_request.
      expect(await (await awayPut({ label: "reem", until: "2026-10-09" })).json()).toEqual({ ok: false, error: "not_contact", field: "label" });
      expect((await awayPut({ label: "Huda", until: "2026-10-05" })).status).toBe(400);
      expect((await awayDel({ label: "Nobody" })).status).toBe(404);
      for (const body of ["Sara", ["Sara"], null]) {
        expect((await awayPut(body)).status, JSON.stringify(body)).toBe(400);
        expect((await awayDel(body)).status, JSON.stringify(body)).toBe(400);
      }
    });
  });

  it("the rate limits apply: sec:read for GET, sec:write for PUT and DELETE, with nothing changed", async () => {
    await at(NOW, async () => {
      const u = await owner("aw483b");
      await signIn(u.email);
      await db.hset(SEC_KEYS.away(u.email), "sara", awayEntry("Sara", "2026-10-09"));
      await db.set(`rate:sec:read:${u.email}`, SEC_READS_PER_HOUR, 3600);
      expect((await awayGet()).status).toBe(429);
      await db.set(`rate:sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600);
      expect((await awayPut({ label: "Huda", until: "2026-10-09" })).status).toBe(429);
      expect((await awayDel({ label: "Sara" })).status).toBe(429);
      expect(await db.hgetall(SEC_KEYS.away(u.email))).toEqual({ sara: awayEntry("Sara", "2026-10-09") });
    });
  });

  it("a PUT in brand A never touches brand B's hash, whatever the body names, and a DELETE in A cannot end B's entry", async () => {
    await at(NOW, async () => {
      const u = await owner("aw483c", BRAND);
      const b2 = scopeFor(u.email, "b2");
      await saveBrands(u.email, [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, { id: "b2", name: "Two", createdAt: new Date().toISOString(), status: "active" }]);
      await saveBrand(b2, { ...BRAND, name: "Two" });
      await signIn(u.email);
      await seedActiveBrand(u.email, "b2");
      expect((await awayPut({ label: "Sara", until: "2026-10-09", scope: u.email })).status).toBe(200);
      expect(await awayKeys(b2)).toEqual(["sara"]);
      expect(await awayKeys(u.email)).toEqual([]);
      await seedActiveBrand(u.email, "default");
      expect((await awayDel({ label: "Sara", scope: b2 })).status).toBe(404);
      expect((await (await awayGet()).json()).entries).toEqual([]);
      expect((await db.hgetall<{ until: string }>(SEC_KEYS.away(b2))).sara.until).toBe("2026-10-09");
    });
  });

  it("GET lists running entries first (soonest back first), then ended ones (latest first) with ended: true; values that are not entries are left out", async () => {
    await at(NOW, async () => {
      const u = await owner("aw483d");
      await signIn(u.email);
      const key = SEC_KEYS.away(u.email);
      await Promise.all([
        db.hset(key, "a", awayEntry("A", "2026-10-20")),
        db.hset(key, "b", awayEntry("B", "2026-10-06")),
        db.hset(key, "c", awayEntry("C", "2026-10-01")),
        db.hset(key, "d", JSON.stringify(awayEntry("D", "2026-09-10"))),
        db.hset(key, "junk", { label: "X", until: "soon" }),
      ]);
      const j = await (await awayGet()).json();
      expect(j.entries.map((e: { label: string; ended: boolean }) => [e.label, e.ended])).toEqual([["B", false], ["A", false], ["C", true], ["D", true]]);
      expect(await listAway(u.email, NOW, "Asia/Riyadh")).toEqual(j.entries);
    });
  });
});

// Rule 484: the Working days route (`sec:cal:{scope}`, src/app/api/secretary/calendar/route.ts). "Now" is `NOW` above.
const calGet = () => calRoute.GET();
const calPut = (body: unknown) => calRoute.PUT(json("/api/secretary/calendar", "PUT", body));
const storedCal = (scope: string) => db.get<SecCalendar>(SEC_KEYS.cal(scope));
/** A Riyadh brand's `parseCalendar` result at `now`, which a PUT must store as it is. */
function parsed(body: Record<string, unknown>, now: number, login: string): SecCalendar {
  const p = parseCalendar(body, now, "Asia/Riyadh", login);
  if (!p.ok) throw new Error(`parseCalendar: ${p.error}`);
  return p.cal;
}

describe("rule 484: the Working days route (GET, PUT /api/secretary/calendar): a session, the role, the rate limit, the caller's scope, the saved settings", () => {
  it("refuses an anonymous caller with 401 on both methods, before anything is read or written", async () => {
    signOut();
    const reads = vi.spyOn(db, "get"), counters = vi.spyOn(db, "incrby"), writes = vi.spyOn(db, "set"), locks = vi.spyOn(db, "lock");
    expect((await calGet()).status).toBe(401);
    expect((await calPut({ weekend: [5] })).status).toBe(401);
    expect(await (await calPut({ weekend: [5] })).json()).toEqual({ ok: false, error: "unauthorized" });
    for (const spy of [reads, counters, writes, locks]) expect(spy).not.toHaveBeenCalled();
  });

  it("a member reads but cannot save: PUT is 403 with nothing stored, audited or counted", async () => {
    await at(NOW, async () => {
      const o = await owner("c484m");
      const m = await newMember(o, "member", "c484mm");
      await signIn(m.email);
      expect((await calGet()).status).toBe(200);
      const r = await calPut({ weekend: [5] });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "forbidden" });
      expect(await storedCal(o.email)).toBeNull();
      expect(await auditLines(o.email)).toEqual([]);
      expect(await db.get(`rate:sec:cal:${o.email}`)).toBeNull();
    });
  });

  it("an admin's PUT is 200 and stores the parsed body plus updatedAt and updatedBy; one calendar audit line names the login; the write runs under the calendar's lock", async () => {
    await at(NOW, async () => {
      const o = await owner("c484a");
      const a = await newMember(o, "admin", "c484aa");
      await signIn(a.email);
      const locks = vi.spyOn(db, "lock");
      const body = { weekend: [5], ramadanHours: [{ from: "10:00", to: "14:00" }], holidays: { add: ["2026-12-24", "05-01"], remove: ["02-22"] } };
      const r = await calPut(body);
      expect(r.status).toBe(200);
      const saved = await storedCal(o.email);
      expect(saved).toEqual(parsed(body, NOW, a.email));
      expect(saved).toEqual({
        v: 1, weekend: [5], ramadanHours: [{ from: "10:00", to: "14:00" }], hijriFix: {}, holidays: { add: ["2026-12-24", "05-01"], remove: ["02-22"] },
        updatedAt: iso(NOW), updatedBy: a.email,
      });
      expect(locks).toHaveBeenCalledWith(SEC_KEYS.lock(o.email, "cal"), expect.any(Number));
      expect((await auditLines(o.email)).map((l) => [l.action, l.actor, l.via, l.login, l.id])).toEqual([["calendar", "owner", "web", a.email, "-"]]);
      expect((await auditLines(o.email))[0].diff).toBe("weekend=[5]; ramadanHours=10:00-14:00; hijriFix=none; holidays +2 -1");
      // The answer is what GET gives, so the page can show the new effective week and the next quiet days without a second request.
      const j = await r.json();
      expect(j).toMatchObject({ ok: true, calendar: saved, effective: { country: "SA", zone: "Asia/Riyadh", weekend: [5], defaultWeekend: [5, 6], weekStart: 6, ramadanHours: [{ from: "10:00", to: "14:00" }] } });
      expect(j.upcoming.days.map((d: { day: string }) => d.day)).toContain("2026-12-24");
      expect(await (await calGet()).json()).toEqual(j);
      // The owner of the account saves too.
      await signIn(o.email);
      expect((await calPut({ weekend: [6] })).status).toBe(200);
      expect((await storedCal(o.email))?.updatedBy).toBe(o.email);
    });
  });

  it("the 31st PUT in an hour is 429 too_many and changes nothing; GET has its own sec:read counter", async () => {
    await at(NOW, async () => {
      const o = await owner("c484r");
      await signIn(o.email);
      for (let i = 1; i <= 30; i++) expect((await calPut({ weekend: [5] })).status, `PUT ${i}`).toBe(200);
      const r = await calPut({ weekend: [3] });
      expect(r.status).toBe(429);
      expect(await r.json()).toEqual({ ok: false, error: "too_many" });
      expect((await storedCal(o.email))?.weekend).toEqual([5]);
      expect(await auditLines(o.email)).toHaveLength(30);
      expect((await calGet()).status).toBe(200);
      await db.set(`rate:sec:read:${o.email}`, SEC_READS_PER_HOUR, 3600);
      expect((await calGet()).status).toBe(429);
    });
  });

  it("GET in a Saudi brand has no saved settings, the country's week, and lists National Day 2026-09-23 as «اليوم الوطني»", async () => {
    await at(local("2026-09-10T12:00"), async () => {
      const o = await owner("c484g");
      await signIn(o.email);
      const r = await calGet();
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.ok).toBe(true);
      expect(j.calendar).toBeNull();
      expect(j.effective).toEqual({ country: "SA", zone: "Asia/Riyadh", weekend: [5, 6], defaultWeekend: [5, 6], weekStart: 0, ramadanHours: [{ from: "10:00", to: "15:00" }], workHours: { from: "09:00", to: "17:00" } });
      expect(j.upcoming.days.find((d: { day: string }) => d.day === "2026-09-23")).toEqual({ day: "2026-09-23", why: { kind: "holiday", name: { ar: "اليوم الوطني", en: "National Day" } } });
      expect(j.upcoming.days.map((d: { day: string }) => d.day)).toEqual([...j.upcoming.days.map((d: { day: string }) => d.day)].sort());
      expect(j.upcoming.ramadan.start).toMatch(/^2027-02-/);
      // The same list the library gives for the same instant.
      expect(j.upcoming).toEqual(JSON.parse(JSON.stringify(upcomingQuiet(null, "Asia/Riyadh", local("2026-09-10T12:00")))));
    });
  });

  it("GET reads the brand's own zone: a Dubai brand is the UAE, its weekend (and the default the page marks) Saturday and Sunday and its week starting on Monday", async () => {
    await at(local("2026-10-06T12:00", "Asia/Dubai"), async () => {
      const o = await owner("c484d", DUBAI_BRAND);
      await signIn(o.email);
      const j = await (await calGet()).json();
      expect(j.effective).toMatchObject({ country: "AE", zone: "Asia/Dubai", weekend: [6, 0], defaultWeekend: [6, 0], weekStart: 1 });
      expect(j.upcoming.days.find((d: { day: string }) => d.day === "2026-12-02")?.why).toMatchObject({ kind: "holiday", name: { en: "National Day" } });
    });
  });

  it("PUT refuses what parseCalendar refuses, with its code and the field, and stores and audits nothing: an unknown field (scope, email), two separate weekend days, backwards Ramadan hours, a Hijri year too far on, a body that is not an object", async () => {
    await at(NOW, async () => {
      const o = await owner("c484x");
      await signIn(o.email);
      const refusals: [unknown, { error: string; field?: string }][] = [
        [{ weekend: [5], scope: "other@test.example" }, { error: "bad_request", field: "scope" }],
        [{ weekend: [5], email: "other@test.example" }, { error: "bad_request", field: "email" }],
        [{ weekend: [1, 3] }, { error: "weekend_invalid", field: "weekend" }],
        [{ ramadanHours: [{ from: "15:00", to: "10:00" }] }, { error: "ramadan_hours_invalid", field: "ramadanHours" }],
        [{ hijriFix: { "1500": { shawwal1: "2077-01-01" } } }, { error: "bad_year", field: "hijriFix.1500" }],
        [{ hijriFix: { "1448": { ramadan1: "2027-02-09" } } }, { error: "bad_request", field: "hijriFix.1448.ramadan1" }],
        [{ holidays: { remove: ["12-25"] } }, { error: "holidays_invalid", field: "holidays.remove" }],
        [["weekend"], { error: "bad_request" }],
        ["weekend", { error: "bad_request" }],
        [null, { error: "bad_request" }],
      ];
      for (const [body, want] of refusals) {
        const r = await calPut(body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(await r.json(), JSON.stringify(body)).toEqual({ ok: false, ...want });
      }
      expect(await storedCal(o.email)).toBeNull();
      expect(await auditLines(o.email)).toEqual([]);
      // A request with no body at all, or one that is not JSON, is bad_request too.
      expect((await calRoute.PUT(new Request("https://nashr.test/api/secretary/calendar", { method: "PUT" }))).status).toBe(400);
      expect((await calRoute.PUT(new Request("https://nashr.test/api/secretary/calendar", { method: "PUT", body: "{not json" }))).status).toBe(400);
    });
  });

  it("what GET returns under calendar is what PUT accepts: the page's GET to PUT round trip saves the same settings, restamped by whoever saves", async () => {
    const t1 = local("2026-10-06T12:00"), t2 = local("2026-10-07T09:00");
    const { o, first, second, body } = await at(t1, async () => {
      const o = await owner("c484t");
      const first = await newMember(o, "admin", "c484t1"), second = await newMember(o, "admin", "c484t2");
      await signIn(first.email);
      // Eid al-Fitr 1448 a day after Umm al-Qura's, by the owner's sighting; a holiday the defaults give, removed; two added.
      const fitr = eidDays(null, "Asia/Riyadh", t1).find((e) => e.year === 1448 && e.kind === "eid_fitr")!;
      const body = { weekend: [4, 5], ramadanHours: [{ from: "09:00", to: "12:00" }, { from: "20:00", to: "23:30" }], hijriFix: { "1448": { shawwal1: fitr.later! } }, holidays: { add: ["2026-12-27", "H-01-10"], remove: ["02-22"] } };
      expect((await calPut(body)).status).toBe(200);
      return { o, first, second, body };
    });
    await at(t2, async () => {
      await signIn(second.email);
      const got = (await (await calGet()).json()).calendar;
      expect(got).toEqual({ ...body, v: 1, updatedAt: iso(t1), updatedBy: first.email });
      // GET → PUT, the whole object as it came, `v`, `updatedAt` and `updatedBy` included.
      const r = await calPut(got);
      expect(r.status).toBe(200);
      expect(await storedCal(o.email)).toEqual({ ...got, updatedAt: iso(t2), updatedBy: second.email });
      expect((await r.json()).calendar).toEqual({ ...got, updatedAt: iso(t2), updatedBy: second.email });
      // Nothing saved yet: GET says null, and the defaults the page then shows save as they are.
      const v = await owner("c484t0");
      await signIn(v.email);
      expect((await (await calGet()).json()).calendar).toBeNull();
      expect((await calPut({})).status).toBe(200);
      expect(await storedCal(v.email)).toEqual({ v: 1, weekend: null, ramadanHours: null, hijriFix: {}, holidays: { add: [], remove: [] }, updatedAt: iso(t2), updatedBy: v.email });
      expect((await (await calGet()).json()).effective.weekend).toEqual([5, 6]);
    });
  });

  it("a stored value that is not settings is shown as no settings with the defaults, and an admin can save over it (ruling R13)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await at(NOW, async () => {
      const o = await owner("c484bad");
      await signIn(o.email);
      for (const bad of ["weekend=5", ["x"], { v: 1, holidays: { add: "x" } }]) {
        await db.set(SEC_KEYS.cal(o.email), bad);
        const r = await calGet();
        expect(r.status, JSON.stringify(bad)).toBe(200);
        const j = await r.json();
        expect(j.calendar).toBeNull();
        expect(j.effective).toMatchObject({ country: "SA", weekend: [5, 6], weekStart: 0 });
      }
      // Only the error's name is logged, never the stored value.
      expect(errors.mock.calls).toEqual([["sec calendar unreadable, defaults used", { error: "TypeError" }]]);
      expect((await calPut({ weekend: [5] })).status).toBe(200);
      expect((await storedCal(o.email))?.weekend).toEqual([5]);
    });
  });

  it("a day turned off stays savable once no default produces it (ruling R28): Kuwait's Eid al-Adha a day earlier, a Saudi brand moved to Dubai; turning it on saves, a new unknown one is refused, and the panel lists it", async () => {
    await at(NOW, async () => {
      // Kuwait: Eid al-Adha 1448 is 15-18 May 2027 by Umm al-Qura; Tuesday 18 turned off, then "a day earlier" (14-17 May).
      const k = await owner("c484kw", { ...BRAND, timeZone: "Asia/Kuwait" });
      await signIn(k.email);
      expect((await calPut({ holidays: { add: [], remove: ["2027-05-18"] } })).status).toBe(200);
      const adha: EidDay = (await (await calGet()).json()).eids.find((e: EidDay) => e.year === 1448 && e.kind === "eid_adha");
      expect(adha).toMatchObject({ uq: "2027-05-07", earlier: "2027-05-06" });
      const earlier = await calPut(withEid(await storedCal(k.email), adha, adha.earlier!));
      expect(earlier.status).toBe(200);
      expect(await storedCal(k.email)).toMatchObject({ hijriFix: { "1448": { dhulhijja1: "2027-05-06" } }, holidays: { remove: ["2027-05-18"] } });
      // "Turn on" takes it out; turning it off again is a new removal no default produces now, so it is refused.
      expect((await calPut(withHolidayOff(await storedCal(k.email), "2027-05-18", false))).status).toBe(200);
      expect((await storedCal(k.email))?.holidays.remove).toEqual([]);
      const again = await calPut(withHolidayOff(await storedCal(k.email), "2027-05-18", true));
      expect(again.status).toBe(400);
      expect(await again.json()).toEqual({ ok: false, error: "holidays_invalid", field: "holidays.remove" });

      // Saudi Arabia: Founding Day 2027-02-22 and National Day 2027-09-23 turned off, then the brand's zone becomes Dubai,
      // where neither is a holiday. Every save went on being refused before ruling R28; now each one saves.
      const s = await owner("c484sa");
      await signIn(s.email);
      expect((await calPut({ holidays: { add: [], remove: ["2027-02-22", "2027-09-23"] } })).status).toBe(200);
      await saveBrand(s.email, DUBAI_BRAND);
      const got = (await (await calGet()).json()).calendar as SecCalendar;
      expect(got.holidays.remove).toEqual(["2027-02-22", "2027-09-23"]);
      expect((await calPut(got)).status).toBe(200);
      expect((await calPut(withWeekend(got, [5, 6], [6, 0]))).status).toBe(200);
      expect((await calPut(withHolidayOff(await storedCal(s.email), "2027-02-22", false))).status).toBe(200);
      expect(await storedCal(s.email)).toMatchObject({ weekend: [5, 6], holidays: { remove: ["2027-09-23"] } });
      const unknown = await calPut(withHolidayOff(await storedCal(s.email), "2027-09-24", true));
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toEqual({ ok: false, error: "holidays_invalid", field: "holidays.remove" });
      // The panel lists the stored removal no default produces, with its "make it a day off again" button.
      const html = await new Response(await renderToReadableStream(await Page({ params: Promise.resolve({ lang: "en" }) }))).text();
      const list = html.slice(html.indexOf(appDict.en.todo.cal.offList));
      expect(html).toContain(appDict.en.todo.cal.offList);
      expect(list).toContain(localDay("en", "2026-10-06")("2027-09-23"));
      expect(list).toContain(appDict.en.todo.cal.turnOn);
      const j = await (await calGet()).json();
      expect(j.upcoming.days.map((d: { day: string }) => d.day)).not.toContain("2027-09-23");
    });
  });

  it("a PUT in brand B stores under B's scope alone, whatever the body names, and each brand's GET reads its own", async () => {
    await at(NOW, async () => {
      const u = await owner("c484b", BRAND);
      const b2 = scopeFor(u.email, "b2");
      await saveBrands(u.email, [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, { id: "b2", name: "Two", createdAt: new Date().toISOString(), status: "active" }]);
      await saveBrand(b2, { ...BRAND, name: "Two" });
      await signIn(u.email);
      await seedActiveBrand(u.email, "b2");
      expect((await calPut({ weekend: [5], scope: u.email })).status).toBe(400);
      expect(await Promise.all([storedCal(u.email), storedCal(b2)])).toEqual([null, null]);
      expect((await calPut({ weekend: [5] })).status).toBe(200);
      expect((await storedCal(b2))?.weekend).toEqual([5]);
      expect(await storedCal(u.email)).toBeNull();
      expect((await (await calGet()).json()).calendar.weekend).toEqual([5]);
      expect((await auditLines(b2)).map((l) => l.action)).toEqual(["calendar"]);
      expect(await auditLines(u.email)).toEqual([]);
      await seedActiveBrand(u.email, "default");
      const j = await (await calGet()).json();
      expect(j.calendar).toBeNull();
      expect(j.effective.weekend).toEqual([5, 6]);
    });
  });

  it("two PUTs at once both save, one after the other under the lock, each with its own audit line; a lock that is held gives 503 lock_timeout and stores nothing", async () => {
    await at(NOW, async () => {
      const o = await owner("c484c");
      await signIn(o.email);
      const rs = await Promise.all([calPut({ weekend: [5] }), calPut({ weekend: [4] })]);
      expect(rs.map((r) => r.status)).toEqual([200, 200]);
      expect([[5], [4]]).toContainEqual((await storedCal(o.email))?.weekend);
      expect(await auditLines(o.email)).toHaveLength(2);
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const o = await owner("c484l");
      await signIn(o.email);
      expect(await db.lock(SEC_KEYS.lock(o.email, "cal"), 30)).toBe(true);
      const p = calPut({ weekend: [5] });
      await vi.advanceTimersByTimeAsync(4000);
      const r = await p;
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, error: "lock_timeout" });
      expect(await storedCal(o.email)).toBeNull();
      expect(await auditLines(o.email)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a saved weekend applies on the next read: before the PUT a Saturday chase waits, after PUT weekend [5] it is in chase (Review Focus 2)", async () => {
    const sat = local("2026-10-03T12:00");
    await at(local("2026-10-01T09:00"), async () => {
      const o = await owner("c484f");
      const a = await newMember(o, "admin", "c484fa");
      await signIn(a.email);
      // Expected on Saturday 3 October 10:00: the zone's own weekend (Friday and Saturday) holds it until Sunday 08:00.
      await make(o, { title: "Quote", direction: "they_owe", owedBy: "أحمد", expectBy: "2026-10-03T10:00" });
      const before = await agendaFor(o.email, sat);
      expect(before.buckets.chase).toEqual([]);
      expect(before.buckets.waiting.map((e) => [e.item.title, e.next, e.moment?.why, e.moment?.at])).toEqual([["Quote", "wait", "quiet", local("2026-10-04T08:00")]]);
      const put = await calPut({ weekend: [5] });
      expect(put.status).toBe(200);
      // The week in force is Friday alone; the zone's own weekend, which the page marks as the default, is still Friday and Saturday.
      expect((await put.json()).effective).toMatchObject({ weekend: [5], defaultWeekend: [5, 6], weekStart: 6 });
      // The same list at the same instant, read again: Friday alone is the weekend, so Saturday is a working day.
      const after = await agendaFor(o.email, sat);
      expect(after.buckets.waiting).toEqual([]);
      expect(after.buckets.chase.map((e) => [e.item.title, e.next, e.moment?.why, e.moment?.at])).toEqual([["Quote", "chase", "normal", local("2026-10-03T10:00")]]);
      expect(after.cal.weekend).toEqual([5]);
    });
  });
});

// Rules 485-486: `contact_away`, an absence Reem proposes in chat and a person saves (spec §3.2, the founder's decision
// of 2026-10-02: from chat Reem only proposes; nothing is written to `sec:away` until a login with `todo.write` presses
// Save). "Now" is `NOW` above unless a case says otherwise.
const propPost = (id: string, body: unknown) => propRoute.POST(json(`/api/secretary/away/proposals/${id}`, "POST", body), params({ id }));
const propIds = (scope: string) => db.smembers(SEC_KEYS.awayProps(scope));
const awayAudit = async (scope: string) => (await auditLines(scope)).filter((l) => String(l.action).startsWith("away"));
/** One `contact_away` call in a turn of `ctx` (Reem in the app's chat unless the case says otherwise), and what it collected. */
async function contactAway(u: User, input: Record<string, unknown>, ctx: Partial<ToolCtx> = { agent: "reem", via: "app" }) {
  const awayProposed: AwayProposal[] = [];
  const actions: string[] = [];
  const text = await runTool(u, "contact_away", input, actions, [], undefined, { lang: "en", ...ctx, awayProposed });
  return { text, awayProposed, actions, p: awayProposed[0] };
}

describe("rule 485: contact_away proposes an absence on a card in Reem's chat, and only a person's Save writes it", () => {
  it("Reem's call in the app writes nothing to sec:away and returns one proposal: the name as typed, the contact it matches, the date and the open items that contact owes", async () => {
    const u = await owner("aw485a");
    const quote = await at(local("2026-10-01T09:00"), async () => {
      const q = await make(u, { title: "Quote", direction: "they_owe", owedBy: "احمد", dueAt: "2026-10-05T10:00" });
      await make(u, { title: "Invoice", direction: "they_owe", owedBy: "أحمد" });
      const closed = await make(u, { title: "Old", direction: "they_owe", owedBy: "احمد" });
      expect((await changeItem(u.email, closed.id, { action: "complete", result: "ok" }, PERSON)).ok).toBe(true);
      await make(u, { title: "Other", direction: "they_owe", owedBy: "Sara" });
      await make(u, { title: "Mine" });
      return q;
    });
    await at(NOW, async () => {
      const before = await auditLines(u.email);
      const { text, awayProposed, actions, p } = await contactAway(u, { name: "إحمد", until: "2026-10-08" });
      // Nothing saved: no field, no audit line.
      expect(await db.hgetall(SEC_KEYS.away(u.email))).toEqual({});
      expect(await auditLines(u.email)).toEqual(before);
      expect(awayProposed).toHaveLength(1);
      // Two open items are owed by that contact however it is written; the closed one and Sara's are not counted.
      expect(p).toEqual({ id: expect.stringMatching(/^[a-f0-9]{16}$/), label: "إحمد", key: "احمد", until: "2026-10-08", openItems: 2, contact: quote.owedBy, at: iso(NOW) });
      expect(quote.owedBy).toBe("احمد");
      expect(actions).toEqual([`awayprop:${p.id}`]);
      expect(text).toMatch(/^Proposed, not saved: /);
      expect(text).toMatch(/the owner presses Save on the card\.$/);
      expect(text).toContain("Thursday, October 8");
      expect(text).toContain("2 open items");
      // Stored for 7 days under the caller's scope, its id in the scope's index (for the account wipe).
      expect(AWAY_PROPOSAL_TTL_S).toBe(7 * 86400);
      expect(await db.get(SEC_KEYS.awayProp(u.email, p.id))).toEqual(p);
      const ttl = await db.ttl(SEC_KEYS.awayProp(u.email, p.id));
      expect(ttl).toBeGreaterThan(AWAY_PROPOSAL_TTL_S - 60);
      expect(ttl).toBeLessThanOrEqual(AWAY_PROPOSAL_TTL_S);
      expect(await propIds(u.email)).toEqual([p.id]);
      expect(await db.get(SEC_KEYS.awayPropDone(u.email, p.id))).toBeNull();
      // A name no open item is owed by: no contact, 0 items, and the answer asks Reem to check the spelling.
      const none = await contactAway(u, { name: "Ahmad", until: "2026-10-08" });
      expect(none.p).toMatchObject({ label: "Ahmad", key: "ahmad", openItems: 0 });
      expect(none.p).not.toHaveProperty("contact");
      expect(none.text).toContain("spelling");
      expect(none.text).toMatch(/the owner presses Save on the card\.$/);
    });
  });

  it("a member's Save through the route writes the entry and one away audit line under the member's login, via web, naming Reem's chat; a second Save is already_decided and changes nothing", async () => {
    await at(NOW, async () => {
      const o = await owner("aw485b");
      const m = await newMember(o, "member", "aw485bm");
      const { p } = await contactAway(o, { name: " Sara ", until: "2026-10-09" });
      await signIn(m.email);
      const r = await propPost(p.id, { action: "save" });
      expect(r.status).toBe(200);
      const entry = { label: "Sara", until: "2026-10-09", by: m.email, via: "web", at: iso(NOW) };
      expect(await r.json()).toEqual({ ok: true, state: "saved", entry });
      expect(await db.hgetall(SEC_KEYS.away(o.email))).toEqual({ sara: entry });
      expect((await awayAudit(o.email)).map((l) => [l.action, l.actor, l.via, l.login, l.diff])).toEqual([["away", "owner", "web", m.email, `label="Sara"; until=2026-10-09; proposed in Reem's chat (${p.id})`]]);
      // Decided once: the record goes, the outcome stays at most 7 days, and a second Save or a Dismiss is refused.
      expect(await db.get(SEC_KEYS.awayProp(o.email, p.id))).toBeNull();
      expect(await db.get(SEC_KEYS.awayPropDone(o.email, p.id))).toBe("saved");
      expect(await db.ttl(SEC_KEYS.awayPropDone(o.email, p.id))).toBeLessThanOrEqual(AWAY_PROPOSAL_TTL_S);
      for (const action of ["save", "dismiss"]) {
        const again = await propPost(p.id, { action });
        expect(again.status, action).toBe(409);
        expect(await again.json()).toEqual({ ok: false, error: "already_decided" });
      }
      expect(await db.hgetall(SEC_KEYS.away(o.email))).toEqual({ sara: entry });
      expect(await awayAudit(o.email)).toHaveLength(1);
      // Two Saves at once: one writes, the claim refuses the other.
      const q = (await contactAway(o, { name: "Huda", until: "2026-10-10" })).p;
      const both = await Promise.all([propPost(q.id, { action: "save" }), propPost(q.id, { action: "save" })]);
      expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
      expect(await awayAudit(o.email)).toHaveLength(2);
      // The owner of the account saves too.
      await signIn(o.email);
      const s = (await contactAway(o, { name: "Nour", until: "2026-10-11" })).p;
      expect((await propPost(s.id, { action: "save" })).status).toBe(200);
      expect((await db.hgetall<{ by: string }>(SEC_KEYS.away(o.email))).nour.by).toBe(o.email);
    });
  });

  it("Dismiss writes nothing; a clear proposal's Save ends the absence (until = yesterday); a reloaded thread shows each card's state", async () => {
    await at(NOW, async () => {
      const u = await owner("aw485c");
      await setAway(u.email, { label: "Huda", until: "2026-10-20" }, PERSON, NOW, "Asia/Riyadh");
      const a = (await contactAway(u, { name: "Sara", until: "2026-10-09" })).p;
      const cleared = await contactAway(u, { name: " HUDA ", clear: true });
      const b = cleared.p;
      const c = (await contactAway(u, { name: "Nour", until: "2026-10-10" })).p;
      expect(b).toMatchObject({ label: "HUDA", key: "huda", until: null, openItems: 0, contact: "Huda" });
      expect(cleared.text).toMatch(/^Proposed, not saved: /);
      expect(cleared.text).toContain("end");
      expect(cleared.text).toMatch(/the owner presses Save on the card\.$/);
      const lost: AwayProposal = { ...c, id: "0123456789abcdef" };
      await push(u.email, { role: "assistant", content: "…", at: iso(NOW), agent: "reem", awayProposals: [a, b, c, lost] });
      await signIn(u.email);
      const d = await propPost(a.id, { action: "dismiss" });
      expect(d.status).toBe(200);
      expect(await d.json()).toEqual({ ok: true, state: "dismissed" });
      expect(await awayKeys(u.email)).toEqual(["huda"]);
      const e = await propPost(b.id, { action: "save" });
      expect(e.status).toBe(200);
      expect(await e.json()).toMatchObject({ ok: true, state: "saved", entry: { label: "Huda", until: "2026-10-05" } });
      expect((await db.hgetall<{ until: string }>(SEC_KEYS.away(u.email))).huda.until).toBe("2026-10-05");
      expect((await awayAudit(u.email)).map((l) => [l.action, l.login, l.diff])).toEqual([
        ["away", PERSON.login, 'label="Huda"; until=2026-10-20'],
        ["away_end", u.email, `label="Huda"; until=2026-10-05; proposed in Reem's chat (${b.id})`],
      ]);
      const thread = await history(u.email);
      expect(thread.at(-1)?.awayProposals?.map((x) => [x.id, x.state])).toEqual([[a.id, "dismissed"], [b.id, "saved"], [c.id, "open"], [lost.id, "expired"]]);
    });
  });

  it("the proposal is read only from the caller's scope: another brand's or account's id is 404 and stays open; a malformed id is 404 and a bad action 400 before any proposal is read; anonymous is 401; the rate limit is 429", async () => {
    await at(NOW, async () => {
      const u = await owner("aw485d", BRAND);
      const b2 = scopeFor(u.email, "b2");
      await saveBrands(u.email, [{ id: "default", name: "", createdAt: iso(NOW), status: "active" }, { id: "b2", name: "Two", createdAt: iso(NOW), status: "active" }]);
      await saveBrand(b2, { ...BRAND, name: "Two" });
      const inB2 = (await contactAway({ ...u, scope: b2 }, { name: "Sara", until: "2026-10-09" })).p;
      expect(await propIds(b2)).toEqual([inB2.id]);
      expect(await propIds(u.email)).toEqual([]);
      const other = await owner("aw485do");
      const theirs = (await contactAway(other, { name: "Sara", until: "2026-10-09" })).p;
      signOut();
      expect((await propPost(inB2.id, { action: "save" })).status).toBe(401);
      await signIn(u.email);
      for (const id of [inB2.id, theirs.id]) {
        const r = await propPost(id, { action: "save" });
        expect(r.status).toBe(404);
        expect(await r.json()).toEqual({ ok: false, error: "not_found" });
      }
      expect(await db.get(SEC_KEYS.awayProp(b2, inB2.id))).toEqual(inB2);
      expect(await db.get(SEC_KEYS.awayProp(other.email, theirs.id))).toEqual(theirs);
      expect(await db.get(SEC_KEYS.awayPropDone(u.email, inB2.id))).toBeNull();
      for (const s of [u.email, b2, other.email]) expect(await awayKeys(s)).toEqual([]);
      // Malformed ids and actions are refused before any proposal key is read.
      const reads = vi.spyOn(db, "mget");
      for (const id of ["ABCDEF0123456789", "0123456789abcde", "0123456789abcdef0", "..", "0123456789abcdeg"]) expect((await propPost(id, { action: "save" })).status, id).toBe(404);
      for (const body of [{ action: "apply" }, {}, "save", null]) {
        const r = await propPost(inB2.id, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(await r.json()).toEqual({ ok: false, error: "bad_action" });
      }
      expect(reads.mock.calls.flat(2).filter((k) => String(k).startsWith("secawayprop"))).toEqual([]);
      reads.mockRestore();
      // In brand B the same id saves, into B's list alone.
      await seedActiveBrand(u.email, "b2");
      expect((await propPost(inB2.id, { action: "save" })).status).toBe(200);
      expect(await awayKeys(b2)).toEqual(["sara"]);
      expect(await awayKeys(u.email)).toEqual([]);
      // The sec:write rate applies, with nothing decided.
      const next = (await contactAway({ ...u, scope: b2 }, { name: "Huda", until: "2026-10-09" })).p;
      await db.set(`rate:sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600);
      expect((await propPost(next.id, { action: "save" })).status).toBe(429);
      expect(await db.get(SEC_KEYS.awayProp(b2, next.id))).toEqual(next);
      expect(await awayKeys(b2)).toEqual(["sara"]);
    });
  });

  it("a proposal is checked like setAway: the owner or an agent, a day out of range, a bad day, until with clear, a clear for someone not away and a full list are refused with nothing stored", async () => {
    await at(NOW, async () => {
      const u = await owner("aw485e");
      const cases: [Record<string, unknown>, Record<string, unknown>][] = [
        [{ name: "reem", until: "2026-10-08" }, { error: "not_contact", field: "name" }],
        [{ name: "ＤＡＮＡ", until: "2026-10-08" }, { error: "not_contact", field: "name" }],
        [{ name: "أنا", clear: true }, { error: "not_contact", field: "name" }],
        [{ name: "Sara", until: "2026-10-05" }, { error: "away_range", field: "until" }],
        [{ name: "Sara", until: addDays("2026-10-06", 367) }, { error: "away_range", field: "until" }],
        [{ name: "Sara", until: "8 Oct" }, { error: "bad_date", field: "until" }],
        [{ name: "Sara" }, { error: "bad_date", field: "until" }],
        [{ name: "Sara", until: "2026-10-08", clear: true }, { error: "bad_request", field: "until" }],
        [{ name: "Sara", clear: "yes" }, { error: "bad_request", field: "clear" }],
        [{ name: "", until: "2026-10-08" }, { error: "bad_request", field: "name" }],
        [{ name: "a".repeat(81), until: "2026-10-08" }, { error: "too_long", field: "name" }],
        [{ name: "Nobody", clear: true }, { error: "not_found", field: "name" }],
      ];
      for (const [input, want] of cases) {
        expect(await proposeAway(u.email, input as { name: unknown }, NOW, "Asia/Riyadh"), JSON.stringify(input)).toMatchObject({ ok: false, ...want });
        const r = await contactAway(u, input);
        expect(r.text, JSON.stringify(input)).toMatch(/^Not done: /);
        expect(r.awayProposed).toEqual([]);
        expect(r.actions).toEqual([]);
      }
      // Ending an absence that has already ended changes nothing: no card.
      await db.hset(SEC_KEYS.away(u.email), "huda", awayEntry("Huda", "2026-10-01"));
      expect(await proposeAway(u.email, { name: "Huda", clear: true }, NOW, "Asia/Riyadh")).toMatchObject({ ok: false, error: "nothing_to_change" });
      // A full list: a new contact is away_limit; one already on it can still be proposed.
      await Promise.all(Array.from({ length: AWAY_MAX - 1 }, (_, i) => db.hset(SEC_KEYS.away(u.email), `c${i}`, awayEntry(`C${i}`, "2026-10-20"))));
      expect(await proposeAway(u.email, { name: "New contact", until: "2026-10-09" }, NOW, "Asia/Riyadh")).toMatchObject({ ok: false, error: "away_limit", status: 409 });
      expect((await proposeAway(u.email, { name: "C3", until: "2026-10-09" }, NOW, "Asia/Riyadh")).ok).toBe(true);
      expect(await propIds(u.email)).toHaveLength(1);
      expect(await awayKeys(u.email)).toHaveLength(AWAY_MAX);
    });
  });

  it("a Save is checked again when it is pressed: a last day that has passed since is away_range with nothing written, and the card can still be dismissed", async () => {
    const { u, p } = await at(NOW, async () => {
      const u = await owner("aw485f");
      return { u, p: (await contactAway(u, { name: "Sara", until: "2026-10-06" })).p };
    });
    await at(NOW + 864e5, async () => {
      await signIn(u.email);
      const r = await propPost(p.id, { action: "save" });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ ok: false, error: "away_range", field: "until" });
      expect(await awayKeys(u.email)).toEqual([]);
      expect(await db.get(SEC_KEYS.awayPropDone(u.email, p.id))).toBeNull();
      expect((await propPost(p.id, { action: "dismiss" })).status).toBe(200);
      expect(await db.get(SEC_KEYS.awayPropDone(u.email, p.id))).toBe("dismissed");
    });
  });

  it("the card shows the name as typed, the contact it matches, the last day in Latin digits and the open items, with Save and Dismiss; a decided card shows its outcome", () => {
    const p: AwayProposal = { id: "0123456789abcdef", label: "إحمد", key: "احمد", until: "2026-10-08", openItems: 2, contact: "احمد", at: iso(NOW) };
    const card = (q: AwayProposal, lang: "ar" | "en") => renderToStaticMarkup(createElement(AwayProposalCard, { p: q, t: appDict[lang], lang }));
    const ar = card(p, "ar");
    for (const s of ["إحمد", "احمد", "الخميس 8 أكتوبر", "آخر يوم غياب", "المهام المفتوحة على هذا الاسم: 2", "احفظ", "تجاهل"]) expect(ar, s).toContain(s);
    expect(ar).not.toMatch(/[٠-٩]/);
    const en = card(p, "en");
    for (const s of ["Name as written", "Matches", "2 open items they owe", "Away until", "Thursday, October 8", ">Save<", ">Dismiss<"]) expect(en, s).toContain(s);
    expect(card({ ...p, until: null }, "en")).toContain("Ends now");
    expect(card({ ...p, contact: undefined, openItems: 0 }, "en")).toContain("check the spelling");
    // A decided or expired card offers no button.
    const saved = card({ ...p, state: "saved" }, "en");
    expect(saved).toContain("Saved to the away list");
    expect(saved).not.toContain(">Save<");
    expect(card({ ...p, state: "expired" }, "en")).toContain("expired (7 days)");
  });

  it("decideAwayProposal applies the proposal through setAway or endAway with the person's Who", async () => {
    await at(NOW, async () => {
      const u = await owner("aw485g");
      const made = await proposeAway(u.email, { name: "Sara", until: "2026-10-09" }, NOW, "Asia/Riyadh");
      if (!made.ok) throw new Error(made.error);
      expect(await decideAwayProposal(u.email, made.p.id, "save", PERSON, NOW)).toEqual({ ok: true, state: "saved", entry: { label: "Sara", until: "2026-10-09", by: PERSON.login, via: "web", at: iso(NOW) } });
      expect(await decideAwayProposal(u.email, made.p.id, "save", PERSON, NOW)).toMatchObject({ ok: false, error: "already_decided", status: 409 });
      expect(await decideAwayProposal(u.email, "not-an-id", "save", PERSON, NOW)).toMatchObject({ ok: false, error: "not_found", status: 404 });
      expect(toolError({ ok: false, error: "already_decided", status: 409 })).toMatch(/already/);
    });
  });

  it("a Save or a Dismiss while another Save holds the card is 409 busy, not already_decided, and the card says to try again (AR and EN)", async () => {
    await at(NOW, async () => {
      const u = await owner("aw485busy");
      const made = await proposeAway(u.email, { name: "Sara", until: "2026-10-09" }, NOW, "Asia/Riyadh");
      if (!made.ok) throw new Error(made.error);
      const done = SEC_KEYS.awayPropDone(u.email, made.p.id);
      // Another Save's claim, as decideAwayProposal sets it while setAway runs.
      await db.set(done, "saving", 60);
      expect(await decideAwayProposal(u.email, made.p.id, "save", PERSON, NOW)).toEqual({ ok: false, error: "busy", status: 409 });
      expect(await decideAwayProposal(u.email, made.p.id, "dismiss", PERSON, NOW)).toEqual({ ok: false, error: "busy", status: 409 });
      // The claim taken between the read and the claim: busy too.
      const raw = await db.get(SEC_KEYS.awayProp(u.email, made.p.id));
      vi.spyOn(db, "mget").mockResolvedValueOnce([raw, null]);
      expect(await decideAwayProposal(u.email, made.p.id, "save", PERSON, NOW)).toEqual({ ok: false, error: "busy", status: 409 });
      await signIn(u.email);
      const r = await propPost(made.p.id, { action: "save" });
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ ok: false, error: "busy" });
      expect(await awayKeys(u.email)).toEqual([]);
      // The card keeps its buttons and asks for another try, in the reader's language.
      expect(awayCardRefusal(appDict.ar, "ar", 409, "busy")).toBe("يحفظ أحدٌ هذه البطاقة الآن. حاول مرة أخرى بعد لحظة.");
      expect(awayCardRefusal(appDict.en, "en", 409, "busy")).toBe("Someone is saving this card right now. Try again in a moment.");
      // Once the claim is gone the Save goes through; after that the card is already decided.
      await db.del(done);
      expect(await decideAwayProposal(u.email, made.p.id, "save", PERSON, NOW)).toMatchObject({ ok: true, state: "saved" });
      expect(await decideAwayProposal(u.email, made.p.id, "dismiss", PERSON, NOW)).toEqual({ ok: false, error: "already_decided", status: 409 });
    });
  });

  it("a real turn: Reem's reply carries her contact_away cards, at most 5 (AWAY_CARDS_PER_REPLY); the sixth call in the turn is refused, and the thread and the proposals index hold the same 5", async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    claudeOn();
    const sent: { tools: { name: string }[]; messages: { role: string; content: unknown }[] }[] = [];
    const names = ["Sara", "Ahmad", "Khalid", "Mona", "Fahad", "Huda"];
    const turns = [
      { stop_reason: "tool_use", content: names.map((name, i) => ({ type: "tool_use", id: `tu${i}`, name: "contact_away", input: { name, until: "2026-10-15" } })) },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Proposed on the cards below; nothing changes until you press Save." }] },
    ];
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        static BadRequestError = class extends Error {};
// The agent-scope classifier streams since the 2026-10-12 build batch (rule 980) and forces its `verdict` tool. It gets
        // no answer here, as when it called the `create` this mock never had, so the scripted turns stay the chat's.
        messages = { stream: (p: (typeof sent)[number] & { tool_choice?: { name?: string } }) => { if (p.tool_choice?.name === "verdict") throw new Error("no classifier in this test"); sent.push(JSON.parse(JSON.stringify(p))); return { finalMessage: async () => ({ model: "m", usage: { input_tokens: 1, output_tokens: 1 }, ...(turns.shift() ?? { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }) }) }; } };
      },
    }));
    try {
      const { chat, history } = await import("@/lib/chat");
      // The account is made at the turn's own time, so its trial is running then.
      const { u, m } = await at(NOW, async () => {
        const u = await owner("aw485cap");
        return { u, m: await chat(u, "They are all away until 15 October", undefined, "reem", { lang: "en" }) };
      });
      expect(sent[0].tools.map((t) => t.name)).toContain("contact_away");
      expect(m.awayProposals?.map((p) => [p.label, p.until])).toEqual(names.slice(0, 5).map((n) => [n, "2026-10-15"]));
      expect(m.actions?.filter((a) => a.startsWith("awayprop:"))).toEqual(m.awayProposals!.map((p) => `awayprop:${p.id}`));
      // What the model read back: five proposals, then the refusal of the sixth.
      const results = sent[1].messages.at(-1)!.content as { tool_use_id: string; content: string }[];
      expect(results.map((r) => r.tool_use_id)).toEqual(names.map((_, i) => `tu${i}`));
      expect(results.slice(0, 5).every((r) => r.content.startsWith("Proposed, not saved"))).toBe(true);
      expect(results[5].content).toBe("Not done: one reply carries at most 5 away cards. Nothing more was saved.");
      // Stored with the reply, so a reload shows the same five cards; five proposals in the index; nothing on the away list.
      // Read at the turn's own time: the cards live 7 days from NOW, so on the real clock they read "expired" from
      // 2026-10-13 09:00 UTC on (the test failed on the release pull request #355).
      await at(NOW, async () => {
        expect((await history(u.email)).at(-1)?.awayProposals?.map((p) => [p.id, p.state])).toEqual(m.awayProposals!.map((p) => [p.id, "open"]));
        expect((await propIds(u.email)).sort()).toEqual(m.awayProposals!.map((p) => p.id).sort());
        expect(await awayKeys(u.email)).toEqual([]);
      });
    } finally {
      vi.doUnmock("@anthropic-ai/sdk");
      vi.doUnmock("@/lib/model");
      vi.unstubAllEnvs();
    }
  });
});

describe("rule 486: contact_away is Reem's alone, in the app's chat: refused for other agents, over MCP and for a token, and never offered to them", () => {
  it("runTool refuses it for Noor, for another agent, for a turn with no agent, over MCP and for a token (in ctx.by or on the user), and writes nothing", async () => {
    await at(NOW, async () => {
      const u = await owner("aw486a");
      const token = { kind: "token" as const, pid: storedPersonId(u.email), home: true, email: u.email, name: "Token", lang: "en" as const, role: "owner" as const };
      const cases: [string, User, Partial<ToolCtx>][] = [
        ["noor", u, { agent: "noor", via: "app" }],
        ["majed", u, { agent: "majed", via: "app" }],
        ["no agent", u, { via: "app" }],
        ["mcp", u, { agent: "reem", via: "mcp" }],
        ["token by", u, { agent: "reem", via: "app", by: { kind: "token", email: u.email } }],
        ["token actor", { ...u, actor: token }, { agent: "reem", via: "app" }],
      ];
      for (const [name, user, ctx] of cases) {
        const r = await contactAway(user, { name: "Sara", until: "2026-10-09" }, ctx);
        // Rule 799: another agent's turn was never offered the tool, so it reads "Unknown tool." before the tool's own refusal;
        // a turn with no agent, over MCP and for a token still read that refusal.
        if (ctx.agent !== undefined && ctx.agent !== "reem") expect(r.text, name).toBe("Unknown tool.");
        else {
          expect(r.text, name).toMatch(/^Not done: /);
          expect(r.text, name).toContain("Nothing was saved");
        }
        expect(r.awayProposed, name).toEqual([]);
        expect(r.actions, name).toEqual([]);
      }
      expect(await propIds(u.email)).toEqual([]);
      expect(await awayKeys(u.email)).toEqual([]);
      expect(await db.get(`rate:sec:write:${u.email}`)).toBeNull();
      // The same call in Reem's own turn in the app is proposed.
      expect((await contactAway(u, { name: "Sara", until: "2026-10-09" })).awayProposed).toHaveLength(1);
    });
  });

  it("only Reem's turn offers the tool: not the shared tools, not another agent's turn, not MCP's tool list", async () => {
    expect(toolsFor("reem").map((t) => t.name)).toContain("contact_away");
    for (const a of AGENT_IDS.filter((x) => x !== "reem")) expect(toolsFor(a).map((t) => t.name), a).not.toContain("contact_away");
    expect(toolsFor("majed").map((t) => t.name)).toContain("propose_handoff");
    expect(toolsFor("reem").map((t) => t.name)).not.toContain("propose_handoff");
    expect(CHAT_TOOL_NAMES).not.toContain("contact_away");
    const rpc = (method: string) => new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }) });
    const listed = (await (await mcpRoute.POST(rpc("tools/list"))).json()).result.tools.map((t: { name: string }) => t.name);
    expect(listed.length).toBeGreaterThan(3);
    expect(listed).not.toContain("contact_away");
    expect((await (await mcpRoute.GET()).json()).tools).not.toContain("contact_away");
    // A name, then a last day or clear; the description says it saves nothing.
    expect(CONTACT_AWAY_TOOL.input_schema).toMatchObject({ type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" }, until: { type: "string" }, clear: { type: "boolean" } } });
    expect(CONTACT_AWAY_TOOL.description).toMatch(/saves nothing/i);
    expect(statusFor("contact_away", "en", "Reem")).not.toBe("Reem is working…");
  });
});

describe("rule 487: the to-do page shows Working days and Away panels, and the reason a debt waits under its WhatsApp link", () => {
  const render = async (lang: "ar" | "en") => new Response(await renderToReadableStream(await Page({ params: Promise.resolve({ lang }) }))).text();
  /** The seven weekend checkboxes, in weekday order (0 Sunday … 6 Saturday). */
  const weekendBoxes = (html: string) => [...html.matchAll(/<input[^>]*name="weekend"[^>]*>/g)].map((m) => m[0]);
  const ARABIC_INDIC = /[٠-٩۰-۹]/;

  it("in Arabic for an admin: «أيام العمل», «الغائبون» and «متوقعة — تأكد من الإعلان الرسمي»; the weekend is editable with the country's default marked; the country's holidays and this and next year's Eid come from the calendar", async () => {
    await at(NOW, async () => {
      const o = await owner("pg487a");
      const a = await newMember(o, "admin", "pg487aa");
      await signIn(a.email);
      const html = await render("ar");
      expect(html).toContain("أيام العمل");
      expect(html).toContain("الغائبون");
      expect(html).toContain("متوقعة — تأكد من الإعلان الرسمي");
      const boxes = weekendBoxes(html);
      expect(boxes).toHaveLength(7);
      expect(boxes.filter((b) => / disabled=""/.test(b))).toEqual([]);
      // Friday and Saturday are Saudi Arabia's weekend, checked and marked as the default.
      expect(boxes.map((b) => / checked=""/.test(b))).toEqual([false, false, false, false, false, true, true]);
      expect(html).toContain(fillIn(appDict.ar.todo.cal.defaultLine, { country: appDict.ar.todo.cal.countries.SA, days: "الجمعة، السبت" }));
      // The holidays are the calendar's own names (COUNTRY_CAL, NAMES), never a copy in the page's dictionary: Founding Day
      // on Monday 22 February 2027 and the Eid al-Fitr holiday come from the server's data.
      const founding = COUNTRY_CAL.SA.holidays.find((h) => h.id === "founding_day")!.name.ar;
      const [fitr, adha] = eidDays(null, "Asia/Riyadh", NOW);
      for (const name of [founding, adha.name.ar]) {
        expect(html).toContain(name);
        expect(JSON.stringify(appDict), name).not.toContain(name);
      }
      expect(html).toContain(fitr.name.ar);
      // The dictionary keeps no Eid name of its own to fall back on: only the weekend, a holiday and an added day.
      expect(Object.keys(appDict.ar.todo.cal.kinds)).toEqual(["weekend", "holiday", "added"]);
      // This Hijri year's and the next one's Eid, with the buttons that move them a day.
      expect(html).toContain(fillIn(appDict.ar.todo.cal.eidYear, { year: "1448" }));
      expect(html).toContain(fillIn(appDict.ar.todo.cal.eidYear, { year: "1449" }));
      expect(html).toContain(appDict.ar.todo.cal.eidLater);
      expect(html).toContain(appDict.ar.todo.cal.eidEarlier);
      expect(html).toContain(appDict.ar.todo.cal.addOnce);
      expect(html).toContain(appDict.ar.todo.cal.addYearly);
      // The Ramadan default, 10:00-15:00, from the data, and Latin digits in every date the panels write.
      expect(html).toMatch(/value="10:00"/);
      expect(html).toMatch(/value="15:00"/);
      expect(ARABIC_INDIC.test(html)).toBe(false);
      // English names the same panels.
      const en = await render("en");
      for (const s of ["Working days", "Away", "Expected; check the official announcement", "Founding Day"]) expect(en, s).toContain(s);
    });
  });

  it("for a member the Working days panel is read-only: the weekend inputs are disabled and no Eid or holiday button shows; the Away panel's form is there (todo.write)", async () => {
    await at(NOW, async () => {
      const o = await owner("pg487m");
      const m = await newMember(o, "member", "pg487mm");
      await signIn(m.email);
      const html = await render("ar");
      const boxes = weekendBoxes(html);
      expect(boxes).toHaveLength(7);
      expect(boxes.every((b) => / disabled=""/.test(b))).toBe(true);
      // Ramadan's hours and every day off's switch are read-only too.
      const times = [...html.matchAll(/<input[^>]*type="time"[^>]*>/g)].map((m) => m[0]);
      const switches = [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
      expect(times).toHaveLength(2);
      expect(switches.length).toBeGreaterThan(3);
      expect([...times, ...switches].filter((x) => !/ disabled=""/.test(x))).toEqual([]);
      expect(html).not.toContain(appDict.ar.todo.cal.eidLater);
      expect(html).not.toContain(appDict.ar.todo.cal.addOnce);
      expect(html).not.toContain(appDict.ar.todo.cal.saveWeekend);
      expect(html).toContain(appDict.ar.readOnly.admin);
      expect(html).toContain("متوقعة — تأكد من الإعلان الرسمي");
      expect(html).toContain(appDict.ar.todo.away.add);
    });
  });

  it("a debt owed by an away contact shows «غياب لين» with Latin digits under its WhatsApp link; contact rows offer «Away until…», the name list suggests the open items' contacts, and the away list offers End now or Remove", async () => {
    await at(NOW, async () => {
      const o = await owner("pg487w");
      await signIn(o.email);
      await make(o, { title: "عرض السعر", direction: "they_owe", owedBy: "أحمد", phone: "966500000001", dueAt: "2026-10-06T10:00" });
      await make(o, { title: "Report", direction: "they_owe", owedBy: "sami", dueAt: "2026-10-06T10:00" });
      // «احمد» without the hamza is the same contact (partyKey); Sara's absence ended yesterday.
      await setAway(o.email, { label: "احمد", until: "2026-10-08" }, { actor: "owner", via: "web", login: o.email }, NOW, "Asia/Riyadh");
      await db.hset(SEC_KEYS.away(o.email), partyKey("Sara")!, awayEntry("Sara", "2026-10-05"));
      const html = await render("ar");
      expect(html).toContain("أحمد: غياب لين الخميس 8 أكتوبر");
      const line = html.slice(html.indexOf("غياب لين") - 20, html.indexOf("غياب لين") + 40);
      expect(ARABIC_INDIC.test(line)).toBe(false);
      // Under the WhatsApp link, and the step itself stays short.
      expect(html.indexOf("غياب لين")).toBeGreaterThan(html.indexOf("https://wa.me/966500000001"));
      expect(html).toContain(">بانتظار أحمد<");
      // «غائب حتى…» on the contact's row only: never on the agent's.
      expect(html.split(appDict.ar.todo.awayUntil).length - 1).toBe(1);
      expect(html).toMatch(/<datalist id="todo-away-labels"><option value="أحمد"><\/option><\/datalist>/);
      // The away list: the running absence can be ended, the ended one removed.
      expect(html).toContain(appDict.ar.todo.away.endNow);
      expect(html).toContain(appDict.ar.todo.away.removeEntry);
      expect(html).toContain("Sara");
      // In English the same line.
      expect(await render("en")).toContain("أحمد: away until Thursday, October 8");
    });
  });

  it("the page reads the brand file, sec:cal and sec:away once each: the panels show the records the agenda was read with (todoPage)", async () => {
    await at(NOW, async () => {
      const o = await owner("pg487once", { ...BRAND, city: "الشارقة", timeZone: "Asia/Dubai" });
      await signIn(o.email);
      await db.set(SEC_KEYS.cal(o.email), settings({ weekend: [5, 6, 0], holidays: { add: ["2026-12-31"], remove: [] } }));
      await db.hset(SEC_KEYS.away(o.email), partyKey("Sara")!, awayEntry("Sara", "2026-10-09"));
      const gets = vi.spyOn(db, "get"), hashes = vi.spyOn(db, "hgetall");
      const html = await render("en");
      expect(gets.mock.calls.filter(([k]) => k === `brand:${o.email}`)).toHaveLength(1);
      expect(gets.mock.calls.filter(([k]) => k === SEC_KEYS.cal(o.email))).toHaveLength(1);
      expect(hashes.mock.calls.filter(([k]) => k === SEC_KEYS.away(o.email))).toHaveLength(1);
      // What each panel shows still comes from those records: the brand's city (Sharjah), its weekend, its added day, its away contact.
      expect(html).not.toContain(appDict.en.todo.cal.sharjahHint);
      expect(weekendBoxes(html).map((b) => / checked=""/.test(b))).toEqual([true, false, false, false, false, true, true]);
      expect(html).toContain(appDict.en.todo.cal.addedList);
      expect(html).toContain("Sara");
      expect(html).toContain(appDict.en.todo.away.endNow);
      await db.set(SEC_KEYS.cal(o.email), settings({}));
      expect(await render("en")).toContain(appDict.en.todo.cal.sharjahHint);
    });
  });

  it("a brand in Sharjah is told Friday is in the government's weekend; a brand in Dubai or Riyadh is not", async () => {
    await at(NOW, async () => {
      const s = await owner("pg487s", { ...BRAND, city: "الشارقة" });
      await signIn(s.email);
      const html = await render("ar");
      expect(html).toContain(appDict.ar.todo.cal.sharjahHint);
      // Sharjah is in the UAE: Saturday and Sunday are its default.
      expect(weekendBoxes(html).map((b) => / checked=""/.test(b))).toEqual([true, false, false, false, false, false, true]);
      expect(await render("en")).toContain(appDict.en.todo.cal.sharjahHint);
      for (const brand of [DUBAI_BRAND, { ...BRAND, city: "Riyadh" }]) {
        const u = await owner("pg487n", brand);
        await signIn(u.email);
        expect(await render("ar")).not.toContain(appDict.ar.todo.cal.sharjahHint);
      }
    });
  });

  it("eidDays gives this Hijri year's and the next one's Eid with the hijriFix value each button writes, and GET /api/secretary/calendar carries them", async () => {
    await at(NOW, async () => {
      const days = eidDays(null, "Asia/Riyadh", NOW);
      expect(days.map((e) => [e.year, e.kind, e.field])).toEqual([[1448, "eid_fitr", "shawwal1"], [1448, "eid_adha", "dhulhijja1"], [1449, "eid_fitr", "shawwal1"], [1449, "eid_adha", "dhulhijja1"]]);
      const fitr = days[0];
      // 1 Shawwal 1448 is 9 March 2027 (Umm al-Qura); the buttons write the day before or after, within a day of it.
      expect(fitr).toMatchObject({ uq: "2027-03-09", start: "2027-03-09", day: "2027-03-09", earlier: "2027-03-08", later: "2027-03-10" });
      // Eid al-Adha is 10 Dhu al-Hijjah: 2027-05-16 (13 Dhu al-Hijjah is 2027-05-19).
      expect(days[1].day).toBe("2027-05-16");
      expect(days[1].day).toBe(addDays(days[1].start, 9));
      const moved = parseCalendar(calBody(withEid(null, fitr, fitr.later!)), NOW, "Asia/Riyadh", "a@x");
      expect(moved.ok && moved.cal.hijriFix).toEqual({ 1448: { shawwal1: "2027-03-10" } });
      const after = eidDays(moved.ok ? moved.cal : null, "Asia/Riyadh", NOW)[0];
      // A day later than Umm al-Qura: one more "later" is not allowed; "earlier" goes back to Umm al-Qura, which removes the fix.
      expect(after).toMatchObject({ start: "2027-03-10", day: "2027-03-10", later: null, earlier: "2027-03-09" });
      expect(withEid(moved.ok ? moved.cal : null, after, after.earlier!).hijriFix).toEqual({});
      // Each Eid carries its days off, as the list below shows them (weekend days left out), and its name from the server.
      expect(fitr).toMatchObject({ name: { ar: "إجازة عيد الفطر", en: "Eid al-Fitr holiday" }, off: { first: "2027-03-09", last: "2027-03-11" } });
      expect(days[1].off).toEqual({ first: "2027-05-16", last: "2027-05-18" });
      // Next year's Eids are past the calendar's 400 days and still have their days off: Eid al-Fitr 1449 is Saturday
      // 26 February 2028, a Saudi weekend day, so its days off run Sunday to Tuesday; Eid al-Adha's from Arafah, Thursday.
      expect(days[2]).toMatchObject({ day: "2028-02-26", off: { first: "2028-02-27", last: "2028-02-29" } });
      expect(days[3]).toMatchObject({ day: "2028-05-05", off: { first: "2028-05-04", last: "2028-05-07" } });
      // In Saudi Arabia, 1448's 29-day Ramadan: Eid a day later leaves the days off as they were (ruling R26), and the row shows it.
      expect(after.off).toEqual(fitr.off);
      // In the UAE the same move adds 3 Shawwal, a Friday the UAE works: the days off end a day later.
      const ae = eidDays(settings({ hijriFix: { 1448: { shawwal1: "2027-03-10" } } }), "Asia/Dubai", NOW)[0];
      expect(eidDays(null, "Asia/Dubai", NOW)[0].off).toEqual({ first: "2027-03-09", last: "2027-03-11" });
      expect(ae.off).toEqual({ first: "2027-03-09", last: "2027-03-12" });
      const o = await owner("pg487e");
      await signIn(o.email);
      expect((await (await calGet()).json()).eids).toEqual(days);
      // A save answers with the Eids for the new settings: the panel shows them without a second request.
      const put = await (await calPut({ hijriFix: { 1448: { shawwal1: "2027-03-10" } } })).json();
      expect(put.ok).toBe(true);
      expect(put.eids).toEqual(eidDays(put.calendar, "Asia/Riyadh", NOW));
      expect(put.eids[0]).toMatchObject({ start: "2027-03-10", later: null, earlier: "2027-03-09" });
    });
  });

  it("every change the panel sends is the whole settings object in a shape parseCalendar accepts; the away list's End now ends and Remove deletes (ruling R21)", async () => {
    await at(NOW, async () => {
      const ok = (body: ReturnType<typeof calBody>) => {
        const r = parseCalendar(body, NOW, "Asia/Riyadh", "a@x");
        expect(r.ok, JSON.stringify(r)).toBe(true);
        return r.ok ? r.cal : null;
      };
      expect(calBody(null)).toEqual({ weekend: null, ramadanHours: null, hijriFix: {}, holidays: { add: [], remove: [] } });
      // The weekend: the default set saves as null (it follows the zone), another set as itself.
      expect(withWeekend(null, [6, 5], [5, 6]).weekend).toBeNull();
      expect(ok(withWeekend(null, [5], [5, 6]))?.weekend).toEqual([5]);
      // Ramadan hours: two windows, none (no restriction), or back to the default.
      const two = ok(withHours(null, [{ from: "09:00", to: "12:00" }, { from: "20:00", to: "23:00" }]));
      expect(two?.ramadanHours).toHaveLength(2);
      expect(ok(withHours(two, []))?.ramadanHours).toEqual([]);
      expect(ok(withHours(two, null))?.ramadanHours).toBeNull();
      // Holidays: a default day turned off for this year, then on again; a day added for this year, a yearly Hijri and Gregorian one.
      const off = ok(withHolidayOff(null, "2027-02-22", true));
      expect(off?.holidays.remove).toEqual(["2027-02-22"]);
      expect(ok(withHolidayOff(off, "2027-02-22", false))?.holidays.remove).toEqual([]);
      expect(yearlyValue("hijri", 7, 27)).toBe("H-07-27");
      expect(yearlyValue("greg", 5, 1)).toBe("05-01");
      const added = ok(withAdded(withAdded(withAdded(null, "2026-12-24", true), "H-07-27", true), "05-01", true));
      expect(added?.holidays.add).toEqual(["2026-12-24", "H-07-27", "05-01"]);
      expect(ok(withAdded(added, "H-07-27", false))?.holidays.add).toEqual(["2026-12-24", "05-01"]);
      // A change keeps every other field as it was.
      expect(withWeekend(added, [5], [5, 6]).holidays).toEqual(added?.holidays);
      // End now ends the absence (DELETE { label }); Remove deletes an ended entry (DELETE { label, remove: true }).
      expect(awayCall("end", "احمد")).toEqual({ method: "DELETE", body: { label: "احمد" } });
      expect(awayCall("remove", "Sara")).toEqual({ method: "DELETE", body: { label: "Sara", remove: true } });
    });
  });

  it("ruling R26: Saudi Eid al-Fitr starts the day before the announced Eid when Ramadan ran 30 days, else on it; a 31-day Ramadan starts a day later", async () => {
    // 15 January 2026, in 1447, whose Umm al-Qura Ramadan has 30 days: 18 February to 19 March, Eid on Friday 20 March.
    const JAN = local("2026-01-15T12:00");
    const kind = (c: ReturnType<typeof workCalendar>, d: string) => c.quiet[d]?.kind ?? null;
    const uq = workCalendar(null, "Asia/Riyadh", JAN);
    // As before: four days from 30 Ramadan (Thursday 19 March; Friday and Saturday are the weekend), two days in lieu.
    expect(["2026-03-19", "2026-03-22", "2026-03-23", "2026-03-24"].map((d) => kind(uq, d))).toEqual(["eid_fitr", "eid_fitr", "holiday", "holiday"]);
    expect(uq.ramadan[0]).toBe("2026-02-18");
    expect(uq.ramadan.filter((d) => d.startsWith("2026-0"))).toHaveLength(30);
    // Eid announced a day later (Saturday 21 March): the holiday starts a day later too, Friday 20 March to Monday 23 March.
    const later = workCalendar(settings({ hijriFix: { 1447: { shawwal1: "2026-03-21" } } }), "Asia/Riyadh", JAN);
    expect(["2026-03-19", "2026-03-22", "2026-03-23", "2026-03-24", "2026-03-25"].map((d) => kind(later, d))).toEqual([null, "eid_fitr", "eid_fitr", "holiday", "holiday"]);
    // No month has 31 days: Ramadan starts a day later, 19 February to 20 March.
    expect(later.ramadan.filter((d) => d.startsWith("2026-0"))).toHaveLength(30);
    expect(later.ramadan[0]).toBe("2026-02-19");
    expect(later.ramadan).toContain("2026-03-20");
    expect(upcomingQuiet(settings({ hijriFix: { 1447: { shawwal1: "2026-03-21" } } }), "Asia/Riyadh", JAN).ramadan).toEqual({ start: "2026-02-19", end: "2026-03-20" });
    // Eid a day earlier (19 March, a 29-day Ramadan): the holiday starts on Eid, as before.
    const earlier = workCalendar(settings({ hijriFix: { 1447: { shawwal1: "2026-03-19" } } }), "Asia/Riyadh", JAN);
    expect(kind(earlier, "2026-03-19")).toBe("eid_fitr");
    expect(kind(earlier, "2026-03-18")).toBeNull();
    // The UAE, whose law adds 30 Ramadan when the month has 30 days, follows the same start: 20 March (a Friday it works) when Eid is the 21st.
    const ae = workCalendar(settings({ hijriFix: { 1447: { shawwal1: "2026-03-21" } } }), "Asia/Dubai", JAN);
    expect(["2026-03-19", "2026-03-20", "2026-03-23"].map((d) => kind(ae, d))).toEqual([null, "eid_fitr", "eid_fitr"]);
  });

  it("each Eid row shows its days off, and only a Saudi brand is told why Eid al-Fitr's days off may not move", async () => {
    await at(NOW, async () => {
      const C = appDict.ar.todo.cal;
      const sa = await owner("pg487sa");
      await signIn(sa.email);
      const html = await render("ar");
      expect(html).toContain(C.eidNoteSA);
      expect(html).toContain(fillIn(C.eidOff, { from: "الثلاثاء 9 مارس 2027", to: "الخميس 11 مارس 2027" }));
      expect(await render("en")).toContain(appDict.en.todo.cal.eidNoteSA);
      const ae = await owner("pg487ae", DUBAI_BRAND);
      await signIn(ae.email);
      const aeHtml = await render("ar");
      expect(aeHtml).not.toContain(C.eidNoteSA);
      expect(aeHtml).toContain(fillIn(C.eidOff, { from: "الثلاثاء 9 مارس 2027", to: "الخميس 11 مارس 2027" }));
      // The Umm al-Qura date of a moved Eid is written once in parentheses.
      expect(C.eidMoved).not.toMatch(/[()]/);
      expect(appDict.en.todo.cal.eidMoved).not.toMatch(/[()]/);
    });
  });
});

/** A copy template filled the way the page fills it. */
function fillIn(s: string, v: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);
}
