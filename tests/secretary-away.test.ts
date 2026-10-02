import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeOn } from "./helpers/model";
import { json, newUser, params, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { type User } from "@/lib/auth";
import { saveBrand, type Brand } from "@/lib/brand";
import { saveBrands, scopeFor } from "@/lib/brands";
import { wipeAccount } from "@/lib/account";
import { runTool, system } from "@/lib/chat";
import { SEC_KEYS, agendaFor, calFor, changeItem, createItem, getItem, type Who } from "@/lib/secretary";
import { buildWrap } from "@/lib/secretary-evening";
import { partyKey, zoneDay, type SecItem } from "@/lib/secretary-agenda";
import { workCalendar, type SecCalendar } from "@/lib/secretary-calendar";
import * as itemRoute from "@/app/api/secretary/[id]/route";

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

  it("system() names the brand's week start: a Friday-only weekend starts the week on Saturday", () => {
    const u = { email: "x@test.example", credits: 5, plan: "starter", trialEnds: "2026-10-01" } as User;
    expect(system(BRAND, u, [], "", [], [], "reem")[2].text).toContain("The work week starts on Sunday.");
    expect(system(BRAND, u, [], "", [], [], "reem", undefined, undefined, [5])[2].text).toContain("The work week starts on Saturday.");
    expect(system(DUBAI_BRAND, u, [], "", [], [], "noor")[2].text).toContain("The work week starts on Monday.");
  });

  it("chat() reads sec:cal with its other reads and gives the prompt the brand's week start", async () => {
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
    } finally {
      vi.doUnmock("@anthropic-ai/sdk");
      vi.doUnmock("@/lib/model");
      vi.unstubAllEnvs();
    }
  });
});
