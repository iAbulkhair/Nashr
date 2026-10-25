import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { sc } from "@/lib/auth";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { composioRead, composioWrite, setComposioClientForTests, TOOLKIT_VERSION, type ComposioClient } from "@/lib/connectors/composio";
import { PROVIDER_TOOLKITS, TOOLKITS } from "@/lib/connectors/composio-catalog";
import { COMPOSIO_ONLY, PROVIDERS } from "@/lib/connectors/registry";
import { connectViaComposio } from "@/lib/connectors/via-composio";
import { eventsOf, inviteesOf, nextPageOf, userUriOf, webhookBody } from "@/lib/calendly-shape";
import { CLY_EVENTS_PER_POLL, dropCalendlyPoll, scheduleCalendlyPoll, sweepCalendly } from "@/lib/secretary-calendly";
import { applyBooking, parseCalendly } from "@/lib/secretary-booking";
import { hashBookToken, type BookRecord } from "@/lib/booking-token";
import { SEC_KEYS, secretaryKeys } from "@/lib/secretary";
import { listOpenItems } from "@/lib/secretary-store";
import { forgetDueScope } from "@/lib/secretary-read";
import { INTEGRATIONS } from "@/lib/integrations";
import { INTEGRATIONS as STATUS_ROWS } from "@/lib/integration-status";

/**
 * Rules 4300-4309: Reem reads a Calendly owner's bookings through Composio when the owner has no webhooks (Calendly's
 * free plan). Read only, the invitee's URI is the booking id on both paths, so a booking that arrives by the webhook and by
 * the poll is one item. Composio's client is a fake; answers follow the shapes of Calendly's own list answers.
 */
type Result = { data?: unknown; error?: string | null; successful: boolean };
type Answer = Result | ((args: Record<string, unknown>) => Result);
let calls: { slug: string; args: Record<string, unknown> }[];
let answers: Record<string, Answer>;

function fake(): ComposioClient {
  return {
    connectedAccounts: {
      link: async () => ({ id: "ca_new", redirectUrl: "https://connect.composio.dev/link/lk_1" }),
      waitForConnection: async (id) => ({ id, status: "ACTIVE" }),
      list: async () => ({ items: [] }),
      revoke: async () => {},
      delete: async () => {},
    },
    tools: {
      execute: async (slug, body) => {
        calls.push({ slug, args: body.arguments });
        const a = answers[slug];
        if (typeof a === "function") return a(body.arguments);
        return a ?? { successful: false, error: "not mocked" };
      },
    },
    files: { upload: async () => ({}) },
  };
}

beforeEach(() => {
  calls = [];
  answers = {};
  vi.stubEnv("COMPOSIO_API_KEY", "test-key");
  vi.stubEnv("COMPOSIO_PROVIDERS", "calendly");
  vi.stubEnv("COMPOSIO_AUTH_CALENDLY", "ac_cly");
  setComposioClientForTests(fake());
});
afterEach(() => { setComposioClientForTests(null); vi.unstubAllEnvs(); });

const API = "https://api.calendly.com";
const ME = `${API}/users/OWNERUSER00000001`;
const HOUR = 3_600_000, DAY = 86_400_000;
const ok = (data: unknown): Result => ({ successful: true, data });
const minuteFrom = (ms: number) => Math.ceil((Date.now() + ms) / 60_000) * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const evUri = (n: number) => `${API}/scheduled_events/EVT${String(n).padStart(8, "0")}`;
const invUri = (n: number) => `${evUri(n)}/invitees/INV${String(n).padStart(8, "0")}`;
const event = (n: number, startMs: number, status = "active", name = "Intro call") => ({ uri: evUri(n), name, status, start_time: iso(startMs), end_time: iso(startMs + 30 * 60_000) });
const invitee = (n: number, o: Record<string, unknown> = {}) => ({ uri: invUri(n), name: `Guest ${n}`, email: `guest${n}@example.com`, status: "active", rescheduled: false, old_invitee: null, questions_and_answers: [{ question: "q", answer: "Private answer" }], ...o });
const conn = (o: Partial<Connection> = {}): Connection => ({ provider: "calendly", data: { calendly: "ca_cly" }, meta: { via: "composio", calUser: ME, account: "Owner" }, connectedAt: "2026-10-25T10:00:00.000Z", ...o });

/** An owner whose Calendly is connected and whose scope is due now. */
async function connected(c: Connection = conn()) {
  const u = await newUser("cly");
  const scope = sc(u);
  await saveConnection(scope, c);
  await scheduleCalendlyPoll(scope, Date.now() - 1000);
  return { u, scope };
}
const sweep = () => sweepCalendly(Date.now() + 1000, Date.now() + 60_000);
const slugs = () => calls.map((c) => c.slug);
const recFor = (scope: string, login: string): BookRecord => ({ login, scope, provider: "calendly", lang: "en", createdAt: new Date().toISOString() });

describe("read only by construction (rule 4300)", () => {
  it("lists the three reads and no write tool, with a pinned version, and routes only through Composio", async () => {
    expect(Object.keys(TOOLKITS.calendly.read).sort()).toEqual(["CALENDLY_GET_CURRENT_USER", "CALENDLY_LIST_EVENT_INVITEES", "CALENDLY_LIST_SCHEDULED_EVENTS"]);
    expect(TOOLKITS.calendly.write).toEqual({});
    expect(TOOLKITS.calendly).toMatchObject({ provider: "calendly", authEnv: "COMPOSIO_AUTH_CALENDLY" });
    expect(PROVIDER_TOOLKITS.calendly).toEqual(["calendly"]);
    expect(TOOLKIT_VERSION.calendly).toMatch(/^\d{8}_\d{2}$/);
    expect(COMPOSIO_ONLY).toContain("calendly");
    expect(PROVIDERS.find((p) => p.id === "calendly")).toMatchObject({ kind: "oauth", capabilities: [] });
    for (const slug of ["CALENDLY_CREATE_SCHEDULING_LINK", "CALENDLY_CANCEL_EVENT", "CALENDLY_CREATE_WEBHOOK_SUBSCRIPTION", "CALENDLY_DELETE_INVITEE_DATA"]) {
      await expect(composioWrite("s", "calendly", slug, {}, "ca")).rejects.toThrow("composio_tool_not_allowed");
      await expect(composioRead("s", "calendly", slug, {}, "ca")).rejects.toThrow("composio_tool_not_allowed");
    }
    await expect(composioRead("s", "calendly", "CALENDLY_LIST_SCHEDULED_EVENTS", { organization: `${API}/organizations/O1` }, "ca")).rejects.toThrow("composio_argument_not_allowed");
    await expect(composioRead("s", "calendly", "CALENDLY_LIST_EVENT_INVITEES", { uuid: "E", email: "a@b.c" }, "ca")).rejects.toThrow("composio_argument_not_allowed");
    expect(calls).toEqual([]);
  });

  it("the page lists Calendly and the status row names COMPOSIO_AUTH_CALENDLY, which the catalog reads", () => {
    expect(INTEGRATIONS.find((i) => i.id === "calendly")).toMatchObject({ group: "data", status: "soon" });
    expect(STATUS_ROWS.find((r) => r.id === "composio")?.optional).toContain("COMPOSIO_AUTH_CALENDLY");
  });
});

describe("connecting Calendly (rule 4301)", () => {
  it("stores the owner's user URI from the current-user call, never 'me', and the profile name as the label", async () => {
    answers.CALENDLY_GET_CURRENT_USER = ok({ resource: { uri: ME, name: "Omar Owner", email: "omar@example.com", current_organization: `${API}/organizations/ORG1` } });
    const c = await connectViaComposio("s1", "calendly", "calendly", "ca_cly", null);
    expect(c.data).toEqual({ calendly: "ca_cly" });
    expect(c.meta).toMatchObject({ via: "composio", calUser: ME, account: "Omar Owner" });
    expect(JSON.stringify(c.meta)).not.toContain("omar@example.com");
    expect(calls.map((x) => x.slug)).toEqual(["CALENDLY_GET_CURRENT_USER"]);
    expect(calls[0].args).toEqual({});
  });

  it("refuses an answer with no Calendly user URI", async () => {
    for (const bad of [{ resource: { name: "x" } }, { resource: { uri: "https://evil.example/users/ABC" } }, { resource: { uri: `${API}/users/` } }, { resource: { uri: `${API}/users/A/../B` } }]) {
      answers.CALENDLY_GET_CURRENT_USER = ok(bad);
      await expect(connectViaComposio("s1", "calendly", "calendly", "ca_cly", null)).rejects.toThrow("calendly_no_user");
    }
  });
});

describe("reading Calendly's answers (rule 4302)", () => {
  it("keeps only events and invitees that are Calendly's own and sit under their event", () => {
    const start = minuteFrom(2 * DAY);
    const evs = eventsOf(ok({ collection: [event(1, start), { ...event(2, start), uri: "https://evil.example/scheduled_events/X" }, { uri: evUri(3), name: "no times" }] }).data);
    expect(evs.map((e) => e.uuid)).toEqual(["EVT00000001"]);
    const e = evs[0];
    const rows = inviteesOf({ collection: [invitee(1), { ...invitee(2), uri: invUri(2) }, { ...invitee(1), uri: "https://evil.example/invitees/1" }] }, e);
    expect(rows.map((r) => r.uri)).toEqual([invUri(1)]);
    expect(nextPageOf({ pagination: { next_page_token: "tok" } })).toBe("tok");
    expect(nextPageOf({ pagination: { next_page_token: null } })).toBeNull();
    expect(userUriOf({ data: { resource: { uri: ME } } })).toBe(ME);
  });

  it("builds the webhook's own body, so parseCalendly reads a polled booking exactly as a delivered one (create, cancel, reschedule)", () => {
    const start = minuteFrom(3 * DAY);
    const e = eventsOf({ collection: [event(1, start)] })[0];
    const made = parseCalendly(webhookBody(invitee(1), e));
    expect(made).toMatchObject({ kind: "create", externalId: invUri(1), name: "Guest 1", eventName: "Intro call", start: iso(start), end: iso(start + 30 * 60_000) });
    // The delivered body for the same invitee reads the same.
    const delivered = parseCalendly({ event: "invitee.created", payload: { uri: invUri(1), name: "Guest 1", scheduled_event: { name: "Intro call", start_time: iso(start), end_time: iso(start + 30 * 60_000) } } });
    expect(made).toEqual(delivered);
    expect(parseCalendly(webhookBody(invitee(1, { status: "canceled" }), e))).toMatchObject({ kind: "cancel", externalId: invUri(1) });
    // The cancel a reschedule sends is ignored; the new invitee owns the move.
    expect(parseCalendly(webhookBody(invitee(1, { status: "canceled", rescheduled: true }), e)).kind).toBe("ignore");
    expect(parseCalendly(webhookBody(invitee(2, { old_invitee: invUri(1) }), e))).toMatchObject({ kind: "move", externalId: invUri(2), oldExternalId: invUri(1) });
    // An old_invitee that is not Calendly's own is dropped, and nothing the guest typed is carried over.
    expect(parseCalendly(webhookBody(invitee(3, { old_invitee: "https://evil.example/x" }), e)).kind).toBe("create");
    expect(JSON.stringify(webhookBody(invitee(1), e))).not.toMatch(/guest1@example|Private answer/);
  });
});

describe("the poll makes one item per booking (rule 4303)", () => {
  function calendlyFor(start: number, over: { inviteesFor?: (uuid: string) => unknown[] } = {}) {
    answers.CALENDLY_LIST_SCHEDULED_EVENTS = (a) => ok({ collection: a.status === "active" ? [event(1, start)] : [], pagination: { next_page_token: null } });
    answers.CALENDLY_LIST_EVENT_INVITEES = (a) => ok({ collection: (over.inviteesFor ?? ((u) => (u === "EVT00000001" ? [invitee(1)] : [])))(String(a.uuid)) });
  }

  it("creates the item once, asks only for the owner's own events, and a second poll asks for no invitees again", async () => {
    const start = minuteFrom(2 * DAY);
    calendlyFor(start);
    const { u, scope } = await connected();
    const first = await sweep();
    expect(first).toMatchObject({ scopes: 1, polled: 1, created: 1, retried: 0 });
    const items = await listOpenItems(scope);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "booking" });
    expect(items[0].title).toContain("Guest 1");
    const list = calls.filter((c) => c.slug === "CALENDLY_LIST_SCHEDULED_EVENTS");
    expect(list).toHaveLength(2);
    for (const c of list) expect(c.args).toMatchObject({ user: ME, sort: "start_time:asc" });
    expect(list.map((c) => c.args.status).sort()).toEqual(["active", "canceled"]);
    expect(slugs().filter((s) => s === "CALENDLY_LIST_EVENT_INVITEES")).toHaveLength(1);
    // The scope is due again in fifteen minutes, and the memo names the event.
    const due = (await db.zrangeByScore(SEC_KEYS.clyDue, Date.now() + 16 * 60_000, 10)).map((m) => m.member);
    expect(due).toContain(scope);
    expect(await db.hgetall(SEC_KEYS.clyMemo(scope))).toEqual({ EVT00000001: "a" });

    calls = [];
    await scheduleCalendlyPoll(scope, Date.now() - 1000);
    const second = await sweep();
    expect(second).toMatchObject({ polled: 1, created: 0 });
    expect(slugs()).not.toContain("CALENDLY_LIST_EVENT_INVITEES");
    expect(await listOpenItems(scope)).toHaveLength(1);
    expect(u.email).toBeTruthy();
  });

  it("a booking that arrives by the webhook first, or by the poll first, is one item", async () => {
    const start = minuteFrom(2 * DAY);
    const hash = hashBookToken("a-webhook-link");
    calendlyFor(start);
    // Webhook first.
    const a = await connected();
    const body = { event: "invitee.created", payload: { uri: invUri(1), name: "Guest 1", scheduled_event: { name: "Intro call", start_time: iso(start), end_time: iso(start + 30 * 60_000) } } };
    expect(await applyBooking(recFor(a.scope, a.u.email), parseCalendly(body), hash)).toBe("created");
    expect(await sweep()).toMatchObject({ polled: 1, created: 0 });
    expect(await listOpenItems(a.scope)).toHaveLength(1);
    // Poll first.
    const b = await connected();
    expect(await sweep()).toMatchObject({ created: 1 });
    expect(await applyBooking(recFor(b.scope, b.u.email), parseCalendly(body), hash)).toBe("noop");
    expect(await listOpenItems(b.scope)).toHaveLength(1);
  });

  it("a cancelled event removes the item, and a cancel that comes before the booking was seen makes none", async () => {
    const start = minuteFrom(2 * DAY);
    calendlyFor(start);
    const { scope } = await connected();
    await sweep();
    expect(await listOpenItems(scope)).toHaveLength(1);
    answers.CALENDLY_LIST_SCHEDULED_EVENTS = (a) => ok({ collection: a.status === "canceled" ? [event(1, start, "canceled")] : [] });
    answers.CALENDLY_LIST_EVENT_INVITEES = () => ok({ collection: [invitee(1, { status: "canceled" })] });
    await scheduleCalendlyPoll(scope, Date.now() - 1000);
    expect(await sweep()).toMatchObject({ polled: 1, removed: 1 });
    expect(await listOpenItems(scope)).toHaveLength(0);
    expect(await db.hgetall(SEC_KEYS.clyMemo(scope))).toEqual({ EVT00000001: "c" });
    // Another owner: the event was cancelled before the poll ever saw it as active.
    const other = await connected();
    expect(await sweep()).toMatchObject({ polled: 1, created: 0 });
    expect(await listOpenItems(other.scope)).toHaveLength(0);
  });

  it("a reschedule is one move: the old invitee's cancel is ignored and the new invitee moves the item", async () => {
    const start = minuteFrom(2 * DAY), later = start + 3 * HOUR;
    calendlyFor(start);
    const { scope } = await connected();
    await sweep();
    answers.CALENDLY_LIST_SCHEDULED_EVENTS = (a) => ok({ collection: a.status === "active" ? [event(2, later)] : [event(1, start, "canceled")] });
    answers.CALENDLY_LIST_EVENT_INVITEES = (a) => ok({ collection: a.uuid === "EVT00000002" ? [invitee(2, { old_invitee: invUri(1) })] : [invitee(1, { status: "canceled", rescheduled: true })] });
    await scheduleCalendlyPoll(scope, Date.now() - 1000);
    expect(await sweep()).toMatchObject({ polled: 1, moved: 1, removed: 0 });
    const items = await listOpenItems(scope);
    expect(items).toHaveLength(1);
    expect(Date.parse(items[0].dueAt as string)).toBe(later);
  });

  it("looks at no more than the per-poll cap of events and leaves the rest to the next poll", async () => {
    const start = minuteFrom(2 * DAY);
    const n = CLY_EVENTS_PER_POLL + 5;
    answers.CALENDLY_LIST_SCHEDULED_EVENTS = (a) => ok({ collection: a.status === "active" ? Array.from({ length: n }, (_, i) => event(i + 1, start + i * HOUR)) : [] });
    answers.CALENDLY_LIST_EVENT_INVITEES = (a) => ok({ collection: [invitee(Number(String(a.uuid).slice(3)))] });
    const { scope } = await connected();
    await sweep();
    expect(slugs().filter((s) => s === "CALENDLY_LIST_EVENT_INVITEES")).toHaveLength(CLY_EVENTS_PER_POLL);
    expect(Object.keys(await db.hgetall(SEC_KEYS.clyMemo(scope)))).toHaveLength(CLY_EVENTS_PER_POLL);
  });
});

describe("who is polled and what stops it (rule 4304)", () => {
  it("drops a scope with no connection, one that needs reconnecting, and one whose user URI is not Calendly's, without a call", async () => {
    const none = await newUser("cly");
    await scheduleCalendlyPoll(sc(none), Date.now() - 1000);
    const needs = await connected(conn({ needsReconnect: new Date().toISOString() }));
    const bad = await connected(conn({ meta: { via: "composio", calUser: "https://evil.example/users/X" } }));
    const report = await sweep();
    expect(report).toMatchObject({ scopes: 3, polled: 0 });
    expect(calls).toEqual([]);
    const left = (await db.zrangeByScore(SEC_KEYS.clyDue, Date.now() + DAY, 50)).map((m) => m.member);
    for (const s of [sc(none), needs.scope, bad.scope]) expect(left).not.toContain(s);
  });

  it("a refused login marks the connection to reconnect and leaves the queue; a passing failure keeps it and tries again in fifteen minutes", async () => {
    answers.CALENDLY_LIST_SCHEDULED_EVENTS = { successful: false, error: "401 Unauthorized: token expired" };
    const a = await connected();
    expect(await sweep()).toMatchObject({ scopes: 1, polled: 0, retried: 0 });
    expect((await getConnection(a.scope, "calendly"))?.needsReconnect).toBeTruthy();
    expect((await db.zrangeByScore(SEC_KEYS.clyDue, Date.now() + DAY, 50)).map((m) => m.member)).not.toContain(a.scope);

    answers.CALENDLY_LIST_SCHEDULED_EVENTS = { successful: false, error: "upstream timeout" };
    const b = await connected();
    expect(await sweep()).toMatchObject({ scopes: 1, polled: 0, retried: 1 });
    expect((await getConnection(b.scope, "calendly"))?.needsReconnect).toBeFalsy();
    expect((await db.zrangeByScore(SEC_KEYS.clyDue, Date.now() + 16 * 60_000, 50)).map((m) => m.member)).toContain(b.scope);
    expect(await listOpenItems(b.scope)).toHaveLength(0);
  });

  it("reads only the scope it took from the queue: another owner's connection is never touched", async () => {
    const start = minuteFrom(2 * DAY);
    answers.CALENDLY_LIST_SCHEDULED_EVENTS = (a) => ok({ collection: a.status === "active" ? [event(1, start)] : [] });
    answers.CALENDLY_LIST_EVENT_INVITEES = () => ok({ collection: [invitee(1)] });
    const a = await connected();
    const idle = await connected(conn({ data: { calendly: "ca_other" } }));
    await db.zrem(SEC_KEYS.clyDue, idle.scope);
    await sweep();
    expect(await listOpenItems(a.scope)).toHaveLength(1);
    expect(await listOpenItems(idle.scope)).toHaveLength(0);
    expect(calls.every((c) => c.args.user === ME || c.slug === "CALENDLY_LIST_EVENT_INVITEES")).toBe(true);
  });

  it("a disconnect or an account wipe takes the scope out of the queue and clears the memo", async () => {
    const { scope } = await connected();
    await db.hset(SEC_KEYS.clyMemo(scope), "EVT00000001", "a");
    expect(await secretaryKeys(scope)).toContain(SEC_KEYS.clyMemo(scope));
    await dropCalendlyPoll(scope);
    expect((await db.zrangeByScore(SEC_KEYS.clyDue, Date.now() + DAY, 50)).map((m) => m.member)).not.toContain(scope);
    expect(await db.hgetall(SEC_KEYS.clyMemo(scope))).toEqual({});
    await scheduleCalendlyPoll(scope, Date.now());
    await forgetDueScope(scope);
    expect((await db.zrangeByScore(SEC_KEYS.clyDue, Date.now() + DAY, 50)).map((m) => m.member)).not.toContain(scope);
  });
});

describe("where the poll is wired (rule 4305)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("the secretary tick runs it on the calendars' deadline and answers its counts", () => {
    const tick = read("src/app/api/cron/secretary/route.ts");
    expect(tick).toMatch(/sweepCalendly\(now, calDeadline\)/);
    expect(tick).toMatch(/\.\.\.sweep, calendars, calendly, digests/);
  });
  it("the connect callback schedules the first poll and the disconnect drops it", () => {
    expect(read("src/app/api/connect/[provider]/callback/route.ts")).toMatch(/p\.id === "calendly"\) await scheduleCalendlyPoll\(st\.email/);
    expect(read("src/app/api/connect/[provider]/route.ts")).toMatch(/provider === "calendly" \? dropCalendlyPoll\(sc\(u\)\)/);
  });
});
