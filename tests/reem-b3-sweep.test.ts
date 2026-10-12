/**
 * Reem B3, the calendar sync and its hook in the secretary tick (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §6
 * and §7, rulings R3, R5, R7, R8, R9, R11). Rule 913: only the chosen calendar is ever asked for events. Rule 915: a tick takes
 * at most 50 scopes, 8 at a time, nothing new starts after the deadline, and the cron answer carries `calendars`. Rule 916: a
 * lost grant, a gone calendar, a changed domain, an archived brand or a suspended owner end the link safely (one notice), a
 * provider error keeps the events and retries, a busy lock defers, and a link that vanished mid-sync is never brought back.
 * Rule 921 (reset part): a password reset and an account wipe drop the owner's links. Nashr never calls a provider's revoke
 * endpoint (ruling R7).
 */
import { createHash, randomBytes } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jar, json, markVerified, newMember, newUser, params, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { SEC_KEYS } from "@/lib/secretary";
import { addBrand, saveBrands, scopeFor, type BrandMeta } from "@/lib/brands";
import { saveBrand, type Brand } from "@/lib/brand";
import { createUser, getUser, saveUser } from "@/lib/auth";
import { OAUTH_COOKIE } from "@/lib/connectors/store";
import { listNotifs } from "@/lib/notifications";
import { dropLink, getLink, meetingsNow, putEvents, putLink, scheduleSync, sealTokens, type CalLink } from "@/lib/secretary-cal-link";
import { CAL_CONCURRENCY, CAL_SYNC_MS, CAL_TICK_MAX, revokeCalendarLinks, sweepCalendars } from "@/lib/secretary-gcal";
import { wipeAccount } from "@/lib/account";
import * as start from "@/app/api/connect/[provider]/start/route";
import * as callback from "@/app/api/connect/[provider]/callback/route";
import * as linkRoute from "@/app/api/secretary/calendar-link/route";
import * as listRoute from "@/app/api/secretary/calendar-link/calendars/route";
import * as tick from "@/app/api/cron/secretary/route";
import * as resetRoute from "@/app/api/auth/reset/route";
import * as adminUserRoute from "@/app/api/admin/users/[email]/route";

const ENV = { GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "msecret" };
const PROVIDER_TEXT = "SECRET-PROVIDER-TEXT";
const CAL1 = "calid-one/odd id@group.calendar.google.com";
const CAL2 = "calid-two@group.calendar.google.com";
const FOUNDER = "founder-sweep@test.example";
const HOUR = 3_600_000;

const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const isoAt = (ms: number) => new Date(ms).toISOString();
const graphAt = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}.0000000`;

type Fake = {
  refreshStatus?: number;
  refreshBody?: string;
  refreshIdToken?: string | null;
  /** The answer of the events call: a status (with a `Retry-After` when `retryAfter` is set), or a function that answers (may change the store first). */
  eventsStatus?: number;
  retryAfter?: string;
  onEvents?: (url: string) => Promise<void> | void;
  /** Events to answer with, as provider items; default is one busy meeting an hour from `Date.now()`. */
  items?: unknown[];
  /** Graph's /organization and /me for the Outlook proof. */
  orgDomains?: string[];
  upn?: string;
};
let urls: string[] = [];
function fake(o: Fake = {}) {
  urls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url === "https://oauth2.googleapis.com/token" || url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
      if (o.refreshStatus) return new Response(o.refreshBody ?? PROVIDER_TEXT, { status: o.refreshStatus });
      const t: Record<string, unknown> = { access_token: "NEW-ACCESS", expires_in: 3599 };
      if (init?.body && String(init.body).includes("authorization_code")) {
        t.refresh_token = "the-refresh";
        t.id_token = idToken(url.includes("google") ? { email: "o@brand.example", email_verified: true, hd: "brand.example" } : { tid: "tenant-1" });
      } else if (o.refreshIdToken) t.id_token = o.refreshIdToken;
      return Response.json(t);
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList")) {
      return Response.json({ items: [{ id: CAL1, summary: "Marketing", accessRole: "owner" }, { id: CAL2, summary: "Campaigns", accessRole: "owner" }, { id: "shared-x", summary: "Someone's", accessRole: "reader" }] });
    }
    if (/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/calendars\?/.test(url)) {
      return Response.json({ value: [CAL1, CAL2].map((id, i) => ({ id, name: i ? "Campaigns" : "Marketing", canEdit: true, owner: { address: "o@brand.example" } })) });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return Response.json({ userPrincipalName: o.upn ?? "o@brand.example", mail: "o@brand.example" });
    if (url.startsWith("https://graph.microsoft.com/v1.0/organization")) return Response.json({ value: [{ verifiedDomains: (o.orgDomains ?? ["brand.example"]).map((name) => ({ name })) }] });
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/") || url.startsWith("https://graph.microsoft.com/v1.0/me/calendars/")) {
      await o.onEvents?.(url);
      if (o.eventsStatus) return new Response(PROVIDER_TEXT, { status: o.eventsStatus, headers: o.retryAfter === undefined ? {} : { "retry-after": o.retryAfter } });
      const google = url.startsWith("https://www.googleapis.com");
      const at = Date.now() + HOUR;
      if (google) return Response.json({ items: o.items ?? [{ summary: "Launch review", start: { dateTime: isoAt(at) }, end: { dateTime: isoAt(at + HOUR) } }] });
      return Response.json({ value: o.items ?? [{ subject: "Launch review", start: { dateTime: graphAt(at), timeZone: "UTC" }, end: { dateTime: graphAt(at + HOUR), timeZone: "UTC" }, isAllDay: false, showAs: "busy" }] });
    }
    return new Response("not mocked", { status: 500 });
  }));
}
const eventUrls = () => urls.filter((u) => /\/calendars\/[^?]+\/(events|calendarView)\?/.test(u) || /\/calendarView\?/.test(u));

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  // The queue is global: what an earlier test left due must not be taken by this one.
  await db.del(SEC_KEYS.calDue);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const seed = (login: string, over: Partial<CalLink> = {}): CalLink => ({
  v: 1,
  provider: "gcal",
  login,
  account: "o@brand.example",
  accountDomain: "brand.example",
  proof: "declaration",
  declaration: { by: login, at: new Date().toISOString(), v: 1 },
  calendarId: CAL1,
  calendarName: "Marketing",
  tokens: sealTokens({ access: "OLD-ACCESS", refresh: "OLD-REFRESH", expiresAt: Date.now() + HOUR }),
  state: "ok",
  connectedAt: 1000,
  rev: 3,
  ...over,
});
const owner = () => newUser("sweep");
/** A linked scope that is due now. */
async function linked(login: string, scope = login, over: Partial<CalLink> = {}, dueAt = Date.now() - 1000) {
  await putLink(scope, seed(login, over));
  await scheduleSync(scope, dueAt);
  return scope;
}
const brandAt = (website: string) => ({ name: "B", website } as Brand);
const sweep = (now = Date.now()) => sweepCalendars(now, now + 60_000);
const lostNotices = async (email: string) => (await listNotifs(email)).filter((n) => /تقويم التسويق|Marketing calendar/.test(n.title));
const auditOf = async (scope: string) => (await db.lrange(SEC_KEYS.audit(scope), 0, -1)).map((x) => JSON.parse(x) as { action: string; actor: string; via: string; login?: string; diff: string });

describe("rule 913: only the chosen calendar is read, for both providers", () => {
  const ctx = (provider: string) => params({ provider });
  const where = (res: Response) => new URL(res.headers.get("location")!);

  for (const provider of ["gcal", "mscal"] as const) {
    it(`${provider}: callback, calendar list, choice, then one sweep asks the chosen id and nothing else`, async () => {
      fake();
      const o = await owner();
      await saveBrand(o.email, brandAt("https://brand.example"));
      await signIn(o.email);
      expect((await start.GET(new Request(`https://app.test/api/connect/${provider}/start`), ctx(provider))).status).toBe(307);
      const state = jar().get(OAUTH_COOKIE)!;
      expect(where(await callback.GET(new Request(`https://app.test/api/connect/${provider}/callback?state=${state}&code=c1`), ctx(provider))).search).toBe("?cal=choose");
      expect((await listRoute.GET()).status).toBe(200);
      const put = await linkRoute.PUT(json("/api/secretary/calendar-link", "PUT", { choice: 1, rev: 1 }));
      expect(put.status).toBe(200);
      expect((await getLink(o.email))).toMatchObject({ state: "ok", calendarId: CAL2, proof: "domain" });
      urls = [];
      const report = await sweepCalendars(Date.now() + 1000, Date.now() + 60_000);
      expect(report).toMatchObject({ scopes: 1, synced: 1, lost: 0 });
      const ev = eventUrls();
      expect(ev.length).toBe(1);
      for (const u of ev) {
        expect(u).toContain(encodeURIComponent(CAL2));
        expect(u).not.toContain(encodeURIComponent(CAL1));
      }
      for (const u of urls) {
        expect(u).not.toContain("/calendars/primary");
        expect(u).not.toContain("/me/events");
        expect(u).not.toContain("/me/calendar/");
        expect(u).not.toContain(encodeURIComponent(CAL1));
        expect(u).not.toContain("/revoke");
      }
      expect(await meetingsNow(o.email, Date.now() + 1000)).toHaveLength(1);
    });
  }
});

describe("rule 915: what one tick takes, and the deadline", () => {
  /** One owner with `n` brands, each linked and due, the oldest first. Returns the scopes in due order. */
  async function many(n: number) {
    const o = await owner();
    const rows: BrandMeta[] = Array.from({ length: n - 1 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, createdAt: new Date().toISOString(), status: "active" as const }));
    await saveBrands(o.email, [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, ...rows]);
    const scopes = [o.email, ...rows.map((r) => scopeFor(o.email, r.id))];
    const base = Date.now() - 100_000;
    await Promise.all(scopes.map(async (s, i) => { await putLink(s, seed(o.email)); await scheduleSync(s, base + i); }));
    return { o, scopes, base };
  }

  it("the constants: 15 minutes, 50 scopes a tick, 8 at a time", () => {
    expect(CAL_SYNC_MS).toBe(15 * 60_000);
    expect(CAL_TICK_MAX).toBe(50);
    expect(CAL_CONCURRENCY).toBe(8);
  });

  it("with 60 due scopes one tick syncs 50 and leaves 10 due; the next tick takes them", async () => {
    fake();
    const { scopes } = await many(60);
    const now = Date.now();
    const r = await sweepCalendars(now, now + 60_000);
    expect(r).toMatchObject({ scopes: 50, synced: 50, lost: 0, retried: 0, deferred: 0 });
    const scores = await Promise.all(scopes.map((s) => db.zscore(SEC_KEYS.calDue, s)));
    expect(scores.slice(0, 50).every((x) => x !== null && x >= now + CAL_SYNC_MS)).toBe(true);
    expect(scores.slice(50).every((x) => x !== null && x < now)).toBe(true);
    const r2 = await sweepCalendars(now, now + 60_000);
    expect(r2).toMatchObject({ scopes: 10, synced: 10 });
  });

  it("at most 8 scopes run at once", async () => {
    let live = 0;
    let peak = 0;
    fake({ onEvents: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; } });
    await many(20);
    await sweep();
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("R16: nothing new starts within 35 s of the deadline; the rest keep their past score and count as deferred", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const deadline = t0 + 60_000;
    // The first syncs run; their provider call moves the clock to exactly the cutoff (deadline - 35 s).
    fake({ onEvents: () => { vi.setSystemTime(deadline - 35_000); } });
    const { scopes, base } = await many(30);
    const r = await sweepCalendars(t0, deadline);
    expect(r.scopes).toBe(30);
    expect(r.deferred).toBeGreaterThan(0);
    expect(r.synced + r.deferred).toBe(30);
    expect(r.synced).toBeLessThanOrEqual(8);
    const scores = await Promise.all(scopes.map((s) => db.zscore(SEC_KEYS.calDue, s)));
    expect(scores.filter((x) => x !== null && x < t0).length).toBe(r.deferred);
    // The deferred ones kept exactly the score they had.
    scores.forEach((x, i) => { if (x !== null && x < t0) expect(x).toBe(base + i); });
  });

  it("R16: a scope due when the cutoff has already passed is not started: no provider call, past score kept", async () => {
    fake();
    const o = await owner();
    const due = Date.now() - 5000;
    await linked(o.email, o.email, {}, due);
    const now = Date.now();
    expect(await sweepCalendars(now, now + 35_000)).toMatchObject({ scopes: 1, synced: 0, deferred: 1, retried: 0 });
    expect(urls).toEqual([]);
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBe(due);
    // A deadline a hair further out starts it.
    expect(await sweepCalendars(now, now + 35_001 + 1000)).toMatchObject({ synced: 1, deferred: 0 });
  });

  it("the cron route answers with calendars, from the bearer", async () => {
    fake();
    vi.stubEnv("CRON_SECRET", "cron-b3-sweep");
    const o = await owner();
    await linked(o.email);
    const res = await tick.POST(new Request("https://nashr.test/api/cron/secretary", { method: "POST", headers: { "x-real-ip": "203.0.113.77", authorization: "Bearer cron-b3-sweep" }, body: "" }));
    expect(res.status).toBe(200);
    const b = (await res.json()) as { ok: boolean; calendars: { scopes: number; synced: number; lost: number; retried: number; deferred: number } };
    expect(b.ok).toBe(true);
    expect(b.calendars).toMatchObject({ synced: 1, lost: 0, retried: 0, deferred: 0 });
    expect(b.calendars.scopes).toBeGreaterThanOrEqual(1);
  });
});

describe("rule 916: a sync keeps, retries, defers or loses the link", () => {
  it("a good sync stores the kept meetings for 24 hours, sets lastSyncAt and syncedAt, and schedules the next in 15 minutes", async () => {
    fake({ items: [
      { summary: "Launch review", start: { dateTime: isoAt(Date.now() + HOUR) }, end: { dateTime: isoAt(Date.now() + 2 * HOUR) } },
      { summary: "Cancelled", status: "cancelled", start: { dateTime: isoAt(Date.now() + HOUR) }, end: { dateTime: isoAt(Date.now() + 2 * HOUR) } },
      { summary: "Secret deal", visibility: "private", start: { dateTime: isoAt(Date.now() + 3 * HOUR) }, end: { dateTime: isoAt(Date.now() + 4 * HOUR) } },
    ] });
    const o = await owner();
    await linked(o.email);
    const now = Date.now();
    expect(await sweepCalendars(now, now + 60_000)).toMatchObject({ synced: 1 });
    const ev = (await db.get<{ syncedAt: number; events: { title: string; private?: boolean }[] }>(SEC_KEYS.calEvents(o.email)))!;
    expect(ev.syncedAt).toBe(now);
    expect(ev.events.map((e) => e.title)).toEqual(["Launch review", ""]);
    expect(ev.events[1].private).toBe(true);
    expect(JSON.stringify(ev)).not.toContain("Secret");
    const ttl = await db.ttl(SEC_KEYS.calEvents(o.email));
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
    expect((await getLink(o.email))).toMatchObject({ state: "ok", lastSyncAt: now, rev: 3 });
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBe(now + CAL_SYNC_MS);
    // Only the window of the next 7 days is asked for.
    const u = new URL(eventUrls()[0]);
    expect(Date.parse(u.searchParams.get("timeMin")!)).toBe(now);
    expect(Date.parse(u.searchParams.get("timeMax")!)).toBe(now + 7 * 86_400_000);
  });

  it("invalid_grant: reconnect with lostReason token, the events deleted, out of the queue, one notice and one cal_lost; a second tick adds none", async () => {
    fake({ refreshStatus: 400, refreshBody: '{"error":"invalid_grant"}' });
    const o = await owner();
    await linked(o.email, o.email, { tokens: sealTokens({ access: "OLD-ACCESS", refresh: "OLD-REFRESH", expiresAt: Date.now() - 1000 }) });
    await putEvents(o.email, { syncedAt: Date.now(), events: [{ start: isoAt(Date.now() + HOUR), end: isoAt(Date.now() + 2 * HOUR), title: "old", allDay: false }] });
    expect(await sweep()).toMatchObject({ scopes: 1, lost: 1, synced: 0 });
    expect(await getLink(o.email)).toMatchObject({ state: "reconnect", lostReason: "token" });
    expect(await db.get(SEC_KEYS.calEvents(o.email))).toBeNull();
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBeNull();
    const n = await lostNotices(o.email);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: "todo", agent: "reem", title: "تقويم التسويق يحتاج إعادة ربط", href: "/ar/app/todo" });
    expect(n[0].body).toBeTruthy();
    expect(JSON.stringify(n)).not.toContain("OLD-");
    expect((await auditOf(o.email)).filter((a) => a.action === "cal_lost")).toEqual([expect.objectContaining({ actor: "cron", via: "cron", login: o.email, diff: "provider=gcal" })]);
    // A second tick: put it back in the queue by hand; the link is already in reconnect, so nothing more happens.
    await scheduleSync(o.email, Date.now() - 1000);
    await sweep();
    expect(await lostNotices(o.email)).toHaveLength(1);
    expect((await auditOf(o.email)).filter((a) => a.action === "cal_lost")).toHaveLength(1);
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBeNull();
  });

  it("the notice is in English for an English owner", async () => {
    fake({ refreshStatus: 400, refreshBody: '{"error":"invalid_grant"}' });
    const o = await owner();
    const u = (await getUser(o.email))!;
    await saveUser({ ...u, lang: "en" });
    await linked(o.email, o.email, { tokens: sealTokens({ access: "A", refresh: "R", expiresAt: Date.now() - 1000 }) });
    await sweep();
    const n = await lostNotices(o.email);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ title: "Marketing calendar needs reconnecting", href: "/en/app/todo" });
  });

  it("a loss found by a route notifies too, once (the notice lives in loseLink)", async () => {
    fake({ refreshStatus: 400, refreshBody: '{"error":"invalid_grant"}' });
    const o = await owner();
    await signIn(o.email);
    await putLink(o.email, seed(o.email, { state: "choose", calendarId: undefined, tokens: sealTokens({ access: "A", refresh: "R", expiresAt: Date.now() - 1000 }), choices: { ids: [CAL1], names: ["Marketing"], until: Date.now() + 600_000 } }));
    expect((await listRoute.GET()).status).toBe(502);
    expect(await getLink(o.email)).toMatchObject({ state: "reconnect", lostReason: "token" });
    expect(await lostNotices(o.email)).toHaveLength(1);
    // Found by a route, it is the owner's web action in the audit (R16); found by the sweep it is the cron's.
    expect((await auditOf(o.email)).filter((a) => a.action === "cal_lost")).toEqual([expect.objectContaining({ actor: "owner", via: "web" })]);
  });

  it("a 401 from the token endpoint (a wrong client secret) is a retry, not a loss (ruling R9)", async () => {
    fake({ refreshStatus: 401 });
    const o = await owner();
    await linked(o.email, o.email, { tokens: sealTokens({ access: "A", refresh: "R", expiresAt: Date.now() - 1000 }) });
    const now = Date.now();
    expect(await sweepCalendars(now, now + 60_000)).toMatchObject({ lost: 0, retried: 1 });
    expect(await getLink(o.email)).toMatchObject({ state: "ok" });
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBe(now + 900_000);
    expect(await lostNotices(o.email)).toHaveLength(0);
  });

  it("a 401 from the events call after a fresh token loses the link with token", async () => {
    fake({ eventsStatus: 401 });
    const o = await owner();
    await linked(o.email);
    expect(await sweep()).toMatchObject({ lost: 1 });
    expect(await getLink(o.email)).toMatchObject({ state: "reconnect", lostReason: "token" });
    expect(await lostNotices(o.email)).toHaveLength(1);
  });

  it("a 503 keeps the old events and reschedules; they are served at +44 minutes and not at +46 (45-minute stale rule)", async () => {
    const o = await owner();
    await linked(o.email);
    fake();
    const t0 = Date.now();
    expect(await sweepCalendars(t0, t0 + 60_000)).toMatchObject({ synced: 1 });
    fake({ eventsStatus: 503 });
    const t1 = t0 + CAL_SYNC_MS;
    expect(await sweepCalendars(t1, t1 + 60_000)).toMatchObject({ scopes: 1, synced: 0, retried: 1, lost: 0 });
    expect(await getLink(o.email)).toMatchObject({ state: "ok" });
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBe(t1 + 900_000);
    expect((await db.get<{ syncedAt: number }>(SEC_KEYS.calEvents(o.email)))!.syncedAt).toBe(t0);
    expect(await meetingsNow(o.email, t0 + 44 * 60_000)).toHaveLength(1);
    expect(await meetingsNow(o.email, t0 + 46 * 60_000)).toEqual([]);
  });

  it("Retry-After is honoured, floored at 60 s and capped at 3600 s; a 403 and a 429 are retries too", async () => {
    const o = await owner();
    const cases: [number, string | undefined, number][] = [[503, "99999", 3_600_000], [429, "0", 60_000], [503, "120", 120_000], [403, undefined, 900_000], [503, "5", 60_000]];
    for (const [status, ra, wantMs] of cases) {
      fake({ eventsStatus: status, retryAfter: ra });
      await linked(o.email);
      const now = Date.now();
      expect(await sweepCalendars(now, now + 60_000)).toMatchObject({ retried: 1, lost: 0 });
      expect(await db.zscore(SEC_KEYS.calDue, o.email), `${status} ${ra}`).toBe(now + wantMs);
      expect(await getLink(o.email)).toMatchObject({ state: "ok" });
    }
  });

  it("a 404 means the calendar is gone: reconnect with lostReason calendar and no notice", async () => {
    fake({ eventsStatus: 404 });
    const o = await owner();
    await linked(o.email);
    expect(await sweep()).toMatchObject({ lost: 1 });
    expect(await getLink(o.email)).toMatchObject({ state: "reconnect", lostReason: "calendar" });
    expect(await db.get(SEC_KEYS.calEvents(o.email))).toBeNull();
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBeNull();
    expect(await lostNotices(o.email)).toHaveLength(0);
    expect((await auditOf(o.email)).some((a) => a.action === "cal_lost" && a.diff === "provider=gcal")).toBe(true);
  });

  it("the website moves to another domain: a domain link is lost with domain, a declaration link still syncs", async () => {
    fake();
    const a = await owner();
    const b = await owner();
    await saveBrand(a.email, brandAt("https://brand.example"));
    await saveBrand(b.email, brandAt("https://brand.example"));
    await linked(a.email, a.email, { proof: "domain", declaration: undefined });
    await linked(b.email, b.email, { proof: "declaration" });
    expect(await sweep()).toMatchObject({ synced: 2, lost: 0 });
    await saveBrand(a.email, brandAt("https://other.example"));
    await saveBrand(b.email, brandAt("https://other.example"));
    await scheduleSync(a.email, Date.now() - 1000);
    await scheduleSync(b.email, Date.now() - 1000);
    expect(await sweep()).toMatchObject({ synced: 1, lost: 1 });
    expect(await getLink(a.email)).toMatchObject({ state: "reconnect", lostReason: "domain" });
    expect(await getLink(b.email)).toMatchObject({ state: "ok", proof: "declaration" });
    expect(await lostNotices(a.email)).toHaveLength(0);
  });

  it("R3: a Google refresh without an id_token keeps the stored domain; one that names another domain loses the link", async () => {
    const a = await owner();
    await saveBrand(a.email, brandAt("https://brand.example"));
    const expired = sealTokens({ access: "A", refresh: "R", expiresAt: Date.now() - 1000 });
    fake({});
    await linked(a.email, a.email, { proof: "domain", declaration: undefined, tokens: expired });
    expect(await sweep()).toMatchObject({ synced: 1, lost: 0 });
    expect(await getLink(a.email)).toMatchObject({ state: "ok", accountDomain: "brand.example" });
    fake({ refreshIdToken: idToken({ email: "o@other.example", email_verified: true, hd: "other.example" }) });
    await putLink(a.email, seed(a.email, { proof: "domain", declaration: undefined, tokens: expired }));
    await scheduleSync(a.email, Date.now() - 1000);
    expect(await sweep()).toMatchObject({ lost: 1 });
    expect(await getLink(a.email)).toMatchObject({ state: "reconnect", lostReason: "domain" });
  });

  it("R3: an Outlook domain link asks Graph again and is lost when the domain is no longer verified; a Graph failure is only a retry", async () => {
    const a = await owner();
    await saveBrand(a.email, brandAt("https://brand.example"));
    fake({ orgDomains: ["brand.example"] });
    await linked(a.email, a.email, { provider: "mscal", proof: "domain", declaration: undefined });
    expect(await sweep()).toMatchObject({ synced: 1 });
    expect(urls.some((u) => u.startsWith("https://graph.microsoft.com/v1.0/organization"))).toBe(true);
    fake({ orgDomains: ["somewhere.else"] });
    await scheduleSync(a.email, Date.now() - 1000);
    expect(await sweep()).toMatchObject({ lost: 1 });
    expect(await getLink(a.email)).toMatchObject({ state: "reconnect", lostReason: "domain" });
  });

  it("an archived brand: the link is deleted, it leaves the queue, and no provider call is made, never a revoke (ruling R7)", async () => {
    fake();
    const o = await owner();
    const now = new Date().toISOString();
    await saveBrands(o.email, [{ id: "default", name: "", createdAt: now, status: "active" }, { id: "old", name: "Old", createdAt: now, status: "archived" }]);
    const scope = scopeFor(o.email, "old");
    await linked(o.email, scope);
    await putEvents(scope, { syncedAt: Date.now(), events: [] });
    expect(await sweep()).toMatchObject({ scopes: 1, lost: 0, synced: 0 });
    expect(await getLink(scope)).toBeNull();
    expect(await db.get(SEC_KEYS.calEvents(scope))).toBeNull();
    expect(await db.zscore(SEC_KEYS.calDue, scope)).toBeNull();
    expect(urls.filter((u) => u.includes("/revoke"))).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("a brand that is not in the account's list is lost with brand; a suspended owner and a link by another login are lost with owner", async () => {
    fake();
    const a = await owner();
    const ghost = scopeFor(a.email, "ghost");
    await linked(a.email, ghost);
    const s = await owner();
    await saveUser({ ...(await getUser(s.email))!, suspended: true });
    await linked(s.email);
    const m = await owner();
    await linked(m.email, m.email, { login: "someone-else@test.example" });
    expect(await sweep()).toMatchObject({ scopes: 3, lost: 3, synced: 0 });
    expect(await getLink(ghost)).toMatchObject({ state: "reconnect", lostReason: "brand" });
    expect(await getLink(s.email)).toMatchObject({ state: "reconnect", lostReason: "owner" });
    expect(await getLink(m.email)).toMatchObject({ state: "reconnect", lostReason: "owner" });
    expect(urls).toEqual([]);
    expect(await lostNotices(s.email)).toHaveLength(0);
  });

  it("a scope with no link is taken out of the queue; a link not in state ok is never synced", async () => {
    fake();
    const a = await owner();
    await scheduleSync(a.email, Date.now() - 1000);
    const b = await owner();
    await linked(b.email, b.email, { state: "choose", calendarId: undefined });
    await sweep();
    expect(await db.zscore(SEC_KEYS.calDue, a.email)).toBeNull();
    expect(await db.zscore(SEC_KEYS.calDue, b.email)).toBeNull();
    expect(await getLink(b.email)).toMatchObject({ state: "choose" });
    expect(urls).toEqual([]);
  });

  it("sync with the link lock held defers and keeps tokens: the scope is rescheduled about 60 s out", async () => {
    fake();
    const o = await owner();
    await linked(o.email);
    const before = (await getLink(o.email))!;
    const held = await db.lockOwned(SEC_KEYS.lock(o.email, "callink"), 60);
    expect(held).not.toBeNull();
    const now = Date.now();
    expect(await sweepCalendars(now, now + 60_000)).toMatchObject({ scopes: 1, deferred: 1, synced: 0, lost: 0 });
    const due = (await db.zscore(SEC_KEYS.calDue, o.email))!;
    expect(due).toBeGreaterThanOrEqual(now + 59_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 61_000);
    expect(await getLink(o.email)).toEqual(before);
    expect(urls).toEqual([]);
  }, 20_000);

  it("R5: a link deleted while the events call is in flight is not brought back: nothing stored, not in the queue", async () => {
    const o = await owner();
    await linked(o.email);
    fake({ onEvents: async () => { await dropLink(o.email); } });
    const r = await sweep();
    expect(r.synced).toBe(0);
    expect(await getLink(o.email)).toBeNull();
    expect(await db.get(SEC_KEYS.calEvents(o.email))).toBeNull();
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBeNull();
  });

  it("R5: a link replaced while the events call is in flight (new rev) gets neither events nor a reschedule from the old run", async () => {
    const o = await owner();
    await linked(o.email);
    fake({ onEvents: async () => { await putLink(o.email, seed(o.email, { rev: 9, connectedAt: 5000 })); await db.zrem(SEC_KEYS.calDue, o.email); } });
    await sweep();
    expect(await getLink(o.email)).toMatchObject({ rev: 9, connectedAt: 5000 });
    expect(await db.get(SEC_KEYS.calEvents(o.email))).toBeNull();
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBeNull();
  });

  it("R5: a loss found after the events call does not bring a deleted link back either", async () => {
    const o = await owner();
    await linked(o.email);
    fake({ eventsStatus: 404, onEvents: async () => { await dropLink(o.email); } });
    expect((await sweep()).lost).toBe(0);
    expect(await getLink(o.email)).toBeNull();
  });

  it("a failure of one scope never stops the others", async () => {
    fake();
    const a = await owner();
    const b = await owner();
    await linked(a.email);
    await linked(b.email);
    const real = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation(((k: string) => (k === SEC_KEYS.calLink(a.email) ? Promise.reject(new Error("store down")) : real(k))) as typeof db.get);
    const now = Date.now();
    const r = await sweepCalendars(now, now + 60_000);
    expect(r.scopes).toBe(2);
    expect(r.synced).toBe(1);
    expect(r.retried).toBe(1);
    // R16: the scope that threw is looked at again in 15 minutes instead of heading the queue every tick.
    expect(await db.zscore(SEC_KEYS.calDue, a.email)).toBe(now + 900_000);
  });

  it("R16: a failed reschedule of the throwing scope is swallowed; the other scopes finish", async () => {
    fake();
    const a = await owner();
    const b = await owner();
    await linked(a.email);
    await linked(b.email);
    const real = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation(((k: string) => (k === SEC_KEYS.calLink(a.email) ? Promise.reject(new Error("store down")) : real(k))) as typeof db.get);
    const realAdd = db.zadd.bind(db);
    vi.spyOn(db, "zadd").mockImplementation(((k: string, score: number, member: string, opts?: { lt?: boolean }) => (member === a.email ? Promise.reject(new Error("store down")) : realAdd(k, score, member, opts))) as typeof db.zadd);
    const r = await sweep();
    expect(r).toMatchObject({ scopes: 2, synced: 1, retried: 1 });
  });

  it("R15: a password reset while the token refresh is in flight does not bring the link back: no link, not queued, no events", async () => {
    const o = await owner();
    await linked(o.email, o.email, { tokens: sealTokens({ access: "A", refresh: "R", expiresAt: Date.now() - 1000 }) });
    await putEvents(o.email, { syncedAt: Date.now(), events: [] });
    const realFetch = (fake(), globalThis.fetch);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://oauth2.googleapis.com/token") await revokeCalendarLinks(o.email);
      return realFetch(input, init);
    }));
    const r = await sweep();
    expect(r).toMatchObject({ scopes: 1, synced: 0, lost: 0 });
    expect(await getLink(o.email)).toBeNull();
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBeNull();
    expect(await db.get(SEC_KEYS.calEvents(o.email))).toBeNull();
    expect(eventUrls()).toEqual([]);
  }, 20_000);

  it("R15: the same for an account wipe while the refresh is in flight", async () => {
    const o = await owner();
    await linked(o.email, o.email, { tokens: sealTokens({ access: "A", refresh: "R", expiresAt: Date.now() - 1000 }) });
    const realFetch = (fake(), globalThis.fetch);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://oauth2.googleapis.com/token") await wipeAccount(o.email);
      return realFetch(input, init);
    }));
    await sweep();
    expect(await getLink(o.email)).toBeNull();
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBeNull();
    expect(await db.get(SEC_KEYS.calEvents(o.email))).toBeNull();
  }, 20_000);

  it("R15: freshAccess refuses to store tokens over a link replaced during the refresh", async () => {
    const o = await owner();
    await linked(o.email, o.email, { tokens: sealTokens({ access: "A", refresh: "R", expiresAt: Date.now() - 1000 }) });
    const realFetch = (fake(), globalThis.fetch);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://oauth2.googleapis.com/token") await putLink(o.email, seed(o.email, { rev: 9, connectedAt: 5000 }));
      return realFetch(input, init);
    }));
    await sweep();
    const now = await getLink(o.email);
    expect(now).toMatchObject({ rev: 9, connectedAt: 5000 });
    expect(eventUrls()).toEqual([]);
  });
});

describe("rule 921 (reset part): a password reset and an account wipe drop the owner's calendar links", () => {
  async function twoLinked() {
    const o = await owner();
    const now = new Date().toISOString();
    await saveBrands(o.email, [{ id: "default", name: "", createdAt: now, status: "active" }, { id: "b2", name: "Two", createdAt: now, status: "active" }, { id: "old", name: "Old", createdAt: now, status: "archived" }]);
    const scopes = [o.email, scopeFor(o.email, "b2"), scopeFor(o.email, "old")];
    await Promise.all(scopes.map(async (s) => { await putLink(s, seed(o.email)); await putEvents(s, { syncedAt: Date.now(), events: [] }); await scheduleSync(s, Date.now() + 1000); }));
    return { o, scopes };
  }
  const gone = async (scopes: string[]) => {
    for (const s of scopes) {
      expect(await getLink(s), s).toBeNull();
      expect(await db.get(SEC_KEYS.calEvents(s))).toBeNull();
      expect(await db.zscore(SEC_KEYS.calDue, s)).toBeNull();
    }
  };

  it("POST /api/auth/reset for the owner drops every brand's link, and no provider is called", async () => {
    fake();
    const { o, scopes } = await twoLinked();
    const other = await owner();
    await linked(other.email);
    const token = randomBytes(32).toString("hex");
    await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, { email: o.email, kind: "owner" });
    const res = await resetRoute.POST(json("/api/auth/reset", "POST", { token, password: "owner12345" }, { "x-real-ip": "198.18.9.1" }));
    expect(res.status).toBe(200);
    await gone(scopes);
    expect(await getLink(other.email)).not.toBeNull();
    expect(urls).toEqual([]);
  });

  it("a member's reset leaves the owner's links alone", async () => {
    const { o, scopes } = await twoLinked();
    const m = await newMember(o, "member");
    const token = randomBytes(32).toString("hex");
    await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, { email: m.email, kind: "member" });
    expect((await resetRoute.POST(json("/api/auth/reset", "POST", { token, password: "member12345" }, { "x-real-ip": "198.18.9.2" }))).status).toBe(200);
    for (const s of scopes) expect(await getLink(s)).not.toBeNull();
  });

  it("the founder's resetPassword does the same", async () => {
    fake();
    vi.stubEnv("ADMIN_EMAILS", FOUNDER);
    const { o, scopes } = await twoLinked();
    // The founder is a real, verified account signed in as themselves (email verification, rules 751-769).
    if (!(await getUser(FOUNDER))) await markVerified((await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "ar" })).email);
    await signIn(FOUNDER);
    const res = await adminUserRoute.POST(json("/api/admin/users/x", "POST", { action: "resetPassword" }), params({ email: encodeURIComponent(o.email) }));
    expect(res.status).toBe(200);
    await gone(scopes);
  });

  it("wipeAccount drops them", async () => {
    const { o, scopes } = await twoLinked();
    await wipeAccount(o.email);
    await gone(scopes);
  });

  it("revokeCalendarLinks does nothing for a member login or an unknown address, and never calls a provider", async () => {
    fake();
    const { o, scopes } = await twoLinked();
    const m = await newMember(o, "member");
    await revokeCalendarLinks(m.email);
    await revokeCalendarLinks("nobody@test.example");
    for (const s of scopes) expect(await getLink(s)).not.toBeNull();
    await revokeCalendarLinks(o.email);
    await gone(scopes);
    expect(urls).toEqual([]);
  });

  it("addBrand's brands are covered: a link on a brand added through the product is dropped too", async () => {
    const o = await owner();
    const b = await addBrand({ ...(await getUser(o.email))!, brandCap: 2 }, "Second");
    expect("error" in b).toBe(false);
    const scope = scopeFor(o.email, (b as BrandMeta).id);
    await putLink(scope, seed(o.email));
    await revokeCalendarLinks(o.email);
    expect(await getLink(scope)).toBeNull();
  });
});
