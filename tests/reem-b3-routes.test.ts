/**
 * Reem B3, the calendar-link routes (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §4, §5 and §7). Rule 912: a
 * choose re-runs the proof (a refresh, the provider's proof when it gave one, the live list of owned calendars), picks only from
 * the stored choices, and needs the owner's declaration unless the provider proved the brand's domain. Rule 920: no answer
 * carries a token, a calendar id, the declaration login or the string `tokens`; the routes are owner only and rate limited,
 * take the scope from the session, and refuse a body field they do not know. Rule 921 (unlink part): DELETE drops the link,
 * its events and its place in the sync queue, audits `cal_unlink`, and never calls a provider's revoke endpoint (ruling R7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { SEC_KEYS } from "@/lib/secretary";
import { addBrand, setActiveBrand } from "@/lib/brands";
import { saveBrand, type Brand } from "@/lib/brand";
import { getLink, openTokens, putEvents, putLink, scheduleSync, sealTokens, type CalLink } from "@/lib/secretary-cal-link";
import * as link from "@/app/api/secretary/calendar-link/route";
import { freshAccess } from "@/lib/secretary-gcal";
import * as calendars from "@/app/api/secretary/calendar-link/calendars/route";
import * as start from "@/app/api/connect/[provider]/start/route";

const ENV = { GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "msecret" };
const PROVIDER_TEXT = "SECRET-PROVIDER-TEXT";
const ACCESS = "ACCESS-TOKEN-VALUE";
const REFRESH = "REFRESH-TOKEN-VALUE";
const DECLARER = "declarer-marker@marker.test";
const CAL1 = "calid-one-SECRET@group.calendar.google.com";
const CAL2 = "calid-two-SECRET@group.calendar.google.com";

const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

type Fake = {
  /** What the token endpoint answers on a refresh: a status to fail with, or the fields of a good answer. */
  refreshStatus?: number;
  refreshBody?: string;
  refreshIdToken?: string | null;
  newRefresh?: string | null;
  /** The calendars the provider lists as the account's. */
  owned?: { id: string; name: string }[];
  notOwned?: { id: string; name: string }[];
  listStatus?: number;
  tid?: string;
  orgDomains?: string[];
  upn?: string;
  /** Runs inside the stubbed calendar-list call, before it answers: a slow provider during which the brand changes. */
  onList?: () => Promise<void>;
};
let calls: { url: string; method: string; body: string }[] = [];
function fakeProviders(o: Fake = {}) {
  calls = [];
  const owned = o.owned ?? [{ id: CAL1, name: "Marketing" }, { id: CAL2, name: "Campaigns" }];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url === "https://oauth2.googleapis.com/token" || url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
      if (o.refreshStatus) return new Response(o.refreshBody ?? PROVIDER_TEXT, { status: o.refreshStatus });
      const t: Record<string, unknown> = { access_token: "NEW-ACCESS", expires_in: 3599 };
      if (o.newRefresh) t.refresh_token = o.newRefresh;
      if (o.refreshIdToken) t.id_token = o.refreshIdToken;
      return Response.json(t);
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList")) {
      await o.onList?.();
      if (o.listStatus) return new Response(PROVIDER_TEXT, { status: o.listStatus });
      return Response.json({ items: [...owned.map((c) => ({ id: c.id, summary: c.name, accessRole: "owner" })), ...(o.notOwned ?? [{ id: "shared-x", name: "Someone else's" }]).map((c) => ({ id: c.id, summary: c.name, accessRole: "reader" }))] });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/calendars")) {
      await o.onList?.();
      if (o.listStatus) return new Response(PROVIDER_TEXT, { status: o.listStatus });
      return Response.json({
        value: [
          ...owned.map((c) => ({ id: c.id, name: c.name, canEdit: true, owner: { address: "O@Brand.Example" } })),
          { id: "shared-y", name: "Shared to me", canEdit: true, owner: { address: "boss@else.example" } },
          { id: "view-z", name: "Read only", canEdit: false, owner: { address: "o@brand.example" } },
        ],
      });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return Response.json({ userPrincipalName: o.upn ?? "o@brand.example", mail: "o@brand.example" });
    if (url.startsWith("https://graph.microsoft.com/v1.0/organization")) return Response.json({ value: [{ verifiedDomains: (o.orgDomains ?? ["brand.example"]).map((name) => ({ name })) }] });
    return new Response("not mocked", { status: 500 });
  }));
}

beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const NOW = () => Date.now();
const seed = (login: string, over: Partial<CalLink> = {}): CalLink => ({
  v: 1,
  provider: "gcal",
  login,
  account: "o@brand.example",
  accountDomain: "brand.example",
  proof: null,
  tokens: sealTokens({ access: ACCESS, refresh: REFRESH, expiresAt: NOW() + 3_600_000 }),
  state: "choose",
  choices: { ids: [CAL1, CAL2], names: ["Marketing", "Campaigns"], until: NOW() + 600_000 },
  connectedAt: 1,
  rev: 1,
  ...over,
});
const brand = (website: string) => ({ name: "B", website } as Brand);
const get = () => link.GET();
const put = (body: unknown) => link.PUT(json("/api/secretary/calendar-link", "PUT", body));
const del = () => link.DELETE();
const list = () => calendars.GET();
const auditOf = async (scope: string) => (await db.lrange(SEC_KEYS.audit(scope), 0, -1)).map((x) => JSON.parse(x) as { action: string; actor: string; login?: string; diff: string });
const body = async (res: Response) => (await res.json()) as Record<string, unknown> & { error?: string; link?: Record<string, unknown> | null; calendars?: { choice: number; name: string }[] };

async function owner(prefix = "calrt") {
  const o = await newUser(prefix);
  await signIn(o.email);
  return o;
}

describe("rule 912: choosing the calendar needs proof or the owner's declaration", () => {
  it("a Gmail link refuses a choice without declare, and nothing is saved", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email, { accountDomain: undefined, account: "shop@gmail.com" }));
    const res = await put({ choice: 0, rev: 1 });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe("declaration_required");
    const stored = (await getLink(o.email))!;
    expect(stored).toMatchObject({ state: "choose", rev: 1 });
    expect(stored.calendarId).toBeUndefined();
    expect(stored.choices).toBeDefined();
  });

  it("declare: true saves proof declaration with the owner's login and the text version, state ok, rev + 1, choices cleared, sync due now", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email, { accountDomain: undefined, account: "shop@gmail.com" }));
    await putEvents(o.email, { syncedAt: 1, events: [{ start: "2026-10-05T10:00:00Z", end: "2026-10-05T11:00:00Z", title: "old calendar's", allDay: false }] });
    const before = Date.now();
    const res = await put({ choice: 1, declare: true, rev: 1 });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.link).toMatchObject({ provider: "gcal", account: "shop@gmail.com", calendarName: "Campaigns", proof: "declaration", state: "ok", rev: 2 });
    const stored = (await getLink(o.email))!;
    expect(stored).toMatchObject({ state: "ok", proof: "declaration", calendarId: CAL2, calendarName: "Campaigns", rev: 2 });
    expect(stored.declaration).toMatchObject({ by: o.email, v: 1 });
    expect(Number.isNaN(Date.parse(stored.declaration!.at))).toBe(false);
    expect(stored.choices).toBeUndefined();
    expect(stored.lostReason).toBeUndefined();
    const due = await db.zscore(SEC_KEYS.calDue, o.email);
    expect(due).not.toBeNull();
    expect(due!).toBeGreaterThanOrEqual(before);
    expect(due!).toBeLessThanOrEqual(Date.now());
    // The earlier calendar's events must not be served as the new calendar's.
    expect(await db.get(SEC_KEYS.calEvents(o.email))).toBeNull();
    const log = await auditOf(o.email);
    expect(log.find((l) => l.action === "cal_choose")).toMatchObject({ actor: "owner", login: o.email, diff: "provider=gcal" });
    expect(JSON.stringify(log)).not.toContain("shop@gmail.com");
    expect(JSON.stringify(log)).not.toContain(CAL2);
  });

  it("a choice outside the stored choices, or not an index, is 400 bad_request", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email));
    for (const choice of [2, 99, -1, 0.5, "0", null, undefined, true]) {
      const res = await put({ choice, declare: true, rev: 1 });
      expect(res.status, JSON.stringify(choice)).toBe(400);
      expect((await body(res)).error).toBe("bad_request");
    }
    expect((await put({ choice: 0, declare: "yes", rev: 1 })).status).toBe(400);
    expect((await put({ choice: 0, declare: false, rev: 1 })).status).toBe(400);
    expect((await put({ choice: 0, declare: true, rev: "1" })).status).toBe(400);
    expect((await put({ choice: 0, declare: true })).status).toBe(400);
    expect((await getLink(o.email))!.rev).toBe(1);
  });

  it("choices older than 10 minutes, or none, are 409 choices_expired", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email, { choices: { ids: [CAL1], names: ["Marketing"], until: NOW() - 1 } }));
    const res = await put({ choice: 0, declare: true, rev: 1 });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("choices_expired");
    await putLink(o.email, seed(o.email, { choices: undefined }));
    const res2 = await put({ choice: 0, declare: true, rev: 1 });
    expect(res2.status).toBe(409);
    expect((await body(res2)).error).toBe("choices_expired");
    expect(calls.length).toBe(0);
  });

  it("a calendar the live list no longer shows as owned is 400 not_owned", async () => {
    fakeProviders({ owned: [{ id: CAL2, name: "Campaigns" }] });
    const o = await owner();
    await putLink(o.email, seed(o.email));
    const res = await put({ choice: 0, declare: true, rev: 1 });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe("not_owned");
    expect(await getLink(o.email)).toMatchObject({ state: "choose", rev: 1 });
  });

  it("a second choice of another calendar asks for the declaration again; the stale rev is 409 stale", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email, { accountDomain: undefined, account: "shop@gmail.com" }));
    expect((await put({ choice: 0, declare: true, rev: 1 })).status).toBe(200);
    expect((await list()).status).toBe(200);
    const stale = await put({ choice: 1, declare: true, rev: 1 });
    expect(stale.status).toBe(409);
    expect((await body(stale)).error).toBe("stale");
    const again = await put({ choice: 1, rev: 2 });
    expect(again.status).toBe(400);
    expect((await body(again)).error).toBe("declaration_required");
    expect(await getLink(o.email)).toMatchObject({ calendarId: CAL1, rev: 2 });
    expect((await put({ choice: 1, declare: true, rev: 2 })).status).toBe(200);
    expect(await getLink(o.email)).toMatchObject({ calendarId: CAL2, rev: 3 });
  });

  it("the provider's hd matching the brand's website is proof domain with no declaration, and none is stored", async () => {
    fakeProviders();
    const o = await owner();
    await saveBrand(o.email, brand("https://www.shop.brand.example/"));
    await putLink(o.email, seed(o.email));
    const res = await put({ choice: 0, rev: 1 });
    expect(res.status).toBe(200);
    expect((await body(res)).link).toMatchObject({ proof: "domain", state: "ok" });
    const stored = (await getLink(o.email))!;
    expect(stored.proof).toBe("domain");
    expect(stored.declaration).toBeUndefined();
  });

  it("an hd that does not match the website still needs the declaration", async () => {
    fakeProviders();
    const o = await owner();
    await saveBrand(o.email, brand("https://other.example"));
    await putLink(o.email, seed(o.email));
    expect((await body(await put({ choice: 0, rev: 1 }))).error).toBe("declaration_required");
  });

  it("a Google refresh with no id_token keeps the stored domain: an hd link stays proof domain, a Gmail link still demands a declaration (ruling R3)", async () => {
    fakeProviders({ newRefresh: null, refreshIdToken: null });
    const o = await owner();
    await saveBrand(o.email, brand("https://brand.example"));
    const expired = sealTokens({ access: "OLD", refresh: REFRESH, expiresAt: NOW() - 1000 });
    await putLink(o.email, seed(o.email, { tokens: expired }));
    const res = await put({ choice: 0, rev: 1 });
    expect(res.status).toBe(200);
    expect((await body(res)).link).toMatchObject({ proof: "domain" });
    expect(calls.filter((c) => c.url.endsWith("/token")).length).toBe(1);
    // The refreshed access is stored, the refresh token the answer did not carry is kept.
    expect(openTokens((await getLink(o.email))!)).toMatchObject({ access: "NEW-ACCESS", refresh: REFRESH });

    const g = await owner("calrt");
    await saveBrand(g.email, brand("https://brand.example"));
    await putLink(g.email, seed(g.email, { account: "shop@gmail.com", accountDomain: undefined, tokens: expired }));
    const res2 = await put({ choice: 0, rev: 1 });
    expect(res2.status).toBe(400);
    expect((await body(res2)).error).toBe("declaration_required");
  });

  it("a Google refresh that does return an id_token is re-proved: an hd that no longer matches drops proof domain; a rotated refresh token is stored", async () => {
    fakeProviders({ refreshIdToken: idToken({ email: "o@brand.example", email_verified: true, hd: "moved.example" }), newRefresh: "ROTATED" });
    const o = await owner();
    await saveBrand(o.email, brand("https://brand.example"));
    await putLink(o.email, seed(o.email, { tokens: sealTokens({ access: "OLD", refresh: REFRESH, expiresAt: NOW() + 60_000 }) }));
    expect((await body(await put({ choice: 0, rev: 1 }))).error).toBe("declaration_required");
    expect(openTokens((await getLink(o.email))!)).toMatchObject({ access: "NEW-ACCESS", refresh: "ROTATED" });
    const res = await put({ choice: 0, declare: true, rev: 1 });
    expect(res.status).toBe(200);
    expect(await getLink(o.email)).toMatchObject({ proof: "declaration", accountDomain: "moved.example" });
  });

  it("Outlook: a work tenant re-proves through Graph every save, even with no refresh; a consumer account needs the declaration; only owned, editable calendars count", async () => {
    fakeProviders();
    const o = await owner();
    await saveBrand(o.email, brand("https://brand.example"));
    await putLink(o.email, seed(o.email, { provider: "mscal", choices: { ids: [CAL1, CAL2], names: ["Marketing", "Campaigns"], until: NOW() + 600_000 } }));
    const res = await put({ choice: 1, rev: 1 });
    expect(res.status).toBe(200);
    expect((await body(res)).link).toMatchObject({ provider: "mscal", proof: "domain", calendarName: "Campaigns" });
    expect(calls.some((c) => c.url.startsWith("https://graph.microsoft.com/v1.0/organization"))).toBe(true);
    expect((await list()).status).toBe(200);
    const names = ((await getLink(o.email))!.choices!).names;
    expect(names).toEqual(["Marketing", "Campaigns"]);

    // The organization stops listing the domain: the stored work-tenant claim is not trusted.
    fakeProviders({ orgDomains: ["unrelated.example"] });
    const p = await owner("calrt");
    await saveBrand(p.email, brand("https://brand.example"));
    await putLink(p.email, seed(p.email, { provider: "mscal" }));
    expect((await body(await put({ choice: 0, rev: 1 }))).error).toBe("declaration_required");

    // A personal Microsoft account never had a domain.
    fakeProviders();
    const c = await owner("calrt");
    await saveBrand(c.email, brand("https://brand.example"));
    await putLink(c.email, seed(c.email, { provider: "mscal", accountDomain: undefined }));
    expect((await body(await put({ choice: 0, rev: 1 }))).error).toBe("declaration_required");
    expect(calls.some((x) => x.url.startsWith("https://graph.microsoft.com/v1.0/organization"))).toBe(false);
  });

  it("a refresh the provider refuses with invalid_grant marks the link reconnect and shows no provider text; another failure is a plain provider_error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeProviders({ refreshStatus: 400, refreshBody: `{"error":"invalid_grant","error_description":"${PROVIDER_TEXT}"}` });
    const o = await owner();
    await putLink(o.email, seed(o.email, { tokens: sealTokens({ access: "OLD", refresh: REFRESH, expiresAt: NOW() - 1000 }) }));
    await putEvents(o.email, { syncedAt: Date.now(), events: [] });
    const res = await put({ choice: 0, declare: true, rev: 1 });
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("provider_error");
    expect(text).not.toContain(PROVIDER_TEXT);
    expect(await getLink(o.email)).toMatchObject({ state: "reconnect", lostReason: "token" });
    expect(await db.get(SEC_KEYS.calEvents(o.email))).toBeNull();
    expect((await auditOf(o.email)).find((l) => l.action === "cal_lost")).toMatchObject({ login: o.email, diff: "provider=gcal" });

    fakeProviders({ refreshStatus: 503 });
    const p = await owner("calrt");
    await putLink(p.email, seed(p.email, { tokens: sealTokens({ access: "OLD", refresh: REFRESH, expiresAt: NOW() - 1000 }) }));
    const res2 = await put({ choice: 0, declare: true, rev: 1 });
    expect(res2.status).toBe(502);
    expect(await getLink(p.email)).toMatchObject({ state: "choose" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(PROVIDER_TEXT);
  });

  it("a link in state reconnect, or no link, is 404 not_linked for the list and the choice", async () => {
    fakeProviders();
    const o = await owner();
    expect((await put({ choice: 0, declare: true, rev: 1 })).status).toBe(404);
    expect((await list()).status).toBe(404);
    await putLink(o.email, seed(o.email, { state: "reconnect", lostReason: "token" }));
    const res = await put({ choice: 0, declare: true, rev: 1 });
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe("not_linked");
    expect((await list()).status).toBe(404);
    expect(calls.length).toBe(0);
  });
});

describe("rule 912 (ruling R8): the calendar lock is owned, and a slow choose cannot undo a change made while it ran", () => {
  it("a busy calendar lock is 503 provider_error on the choice, the list and the unlink, and nothing is touched", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email));
    expect(await db.lock(SEC_KEYS.lock(o.email, "callink"), 60)).toBe(true);
    const all = await Promise.all([put({ choice: 0, declare: true, rev: 1 }), list(), del()]);
    expect(all.map((r) => r.status)).toEqual([503, 503, 503]);
    for (const r of all) expect((await body(r)).error).toBe("provider_error");
    expect(await getLink(o.email)).toMatchObject({ state: "choose", rev: 1 });
    expect(calls.length).toBe(0);
  });

  it("an unlink that lands while a choose waits on the provider wins: 409 stale and nothing is written back", async () => {
    const o = await owner();
    await putLink(o.email, seed(o.email));
    await scheduleSync(o.email, 0);
    await db.zrem(SEC_KEYS.calDue, o.email);
    fakeProviders({ onList: async () => { await db.del(SEC_KEYS.calLink(o.email)); } });
    const res = await put({ choice: 0, declare: true, rev: 1 });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("stale");
    expect(await getLink(o.email)).toBeNull();
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBeNull();
    expect((await auditOf(o.email)).some((l) => l.action === "cal_choose")).toBe(false);
  });

  it("a rev that moved while a choose waited on the provider is 409 stale and the newer record stays", async () => {
    const o = await owner();
    await putLink(o.email, seed(o.email));
    fakeProviders({ onList: async () => { await putLink(o.email, { ...(await getLink(o.email))!, rev: 5 }); } });
    const res = await put({ choice: 0, declare: true, rev: 1 });
    expect(res.status).toBe(409);
    const stored = (await getLink(o.email))!;
    expect(stored).toMatchObject({ rev: 5, state: "choose" });
    expect(stored.calendarId).toBeUndefined();
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBeNull();
    expect((await auditOf(o.email)).some((l) => l.action === "cal_choose")).toBe(false);
  });

  it("a refresh slower than 8 s is retry (nothing written), not a hang", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
      const o = await newUser("calslow");
      const l = seed(o.email, { tokens: sealTokens({ access: "OLD", refresh: REFRESH, expiresAt: NOW() - 1000 }) });
      await putLink(o.email, l);
      const p = freshAccess(o.email, l, NOW());
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await p).toEqual({ ok: false, retry: true });
      expect(await getLink(o.email)).toEqual(l);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("rule 912 (ruling R9): only invalid_grant, or a 401 from the calendar list, marks the link lost", () => {
  const expired = () => sealTokens({ access: "OLD", refresh: REFRESH, expiresAt: NOW() - 1000 });

  it("a 401 from the token endpoint (a wrong client secret) is provider_error and the link stays ok", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeProviders({ refreshStatus: 401 });
    const o = await owner();
    await putLink(o.email, seed(o.email, { state: "ok", proof: "domain", calendarId: CAL1, tokens: expired() }));
    await putEvents(o.email, { syncedAt: Date.now(), events: [] });
    const res = await put({ choice: 0, declare: true, rev: 1 });
    expect(res.status).toBe(502);
    expect((await list()).status).toBe(502);
    expect(await getLink(o.email)).toMatchObject({ state: "ok", rev: 1 });
    expect(await db.get(SEC_KEYS.calEvents(o.email))).not.toBeNull();
    expect((await auditOf(o.email)).some((l) => l.action === "cal_lost")).toBe(false);
  });

  it("a 401 from the calendar list after a fresh refresh marks the link reconnect, on the choice and on the list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeProviders({ listStatus: 401 });
    const o = await owner();
    await putLink(o.email, seed(o.email, { tokens: expired() }));
    const res = await put({ choice: 0, declare: true, rev: 1 });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(PROVIDER_TEXT);
    expect(await getLink(o.email)).toMatchObject({ state: "reconnect", lostReason: "token" });
    expect((await auditOf(o.email)).find((l) => l.action === "cal_lost")).toMatchObject({ login: o.email, diff: "provider=gcal" });

    const p = await owner("calrt");
    await putLink(p.email, seed(p.email, { state: "ok", proof: "domain", calendarId: CAL1, choices: undefined, tokens: expired() }));
    const res2 = await list();
    expect(res2.status).toBe(502);
    expect(await getLink(p.email)).toMatchObject({ state: "reconnect", lostReason: "token" });
  });

  it("another list failure (500) is provider_error and the link is unchanged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeProviders({ listStatus: 500 });
    const o = await owner();
    await putLink(o.email, seed(o.email));
    expect((await put({ choice: 0, declare: true, rev: 1 })).status).toBe(502);
    expect(await getLink(o.email)).toMatchObject({ state: "choose", rev: 1 });
  });
});

describe("rule 920 (ruling R10): a founder's support session cannot link, choose or unlink", () => {
  it("is 403 on PUT, DELETE and the start of the Google flow, and changes nothing", async () => {
    const FOUNDER = "founder-cal@test.example";
    vi.stubEnv("ADMIN_EMAILS", FOUNDER);
    fakeProviders();
    const o = await newUser("calimp");
    await putLink(o.email, seed(o.email));
    await signIn(o.email, { imp: FOUNDER });
    const p = await put({ choice: 0, declare: true, rev: 1 });
    expect(p.status).toBe(403);
    expect(await p.json()).toEqual({ error: "forbidden" });
    expect((await del()).status).toBe(403);
    expect((await get()).status).toBe(403);
    expect((await list()).status).toBe(403);
    const s = await start.GET(new Request("https://app.test/api/connect/gcal/start"), params({ provider: "gcal" }));
    expect(s.status).toBe(403);
    expect(await getLink(o.email)).toMatchObject({ state: "choose", rev: 1 });
    expect(calls.length).toBe(0);
  });
});

describe("rule 912: GET calendars lists the owned calendars live and keeps the ids on the server", () => {
  it("stores the ids and names for 10 minutes, answers indexes and names, and says whether a declaration is needed", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email, { choices: undefined }));
    const before = Date.now();
    const res = await list();
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b).toEqual({ ok: true, calendars: [{ choice: 0, name: "Marketing" }, { choice: 1, name: "Campaigns" }], needsDeclaration: true });
    const url = calls.find((c) => c.url.includes("calendarList"))!.url;
    expect(url).toContain("minAccessRole=owner");
    expect(url).toContain("maxResults=50");
    const stored = (await getLink(o.email))!;
    expect(stored.choices!.ids).toEqual([CAL1, CAL2]);
    expect(stored.choices!.names).toEqual(["Marketing", "Campaigns"]);
    expect(stored.choices!.until).toBeGreaterThanOrEqual(before + 600_000);
    expect(stored.choices!.until).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(stored.rev).toBe(1);
  });

  it("needsDeclaration is false for a proven domain, and an account with no owned calendars gets an empty list", async () => {
    fakeProviders();
    const o = await owner();
    await saveBrand(o.email, brand("https://brand.example"));
    await putLink(o.email, seed(o.email, { choices: undefined }));
    expect((await body(await list())).needsDeclaration).toBe(false);
    fakeProviders({ owned: [] });
    const res = await list();
    expect(await body(res)).toEqual({ ok: true, calendars: [], needsDeclaration: false });
    expect((await getLink(o.email))!.choices!.ids).toEqual([]);
  });

  it("keeps at most 50, and a provider failure is 502 with no provider text", async () => {
    fakeProviders({ owned: Array.from({ length: 70 }, (_, i) => ({ id: `id${i}`, name: `Cal ${i}` })) });
    const o = await owner();
    await putLink(o.email, seed(o.email, { choices: undefined }));
    expect((await body(await list())).calendars!.length).toBe(50);
    fakeProviders({ listStatus: 500 });
    const res = await list();
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(PROVIDER_TEXT);
  });
});

describe("rule 920: the answers carry nothing secret; the routes are owner only, rate limited and scoped by the session", () => {
  it("no answer holds a token, a calendar id, the declaration login or the word tokens", async () => {
    fakeProviders();
    const o = await owner();
    await saveBrand(o.email, brand("https://brand.example"));
    const declared = seed(o.email, { state: "ok", proof: "declaration", declaration: { by: DECLARER, at: "2026-10-05T10:00:00.000Z", v: 1 }, calendarId: CAL1, calendarName: "Marketing", rev: 4, lastSyncAt: Date.now() });
    await putLink(o.email, declared);
    const answers = [await get(), await list(), await put({ choice: 0, declare: true, rev: 4 })];
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    answers.push(await del());
    expect(answers[3].status).toBe(200);
    for (const r of answers) {
      const t = JSON.stringify(await r.json());
      for (const bad of [ACCESS, REFRESH, "NEW-ACCESS", CAL1, CAL2, DECLARER, "tokens", "calendarId"]) expect(t, bad).not.toContain(bad);
    }
  });

  it("GET gives the link without a secret, with today's kept meetings as local HH:mm and the private one shown as busy", async () => {
    fakeProviders();
    const o = await owner();
    const now = Date.now();
    await putLink(o.email, seed(o.email, { state: "ok", proof: "domain", calendarId: CAL1, calendarName: "Marketing", choices: undefined, rev: 3, lastSyncAt: now - 60_000 }));
    // Riyadh, the default zone, is UTC+3: 09:00Z is 12:00 and 07:00Z is 10:00 local.
    const day = new Date(now + 3 * 3_600_000).toISOString().slice(0, 10);
    await putEvents(o.email, { syncedAt: now, events: [
      { start: `${day}T09:00:00.000Z`, end: `${day}T09:30:00.000Z`, title: "Standup", allDay: false },
      { start: `${day}T07:00:00.000Z`, end: `${day}T08:00:00.000Z`, title: "", allDay: false, private: true },
    ] });
    const b = await body(await get());
    expect(b.ok).toBe(true);
    expect(b.link).toEqual({ provider: "gcal", account: "o@brand.example", calendarName: "Marketing", proof: "domain", state: "ok", rev: 3, lastSyncAt: now - 60_000, today: [{ start: "10:00", end: "11:00", title: "مشغول" }, { start: "12:00", end: "12:30", title: "Standup" }] });
  });

  it("GET with no link is link: null; stale events show nothing", async () => {
    fakeProviders();
    const o = await owner();
    expect(await body(await get())).toEqual({ ok: true, link: null });
    await putLink(o.email, seed(o.email, { state: "ok", proof: "domain", calendarId: CAL1, choices: undefined }));
    await putEvents(o.email, { syncedAt: Date.now() - 46 * 60_000, events: [{ start: new Date(Date.now() - 60_000).toISOString(), end: new Date(Date.now() + 3_600_000).toISOString(), title: "Old", allDay: false }] });
    expect(((await body(await get())).link as { today: unknown[] }).today).toEqual([]);
  });

  it("the calendars answer gives the indexes 0..n-1 and names only", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email, { choices: undefined }));
    const b = await body(await list());
    expect(b.calendars!.map((c) => c.choice)).toEqual([0, 1]);
    expect(Object.keys(b.calendars![0]).sort()).toEqual(["choice", "name"]);
  });

  it("an admin, a member and an anonymous caller are refused on all four", async () => {
    fakeProviders();
    const o = await newUser("calrole");
    const admin = await newMember(o, "admin");
    const member = await newMember(o, "member");
    await putLink(o.email, seed(o.email));
    const all = () => [get(), list(), put({ choice: 0, declare: true, rev: 1 }), del()];
    await signIn(admin.email);
    expect((await Promise.all(all())).map((r) => r.status)).toEqual([403, 403, 403, 403]);
    await signIn(member.email);
    expect((await Promise.all(all())).map((r) => r.status)).toEqual([403, 403, 403, 403]);
    signOut();
    expect((await Promise.all(all())).map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(await getLink(o.email)).toMatchObject({ state: "choose", rev: 1 });
    expect(calls.length).toBe(0);
  });

  it("a body field the route does not know, scope or email included, is 400 bad_request", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email));
    const other = await newUser("calother");
    for (const extra of [{ scope: other.email }, { email: other.email }, { calendarId: CAL1 }, { choices: [] }]) {
      const res = await put({ choice: 0, declare: true, rev: 1, ...extra });
      expect(res.status).toBe(400);
      expect((await body(res)).error).toBe("bad_request");
    }
    expect((await link.PUT(new Request("https://nashr.test/api/secretary/calendar-link", { method: "PUT", body: "not json" }))).status).toBe(400);
    expect((await put([0])).status).toBe(400);
    expect(await getLink(o.email)).toMatchObject({ state: "choose", rev: 1 });
    expect(await getLink(other.email)).toBeNull();
  });

  it("the 121st read in the hour is 429, the 31st list is 429, the 31st write (PUT or DELETE) is 429", async () => {
    fakeProviders();
    await owner();
    for (let i = 0; i < 120; i++) expect((await get()).status).toBe(200);
    const over = await get();
    expect(over.status).toBe(429);
    expect((await body(over)).error).toBe("too_many");

    const l = await owner("callist");
    await putLink(l.email, seed(l.email, { choices: undefined }));
    for (let i = 0; i < 30; i++) expect((await list()).status).toBe(200);
    expect((await list()).status).toBe(429);

    await owner("calwrite");
    for (let i = 0; i < 15; i++) expect((await put({ choice: 0, rev: 1 })).status).toBe(404);
    for (let i = 0; i < 15; i++) expect((await del()).status).toBe(404);
    expect((await put({ choice: 0, rev: 1 })).status).toBe(429);
    expect((await del()).status).toBe(429);
  });

  it("another brand's link is not visible, listable, choosable or removable after switching brand", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email, { state: "ok", proof: "domain", calendarId: CAL1, choices: undefined }));
    const b = (await addBrand(o, "Second")) as { id: string };
    await setActiveBrand(o.email, b.id);
    expect(await body(await get())).toEqual({ ok: true, link: null });
    expect((await list()).status).toBe(404);
    expect((await put({ choice: 0, declare: true, rev: 1 })).status).toBe(404);
    expect((await del()).status).toBe(404);
    expect(await getLink(o.email)).toMatchObject({ state: "ok", calendarId: CAL1 });
    await setActiveBrand(o.email, "default");
    expect(((await body(await get())).link as { state: string }).state).toBe("ok");
  });
});

describe("rule 921 (unlink part): DELETE drops our side only and never calls a provider's revoke endpoint", () => {
  it("removes the link, the events and the due member, audits cal_unlink, and makes no provider call", async () => {
    fakeProviders();
    const o = await owner();
    await putLink(o.email, seed(o.email, { state: "ok", proof: "declaration", declaration: { by: o.email, at: "2026-10-05T10:00:00.000Z", v: 1 }, calendarId: CAL1, choices: undefined }));
    await putEvents(o.email, { syncedAt: Date.now(), events: [{ start: "2026-10-05T10:00:00Z", end: "2026-10-05T11:00:00Z", title: "x", allDay: false }] });
    await scheduleSync(o.email, Date.now() + 1000);
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await getLink(o.email)).toBeNull();
    expect(await db.get(SEC_KEYS.calEvents(o.email))).toBeNull();
    expect(await db.zscore(SEC_KEYS.calDue, o.email)).toBeNull();
    expect((await auditOf(o.email)).find((l) => l.action === "cal_unlink")).toMatchObject({ actor: "owner", login: o.email, diff: "provider=gcal" });
    expect(calls.some((c) => c.url.includes("/revoke"))).toBe(false);
    expect(calls.some((c) => c.body.includes(REFRESH))).toBe(false);
    expect(calls.length).toBe(0);
    expect((await del()).status).toBe(404);
  });
});
