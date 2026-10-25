/**
 * Rules 4260-4279: Reem's Google Calendar read through Composio (src/lib/secretary-gcal-via.ts), next to the direct path.
 * Composio's client is replaced by a fake that records every call. Rule 4260: the catalog lists two read tools and no write
 * tool, the toolkit is pinned, and the path is off unless `gcal` is in COMPOSIO_PROVIDERS and its auth config is set. Rule 4261:
 * start is owner only and keeps the account in the server-side state. Rule 4262: the callback verifies the account, writes a
 * `choose` link with no tokens, and discards the account when nothing is stored. Rule 4263: the owner always declares (no
 * domain is proven). Rule 4264: a sync asks only the chosen calendar, with the fixed fields, and maps a refused grant to a
 * lost link and any other failure to a retry. Rule 4265: unlink, reconnect, archive and an account wipe release the
 * connected account at Composio. Rule 4266: every call names this workspace's own Composio user.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jar, json, newMember, newUser, params, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { acct, type User } from "@/lib/auth";
import { SEC_KEYS } from "@/lib/secretary";
import { addBrand, listBrands, saveBrands, scopeFor } from "@/lib/brands";
import { OAUTH_COOKIE, getConnection, saveState } from "@/lib/connectors/store";
import { TOOLKITS, PROVIDER_TOOLKITS } from "@/lib/connectors/composio-catalog";
import { TOOLKIT_VERSION, composioEnabled, composioRead, composioWrite, composioUserId, setComposioClientForTests, type ComposioClient } from "@/lib/connectors/composio";
import { getProvider, isAvailable } from "@/lib/connectors/registry";
import { getLink, meetingsNow, openAccount, openTokens, putLink, scheduleSync, type CalLink } from "@/lib/secretary-cal-link";
import { EVENT_FIELDS, fetchEventsVia, listCalendarsVia } from "@/lib/secretary-gcal-via";
import { connectCalendarVia, revokeCalendarLinks, sweepCalendars } from "@/lib/secretary-gcal";
import * as start from "@/app/api/connect/[provider]/start/route";
import * as callback from "@/app/api/connect/[provider]/callback/route";
import * as linkRoute from "@/app/api/secretary/calendar-link/route";
import * as listRoute from "@/app/api/secretary/calendar-link/calendars/route";

type Exec = { slug: string; userId: string; accountId: string; args: Record<string, unknown> };
type Answer = { data?: unknown; error?: string | null; successful: boolean } | (() => never);
let calls: { exec: Exec[]; link: { userId: string; auth: string; callbackUrl: string }[]; revoked: string[]; deleted: string[] };
let answers: Record<string, Answer>;
let owned: Record<string, string[]>;

const CAL1 = "calid-one@group.calendar.google.com";
const CAL2 = "calid-two@group.calendar.google.com";
const PROVIDER_TEXT = "SECRET-PROVIDER-TEXT";
const EXPIRED = "Error validating access token: Session has expired";
const HOUR = 3_600_000;
const ok = (data: unknown) => ({ successful: true, data });

function fake(over: Partial<ComposioClient["connectedAccounts"]> = {}): ComposioClient {
  return {
    connectedAccounts: {
      link: async (userId, auth, o) => { calls.link.push({ userId, auth, callbackUrl: o.callbackUrl }); return { id: "ca_cal", redirectUrl: "https://connect.composio.dev/link/lk_cal" }; },
      waitForConnection: async (id) => ({ id, status: "ACTIVE" }),
      list: async (q) => ({ items: (owned[q.userIds[0]] ?? []).map((id) => ({ id })) }),
      revoke: async (id) => { calls.revoked.push(id); },
      delete: async (id) => { calls.deleted.push(id); },
      ...over,
    },
    tools: {
      execute: async (slug, body) => {
        calls.exec.push({ slug, userId: body.userId, accountId: body.connectedAccountId, args: body.arguments });
        const a = answers[slug];
        if (typeof a === "function") return a();
        return a ?? { successful: false, error: "not mocked" };
      },
    },
    files: { upload: async () => ({}) },
  };
}

beforeEach(async () => {
  calls = { exec: [], link: [], revoked: [], deleted: [] };
  answers = {};
  owned = {};
  vi.stubEnv("COMPOSIO_API_KEY", "test-key");
  vi.stubEnv("COMPOSIO_PROVIDERS", "gcal");
  vi.stubEnv("COMPOSIO_AUTH_GOOGLECALENDAR", "ac_gcal");
  vi.stubEnv("GOOGLE_CLIENT_ID", "");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
  setComposioClientForTests(fake());
  // The queue is global: what an earlier test left due must not be taken by this one.
  await db.del(SEC_KEYS.calDue);
});
afterEach(() => { setComposioClientForTests(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ctx = (provider: string) => params({ provider });
const where = (res: Response) => new URL(res.headers.get("location")!);
const startReq = (provider: string) => new Request(`https://app.test/api/connect/${provider}/start`);
const auditOf = async (scope: string) => (await db.lrange(SEC_KEYS.audit(scope), 0, -1)).map((x) => JSON.parse(x) as { action: string; diff: string });
const failure = (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error("expected a failure"); }, (e: Error) => e);
const sweep = () => sweepCalendars(Date.now(), Date.now() + 60_000);

const CALENDARS = ok({ items: [{ id: CAL1, summary: "Marketing", accessRole: "owner" }, { id: "shared-x", summary: "Someone's", accessRole: "reader" }, { id: "o@brand.example", summary: "o@brand.example", accessRole: "owner", primary: true }, { id: CAL2, summary: "Campaigns", accessRole: "owner" }] });
const EVENTS = (at = Date.now() + HOUR) => ok({ items: [{ summary: "Launch review", start: { dateTime: new Date(at).toISOString() }, end: { dateTime: new Date(at + HOUR).toISOString() } }] });
const chosen = (calendarId = CAL2): Partial<CalLink> => ({ state: "ok", proof: "declaration", calendarId, calendarName: "Campaigns", declaration: { by: "x", at: new Date().toISOString(), v: 1 }, choices: undefined });

/** A Composio link as the callback writes it (through `connectCalendarVia`), then `over`. */
async function seedVia(u: User, over: Partial<CalLink> = {}, id = "ca_cal", scope = acct(u)): Promise<string> {
  answers.GOOGLECALENDAR_LIST_CALENDARS = CALENDARS;
  expect(await connectCalendarVia(scope, u.email, id, 1000)).toEqual({ ok: true });
  await putLink(scope, { ...(await getLink(scope))!, ...over });
  calls.exec = [];
  calls.revoked = [];
  calls.deleted = [];
  return scope;
}

/** Finish a Composio flow as the browser would: the state the start wrote, the cookie, the callback with no code. */
async function finish(u: User, accountId = "ca_cal", query = "", toolkit = "googlecalendar", as = u.email) {
  const s = `st-${Math.random().toString(16).slice(2)}`;
  await saveState(s, { email: acct(u), provider: "gcal", lang: "en", shop: "", verifier: "", actor: u.email, via: "composio", toolkit, accountId });
  await signIn(as);
  jar().set(OAUTH_COOKIE, s);
  return where(await callback.GET(new Request(`https://app.test/api/connect/gcal/callback?state=${s}${query}`), ctx("gcal")));
}

describe("rule 4260: what Composio may do for the calendar", () => {
  it("lists two read tools and no write tool, and a write or an unlisted argument is refused before any call", async () => {
    const t = TOOLKITS.googlecalendar;
    expect(Object.keys(t.read).sort()).toEqual(["GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_LIST_CALENDARS"]);
    expect(t.write).toEqual({});
    expect(t.provider).toBe("gcal");
    expect(t.authEnv).toBe("COMPOSIO_AUTH_GOOGLECALENDAR");
    expect(PROVIDER_TOOLKITS.gcal).toEqual(["googlecalendar"]);
    await expect(composioWrite("s", "googlecalendar", "GOOGLECALENDAR_CREATE_EVENT", { summary: "x" }, "ca")).rejects.toThrow("composio_tool_not_allowed");
    await expect(composioWrite("s", "googlecalendar", "GOOGLECALENDAR_EVENTS_LIST", {}, "ca")).rejects.toThrow("composio_tool_not_allowed");
    await expect(composioRead("s", "googlecalendar", "GOOGLECALENDAR_DELETE_EVENT", { eventId: "e" }, "ca")).rejects.toThrow("composio_tool_not_allowed");
    await expect(composioRead("s", "googlecalendar", "GOOGLECALENDAR_EVENTS_LIST", { calendarId: "c", description: "x" }, "ca")).rejects.toThrow("composio_argument_not_allowed");
    expect(calls.exec).toEqual([]);
  });

  it("is pinned to a toolkit version", () => {
    expect(TOOLKIT_VERSION.googlecalendar).toMatch(/^\d{8}_\d{2}$/);
  });

  it("is off unless gcal is listed and the auth config is set; the direct Google path is unchanged", () => {
    expect(composioEnabled("gcal")).toBe(true);
    expect(isAvailable(getProvider("gcal")!)).toBe(true);
    vi.stubEnv("COMPOSIO_AUTH_GOOGLECALENDAR", "");
    expect(isAvailable(getProvider("gcal")!), "no auth config, no Connect button").toBe(false);
    vi.stubEnv("COMPOSIO_AUTH_GOOGLECALENDAR", "ac_gcal");
    vi.stubEnv("COMPOSIO_PROVIDERS", "meta");
    expect(isAvailable(getProvider("gcal")!)).toBe(false);
    vi.stubEnv("GOOGLE_CLIENT_ID", "gid");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "gsecret");
    expect(isAvailable(getProvider("gcal")!), "the direct app still works on its own").toBe(true);
  });

  it("is named in the env table", () => {
    expect(readFileSync(join(process.cwd(), "docs/system/variables.md"), "utf8")).toContain("COMPOSIO_AUTH_GOOGLECALENDAR");
  });
});

describe("rule 4261: start is the owner's alone and keeps the account on the server", () => {
  it("sends the owner to Composio and refuses an admin and a member with 403", async () => {
    const owner = await newUser("gcvstart");
    const admin = await newMember(owner, "admin");
    const member = await newMember(owner, "member");
    await signIn(owner.email);
    const res = await start.GET(startReq("gcal"), ctx("gcal"));
    expect(res.status).toBe(307);
    expect(where(res).host).toBe("connect.composio.dev");
    expect(calls.link[0]).toMatchObject({ userId: composioUserId(acct(owner)), auth: "ac_gcal" });
    const state = jar().get(OAUTH_COOKIE)!;
    expect(calls.link[0].callbackUrl).toContain(`/api/connect/gcal/callback?state=${state}`);
    expect(await db.get(`oauthstate:${state}`)).toMatchObject({ via: "composio", toolkit: "googlecalendar", accountId: "ca_cal", provider: "gcal" });
    await signIn(admin.email);
    expect((await start.GET(startReq("gcal"), ctx("gcal"))).status).toBe(403);
    await signIn(member.email);
    expect((await start.GET(startReq("gcal"), ctx("gcal"))).status).toBe(403);
    expect(calls.link).toHaveLength(1);
  });

  it("without the Composio switch the start goes to Google's own consent screen", async () => {
    vi.stubEnv("COMPOSIO_PROVIDERS", "");
    vi.stubEnv("GOOGLE_CLIENT_ID", "gid");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "gsecret");
    const owner = await newUser("gcvdirect");
    await signIn(owner.email);
    const res = await start.GET(startReq("gcal"), ctx("gcal"));
    expect(where(res).host).toBe("accounts.google.com");
    expect(calls.link).toEqual([]);
  });

  it("a Composio failure at start goes back to the Todo card with a code, not to Connections", async () => {
    setComposioClientForTests(fake({ link: async () => { throw new Error("boom"); } }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = await newUser("gcvfail");
    await signIn(owner.email);
    const res = await start.GET(startReq("gcal"), ctx("gcal"));
    expect(where(res).pathname).toMatch(/\/todo$/);
    expect(where(res).searchParams.get("cal_error")).toBe("provider_error");
  });
});

describe("rule 4262: the callback stores a choose link with no tokens, or discards the account", () => {
  it("writes the link in state choose with the sealed account id and the primary calendar as the account", async () => {
    const o = await newUser("gcvcb");
    owned[composioUserId(acct(o))] = ["ca_cal"];
    answers.GOOGLECALENDAR_LIST_CALENDARS = CALENDARS;
    const to = await finish(o, "ca_cal", "&connected_account_id=ca_evil");
    expect(to.pathname).toMatch(/\/todo$/);
    expect(to.searchParams.get("cal")).toBe("choose");
    const link = (await getLink(acct(o)))!;
    expect(link).toMatchObject({ provider: "gcal", via: "composio", state: "choose", account: "o@brand.example", login: o.email, tokens: "", proof: null });
    expect(openAccount(link)).toBe("ca_cal");
    expect(openTokens(link)).toBeNull();
    expect(link.cid).not.toContain("ca_cal");
    expect(calls.exec.map((e) => e.accountId), "the query never names the account").toEqual(["ca_cal"]);
    expect(calls.deleted).toEqual([]);
    expect(await getConnection(acct(o), "gcal"), "a calendar is never a publishing connection").toBeNull();
    const log = await auditOf(acct(o));
    expect(log.find((l) => l.action === "cal_link")).toMatchObject({ diff: "provider=gcal via=composio" });
    expect(JSON.stringify(log)).not.toContain("ca_cal");
  });

  it("an account that is not this workspace's is deleted and nothing is stored", async () => {
    const o = await newUser("gcvother");
    owned[composioUserId(acct(o))] = ["ca_other"];
    const to = await finish(o, "ca_cal");
    expect(to.searchParams.get("cal_error")).toBe("token_failed");
    expect(calls.deleted).toContain("ca_cal");
    expect(await getLink(acct(o))).toBeNull();
  });

  it("a failed calendar list, an archived brand and a toolkit of another provider store nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const o = await newUser("gcvarch");
    owned[composioUserId(acct(o))] = ["ca_cal"];
    answers.GOOGLECALENDAR_LIST_CALENDARS = { successful: false, error: PROVIDER_TEXT };
    const to = await finish(o);
    expect(to.searchParams.get("cal_error")).toBe("provider_error");
    expect(to.toString()).not.toContain(PROVIDER_TEXT);
    expect(calls.deleted).toContain("ca_cal");
    expect(await getLink(acct(o))).toBeNull();

    calls.deleted = [];
    answers.GOOGLECALENDAR_LIST_CALENDARS = CALENDARS;
    const b = (await addBrand({ ...o, brandCap: 2 }, "Gone")) as { id: string };
    const gone = scopeFor(acct(o), b.id);
    owned[composioUserId(gone)] = ["ca_cal"];
    await saveState("s-arch", { email: gone, provider: "gcal", lang: "en", shop: "", verifier: "", actor: o.email, via: "composio", toolkit: "googlecalendar", accountId: "ca_cal" });
    await signIn(o.email);
    jar().set(OAUTH_COOKIE, "s-arch");
    await saveBrands(acct(o), (await listBrands(acct(o))).map((r) => (r.id === b.id ? { ...r, status: "archived" as const } : r)));
    const res = where(await callback.GET(new Request("https://app.test/api/connect/gcal/callback?state=s-arch"), ctx("gcal")));
    expect(res.searchParams.get("cal_error")).toBe("brand_inactive");
    expect(calls.deleted).toContain("ca_cal");
    expect(await getLink(gone)).toBeNull();

    expect((await finish(o, "ca_cal", "", "facebook")).searchParams.get("cal_error")).toBe("invalid_state");
  });

  it("another person than the one who started the flow cannot finish it", async () => {
    const o = await newUser("gcvmis");
    const admin = await newMember(o, "admin");
    owned[composioUserId(acct(o))] = ["ca_cal"];
    answers.GOOGLECALENDAR_LIST_CALENDARS = CALENDARS;
    const to = await finish(o, "ca_cal", "", "googlecalendar", admin.email);
    expect(to.searchParams.get("cal_error")).toBeTruthy();
    expect(to.searchParams.get("cal")).toBeNull();
    expect(await getLink(acct(o))).toBeNull();
  });
});

describe("rule 4263: the calendars, the choice and the owner's declaration", () => {
  it("lists only calendars the account owns, cut to a name and an id, the primary marked", async () => {
    answers.GOOGLECALENDAR_LIST_CALENDARS = ok({ items: [{ id: CAL1, summary: "Mar\u0000keting\n", accessRole: "owner" }, { id: "x", summary: "Shared", accessRole: "writer" }, { id: "", summary: "No id", accessRole: "owner" }, { id: "p@brand.example", summary: "P", primary: true, accessRole: "owner", secret: "KEEP-OUT" }] });
    const r = await listCalendarsVia("s", "ca_cal");
    expect(r).toEqual([{ id: CAL1, name: "Mar keting", primary: false }, { id: "p@brand.example", name: "P", primary: true }]);
    expect(calls.exec[0].args).toEqual({ min_access_role: "owner", max_results: 50 });
    answers.GOOGLECALENDAR_LIST_CALENDARS = { successful: false, error: EXPIRED };
    expect(await failure(listCalendarsVia("s", "ca_cal"))).toMatchObject({ status: 401 });
    answers.GOOGLECALENDAR_LIST_CALENDARS = { successful: false, error: "Internal error upstream" };
    expect(await failure(listCalendarsVia("s", "ca_cal"))).toMatchObject({ status: 502 });
  });

  it("GET lists the owned calendars and stores the choices; PUT refuses a choice without declare, then saves it with the declaration", async () => {
    const o = await newUser("gcvchoose");
    await signIn(o.email);
    const scope = await seedVia(o);
    answers.GOOGLECALENDAR_LIST_CALENDARS = CALENDARS;
    const list = await listRoute.GET();
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { calendars: { choice: number; name: string }[] };
    expect(listed.calendars.map((c) => c.name)).toEqual(["Marketing", "o@brand.example", "Campaigns"]);
    expect(JSON.stringify(listed)).not.toContain(CAL1);
    const stored = (await getLink(scope))!;
    expect(stored.choices!.ids).toEqual([CAL1, "o@brand.example", CAL2]);

    const noDeclare = await linkRoute.PUT(json("/api/secretary/calendar-link", "PUT", { choice: 0, rev: stored.rev }));
    expect(noDeclare.status).toBe(400);
    expect(((await noDeclare.json()) as { error: string }).error).toBe("declaration_required");

    const saved = await linkRoute.PUT(json("/api/secretary/calendar-link", "PUT", { choice: 2, declare: true, rev: stored.rev }));
    expect(saved.status).toBe(200);
    const after = (await getLink(scope))!;
    expect(after).toMatchObject({ state: "ok", proof: "declaration", calendarId: CAL2, calendarName: "Campaigns", via: "composio", tokens: "" });
    expect(after.declaration).toMatchObject({ by: o.email });
    expect(after.accountDomain ?? null).toBeNull();
    expect(openAccount(after)).toBe("ca_cal");
    expect(await db.zscore(SEC_KEYS.calDue, scope)).not.toBeNull();
  });

  it("a refused grant while listing ends the link safely", async () => {
    const o = await newUser("gcvlost");
    await signIn(o.email);
    const scope = await seedVia(o);
    answers.GOOGLECALENDAR_LIST_CALENDARS = { successful: false, error: EXPIRED };
    const res = await listRoute.GET();
    expect(res.status).toBe(502);
    expect((await getLink(scope))!.state).toBe("reconnect");
  });
});

describe("rule 4264: the sync reads the chosen calendar only", () => {
  it("asks one calendar with the fixed fields and the window, and the meetings come out", async () => {
    const o = await newUser("gcvsync");
    const scope = await seedVia(o, chosen());
    await scheduleSync(scope, Date.now() - 1000);
    answers.GOOGLECALENDAR_EVENTS_LIST = EVENTS();
    expect(await sweep()).toMatchObject({ scopes: 1, synced: 1 });
    expect(calls.exec).toHaveLength(1);
    const a = calls.exec[0];
    expect(a).toMatchObject({ slug: "GOOGLECALENDAR_EVENTS_LIST", accountId: "ca_cal", userId: composioUserId(scope) });
    expect(a.args).toMatchObject({ calendarId: CAL2, singleEvents: true, orderBy: "startTime", fields: EVENT_FIELDS });
    expect(Date.parse(String(a.args.timeMax)) - Date.parse(String(a.args.timeMin))).toBeGreaterThan(6 * 24 * HOUR);
    expect(String(a.args.fields)).not.toMatch(/description|location|hangout|conference|displayName|email/);
    expect((await meetingsNow(scope, Date.now())).map((m) => m.title)).toEqual(["Launch review"]);
  });

  it("any other failure keeps the link and retries; a refused grant loses it once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const o = await newUser("gcvfailsync");
    const scope = await seedVia(o, chosen());
    await scheduleSync(scope, Date.now() - 1000);
    answers.GOOGLECALENDAR_EVENTS_LIST = { successful: false, error: PROVIDER_TEXT };
    expect(await sweep()).toMatchObject({ retried: 1, lost: 0 });
    expect((await getLink(scope))!.state).toBe("ok");

    await scheduleSync(scope, Date.now() - 1000);
    answers.GOOGLECALENDAR_EVENTS_LIST = { successful: false, error: EXPIRED };
    expect(await sweep()).toMatchObject({ lost: 1 });
    expect((await getLink(scope))!.state).toBe("reconnect");
  });

  it("fetchEventsVia without a chosen calendar is gone, without a readable account is auth, and logs no provider text", async () => {
    const o = await newUser("gcvfetch");
    const scope = await seedVia(o, chosen());
    const link = (await getLink(scope))!;
    expect(await fetchEventsVia(scope, { ...link, calendarId: undefined }, 0, 1)).toEqual({ ok: false, kind: "gone" });
    expect(await fetchEventsVia(scope, { ...link, cid: "garbage" }, 0, 1)).toEqual({ ok: false, kind: "auth" });
    answers.GOOGLECALENDAR_EVENTS_LIST = ok({ nothing: true });
    expect(await fetchEventsVia(scope, link, 0, 1)).toEqual({ ok: false, kind: "retry" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    answers.GOOGLECALENDAR_EVENTS_LIST = { successful: false, error: PROVIDER_TEXT };
    expect(await fetchEventsVia(scope, link, 0, 1)).toEqual({ ok: false, kind: "retry" });
    expect(JSON.stringify([...log.mock.calls, ...out.mock.calls])).not.toContain(PROVIDER_TEXT);
  });
});

describe("rule 4265: the connected account ends with the link", () => {
  it("DELETE (unlink) revokes and deletes the account at Composio", async () => {
    const o = await newUser("gcvunlink");
    await signIn(o.email);
    const scope = await seedVia(o);
    expect((await linkRoute.DELETE()).status).toBe(200);
    expect(await getLink(scope)).toBeNull();
    expect(calls.revoked).toEqual(["ca_cal"]);
    expect(calls.deleted).toEqual(["ca_cal"]);
  });

  it("a failing revoke never keeps the link alive", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const o = await newUser("gcvrevfail");
    await signIn(o.email);
    const scope = await seedVia(o);
    setComposioClientForTests(fake({ revoke: async () => { throw new Error("down"); } }));
    expect((await linkRoute.DELETE()).status).toBe(200);
    expect(await getLink(scope)).toBeNull();
  });

  it("a reconnect releases the earlier account, and a direct link is dropped with no Composio call", async () => {
    const o = await newUser("gcvreconn");
    const scope = await seedVia(o, {}, "ca_old");
    answers.GOOGLECALENDAR_LIST_CALENDARS = CALENDARS;
    expect(await connectCalendarVia(scope, o.email, "ca_new", 2000)).toEqual({ ok: true });
    expect(calls.revoked).toEqual(["ca_old"]);
    expect(openAccount((await getLink(scope))!)).toBe("ca_new");

    calls.revoked = [];
    await putLink(scope, { v: 1, provider: "gcal", login: o.email, account: "o@brand.example", proof: null, tokens: "x", state: "ok", connectedAt: 1, rev: 1 });
    await revokeCalendarLinks(acct(o));
    expect(await getLink(scope)).toBeNull();
    expect(calls.revoked).toEqual([]);
  });

  it("an archived brand and an account wipe release the account", async () => {
    const o = await newUser("gcvwipe");
    const b = (await addBrand({ ...o, brandCap: 2 }, "Old")) as { id: string };
    const scope = scopeFor(acct(o), b.id);
    await seedVia(o, chosen(CAL1), "ca_cal", scope);
    await scheduleSync(scope, Date.now() - 1000);
    await saveBrands(acct(o), (await listBrands(acct(o))).map((r) => (r.id === b.id ? { ...r, status: "archived" as const } : r)));
    await sweep();
    expect(await getLink(scope)).toBeNull();
    expect(calls.revoked).toEqual(["ca_cal"]);

    const w = await newUser("gcvwipe2");
    const ws = await seedVia(w);
    await revokeCalendarLinks(acct(w));
    expect(await getLink(ws)).toBeNull();
    expect(calls.revoked).toEqual(["ca_cal"]);
  });
});

describe("rule 4266: tenant isolation of the Composio account", () => {
  it("every call names this workspace's opaque Composio user and the link's own account", async () => {
    const a = await newUser("gcviso-a");
    const b = await newUser("gcviso-b");
    const sa = await seedVia(a, chosen(CAL1), "ca_a");
    const sb = await seedVia(b, chosen(CAL1), "ca_b");
    await scheduleSync(sa, Date.now() - 1000);
    await scheduleSync(sb, Date.now() - 1000);
    answers.GOOGLECALENDAR_EVENTS_LIST = EVENTS();
    await sweep();
    const byAccount = Object.fromEntries(calls.exec.map((e) => [e.accountId, e.userId]));
    expect(byAccount).toEqual({ ca_a: composioUserId(sa), ca_b: composioUserId(sb) });
    expect(composioUserId(sa)).not.toBe(composioUserId(sb));
  });
});
