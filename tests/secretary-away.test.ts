import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeOn } from "./helpers/model";
import { json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { type User } from "@/lib/auth";
import { AGENT_IDS } from "@/lib/agents";
import { appDict } from "@/lib/app-i18n";
import { saveBrand, type Brand } from "@/lib/brand";
import { saveBrands, scopeFor, setActiveBrand } from "@/lib/brands";
import { wipeAccount } from "@/lib/account";
import { runTool, system } from "@/lib/chat";
import {
  OWNER_ALIASES, SEC_KEYS, SEC_READS_PER_HOUR, SEC_WRITES_PER_HOUR, agendaFor, calFor, changeItem, createItem, getItem, secretaryDaily, toolError, type Who,
} from "@/lib/secretary";
import { buildWrap } from "@/lib/secretary-evening";
import { addDays, partyKey, zoneDay, type SecItem } from "@/lib/secretary-agenda";
import { parseCalendar, upcomingQuiet, workCalendar, type SecCalendar } from "@/lib/secretary-calendar";
import { AWAY_AHEAD_DAYS, AWAY_KEEP_DAYS, AWAY_MAX, cleanAway, endAway, listAway, setAway } from "@/lib/secretary-away";
import * as itemRoute from "@/app/api/secretary/[id]/route";
import * as listRoute from "@/app/api/secretary/route";
import * as awayRoute from "@/app/api/secretary/away/route";
import * as calRoute from "@/app/api/secretary/calendar/route";

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
async function owner(prefix: string, brand: Brand = BRAND): Promise<User> {
  const u = await newUser(prefix);
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
    for (const bad of [{ v: 1, holidays: { add: "x" } }, { v: 1, ramadanHours: [null] }]) {
      const u = await owner("awbad");
      await db.set(SEC_KEYS.cal(u.email), bad);
      const a = await agendaFor(u.email, local("2026-10-01T12:00"));
      expect(a.cal.weekend).toEqual([5, 6]);
      expect(a.open).toBe(0);
    }
    expect(errors.mock.calls).toEqual([["sec calendar unreadable, defaults used", "TypeError"], ["sec calendar unreadable, defaults used", "TypeError"]]);
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
        messages = { stream: (p: { system: { text: string }[] }) => { sent.push(p); return { finalMessage: async () => ({ model: "m", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "تمام" }] }) }; } };
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

  it("ending keeps the field with until set to yesterday (the back alert reads it); ending one that has already ended removes it (ruling R19); an unknown name is not_found", async () => {
    const u = await owner("aw482e");
    await setAway(u.email, { label: "Sara", until: "2026-10-20", note: "Leave" }, PERSON, NOW, "Asia/Riyadh");
    const ended = await endAway(u.email, " SARA ", PERSON, NOW, "Asia/Riyadh");
    expect(ended).toMatchObject({ ok: true, removed: false, entry: { label: "Sara", until: "2026-10-05", note: "Leave" } });
    expect(await db.hgetall(SEC_KEYS.away(u.email))).toEqual({ sara: { label: "Sara", until: "2026-10-05", note: "Leave", by: PERSON.login, via: "web", at: iso(NOW) } });
    expect((await calFor(u.email, NOW)).away.sara).toEqual({ label: "Sara", until: "2026-10-05", endedAt: "2026-10-05" });
    // Today was the last away day: ending it now still makes yesterday the last one.
    await setAway(u.email, { label: "Huda", until: "2026-10-06" }, PERSON, NOW, "Asia/Riyadh");
    expect(await endAway(u.email, "Huda", PERSON, NOW, "Asia/Riyadh")).toMatchObject({ ok: true, removed: false, entry: { until: "2026-10-05" } });
    // Ending an entry that has already ended frees its field for the cap.
    expect(await endAway(u.email, "Sara", PERSON, NOW, "Asia/Riyadh")).toMatchObject({ ok: true, removed: true });
    expect(await awayKeys(u.email)).toEqual(["huda"]);
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
    expect(errors.mock.calls).toContainEqual(["sec away clean-up failed", "TypeError"]);
    expect(await awayKeys(u.email)).toEqual(["old", "sara"]);
  });

  it("every write leaves an away or away_end audit line with the login, the label and the date", async () => {
    const u = await owner("aw482h");
    await setAway(u.email, { label: "أحمد", until: "2026-10-08", note: "Private note" }, PERSON, NOW, "Asia/Riyadh");
    await setAway(u.email, { label: "احمد", until: "2026-10-09" }, PERSON, NOW, "Asia/Riyadh");
    await endAway(u.email, "أحمد", PERSON, NOW, "Asia/Riyadh");
    await endAway(u.email, "أحمد", PERSON, NOW, "Asia/Riyadh");
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
      expect(await d.json()).toMatchObject({ ok: true, removed: false, entry: { label: "Sara", until: "2026-10-05" } });
      expect((await (await awayGet()).json()).entries).toEqual([{ ...entry, until: "2026-10-05", ended: true }]);
      expect((await auditLines(o.email)).map((l) => [l.action, l.login])).toEqual([["away", m.email], ["away_end", m.email]]);
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
      const u = await owner("aw483c");
      const b2 = scopeFor(u.email, "b2");
      await saveBrands(u.email, [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, { id: "b2", name: "Two", createdAt: new Date().toISOString(), status: "active" }]);
      await saveBrand(b2, { ...BRAND, name: "Two" });
      await signIn(u.email);
      await setActiveBrand(u.email, "b2");
      expect((await awayPut({ label: "Sara", until: "2026-10-09", scope: u.email })).status).toBe(200);
      expect(await awayKeys(b2)).toEqual(["sara"]);
      expect(await awayKeys(u.email)).toEqual([]);
      await setActiveBrand(u.email, "default");
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
      expect(j.effective).toEqual({ country: "SA", zone: "Asia/Riyadh", weekend: [5, 6], defaultWeekend: [5, 6], weekStart: 0, ramadanHours: [{ from: "10:00", to: "15:00" }] });
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
        [{ hijriFix: { "1500": { ramadan1: "2027-02-09" } } }, { error: "bad_year", field: "hijriFix.1500" }],
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
      // Ramadan 1448's Umm al-Qura start, moved a day on by the owner's sighting; a holiday the defaults give, removed; two added.
      const ramadan = upcomingQuiet(null, "Asia/Riyadh", t1).ramadan!;
      const body = { weekend: [4, 5], ramadanHours: [{ from: "09:00", to: "12:00" }, { from: "20:00", to: "23:30" }], hijriFix: { "1448": { ramadan1: addDays(ramadan.start, 1) } }, holidays: { add: ["2026-12-27", "H-01-10"], remove: ["02-22"] } };
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
      expect(errors.mock.calls).toEqual([["sec calendar unreadable, defaults used", "TypeError"]]);
      expect((await calPut({ weekend: [5] })).status).toBe(200);
      expect((await storedCal(o.email))?.weekend).toEqual([5]);
    });
  });

  it("a PUT in brand B stores under B's scope alone, whatever the body names, and each brand's GET reads its own", async () => {
    await at(NOW, async () => {
      const u = await owner("c484b");
      const b2 = scopeFor(u.email, "b2");
      await saveBrands(u.email, [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, { id: "b2", name: "Two", createdAt: new Date().toISOString(), status: "active" }]);
      await saveBrand(b2, { ...BRAND, name: "Two" });
      await signIn(u.email);
      await setActiveBrand(u.email, "b2");
      expect((await calPut({ weekend: [5], scope: u.email })).status).toBe(400);
      expect(await Promise.all([storedCal(u.email), storedCal(b2)])).toEqual([null, null]);
      expect((await calPut({ weekend: [5] })).status).toBe(200);
      expect((await storedCal(b2))?.weekend).toEqual([5]);
      expect(await storedCal(u.email)).toBeNull();
      expect((await (await calGet()).json()).calendar.weekend).toEqual([5]);
      expect((await auditLines(b2)).map((l) => l.action)).toEqual(["calendar"]);
      expect(await auditLines(u.email)).toEqual([]);
      await setActiveBrand(u.email, "default");
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
