import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { RefreshBusy, getFreshConnection, refreshDue, refreshLeadMs } from "@/lib/connectors/fresh";
import { keepTokensAlive } from "@/lib/connectors/keepalive";
import { refreshTokens } from "@/lib/connectors/oauth";
import { PROVIDERS, getProvider } from "@/lib/connectors/registry";
import { db } from "@/lib/db";

/**
 * Rules 2210-2213 (docs/system/tests/2210-zid-refresh-lead.md). Zid's docs (Authorization, read 2026-10-18) give the
 * manager token and the refresh token one year each and advise refreshing about ten months in. A refresh five minutes
 * before the access token lapses could find the refresh token gone with it, so Zid's tokens are refreshed 60 days early.
 */

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();
const zid = (over: Partial<Connection> = {}): Connection => ({ provider: "zid", data: { access_token: "old-mgr", authorization: "old-auth", refresh_token: "old-refresh" }, meta: { storeId: "77" }, connectedAt: "2025-12-01T00:00:00Z", expiresAt: inDays(30), ...over });
const lockOf = (scope: string) => `connlock:${scope}:zid`;

let bodies: string[] = [];
function fakeZid(opts: { status?: number } = {}) {
  bodies = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: URLSearchParams }) => {
    const body = String(init?.body ?? "");
    bodies.push(body);
    if (!String(url).startsWith("https://oauth.zid.sa/oauth/token")) return new Response("{}", { status: 404 });
    if (body.includes("refresh_token=refused")) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    if (opts.status) return new Response("{}", { status: opts.status });
    return Response.json({ access_token: "new-mgr", Authorization: "new-auth", refresh_token: "new-refresh", expires_in: 31536000 });
  }));
}

describe("Zid's tokens are refreshed 60 days before they lapse (rules 2210-2213)", () => {
  beforeEach(() => {
    vi.stubEnv("ZID_CLIENT_ID", "test-zid-id");
    vi.stubEnv("ZID_CLIENT_SECRET", "test-zid-secret");
    vi.stubEnv("SALLA_CLIENT_ID", "test-salla-id");
    vi.stubEnv("SALLA_CLIENT_SECRET", "test-salla-secret");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("2210: only Zid declares a lead time, 60 days from its docs; every other provider keeps five minutes", () => {
    expect(PROVIDERS.filter((p) => p.oauth?.refreshLeadDays).map((p) => [p.id, p.oauth?.refreshLeadDays])).toEqual([["zid", 60]]);
    expect(refreshLeadMs("zid")).toBe(60 * DAY);
    for (const id of ["x", "salla", "shopify", "linkedin", "unknown"]) expect(refreshLeadMs(id)).toBe(5 * 60_000);
    expect(refreshDue(zid({ expiresAt: inDays(59) }))).toBe(true);
    expect(refreshDue(zid({ expiresAt: inDays(61) }))).toBe(false);
    expect(refreshDue(zid({ expiresAt: undefined }))).toBe(false);
    expect(refreshDue({ ...zid(), provider: "x", expiresAt: inDays(30) })).toBe(false);
    expect(refreshDue({ ...zid(), provider: "x", expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
  });

  it("2210: a Zid token inside its lead time is refreshed on use and both new tokens are saved for another year", async () => {
    fakeZid();
    const u = await newUser("zidlead");
    await saveConnection(u.email, zid());
    const c = await getFreshConnection(u.email, "zid");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("grant_type=refresh_token");
    expect(bodies[0]).toContain("refresh_token=old-refresh");
    expect(c?.data.access_token).toBe("new-mgr");
    expect(c?.data.refresh_token).toBe("new-refresh");
    expect(Date.parse(c!.expiresAt!) - Date.now()).toBeGreaterThan(364 * DAY);
    expect((await getConnection(u.email, "zid"))?.data.access_token).toBe("new-mgr");
  });

  it("2210: a Zid token outside the lead time and an X token 30 days out are not refreshed", async () => {
    fakeZid();
    const [a, b] = await Promise.all([newUser("zidfar"), newUser("xfar")]);
    await Promise.all([
      saveConnection(a.email, zid({ expiresAt: inDays(61) })),
      saveConnection(b.email, { provider: "x", data: { access_token: "x-old", refresh_token: "x-refresh" }, connectedAt: "2026-09-01T00:00:00Z", expiresAt: inDays(30) }),
    ]);
    expect((await getFreshConnection(a.email, "zid"))?.data.access_token).toBe("old-mgr");
    expect((await getFreshConnection(b.email, "x"))?.data.access_token).toBe("x-old");
    expect(bodies).toHaveLength(0);
  });

  it("2211: inside the lead time a busy lock returns the working token, never refreshes and leaves the holder's lock", async () => {
    fakeZid();
    const u = await newUser("zidbusy");
    await saveConnection(u.email, zid());
    const holder = await db.lockOwned(lockOf(u.email), 30);
    expect(holder).toBeTruthy();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const p = getFreshConnection(u.email, "zid");
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p)?.data.access_token).toBe("old-mgr");
    expect(bodies).toHaveLength(0);
    expect(await db.lockOwned(lockOf(u.email), 30)).toBeNull();
    await db.unlockOwned(lockOf(u.email), holder!);
  });

  it("2211: in the last five minutes rule 2192 holds for Zid too: a busy lock is RefreshBusy", async () => {
    fakeZid();
    const u = await newUser("zidurgent");
    await saveConnection(u.email, zid({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const holder = await db.lockOwned(lockOf(u.email), 30);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const p = getFreshConnection(u.email, "zid");
    const done = expect(p).rejects.toBeInstanceOf(RefreshBusy);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(bodies).toHaveLength(0);
    await db.unlockOwned(lockOf(u.email), holder!);
  });

  it("2211: inside the lead time a passing failure keeps the connection unmarked; a refused refresh token marks it", async () => {
    const [passing, refusedU, noRefresh] = await Promise.all([newUser("zid500"), newUser("zid400"), newUser("zidnoref")]);
    await Promise.all([
      saveConnection(passing.email, zid()),
      saveConnection(refusedU.email, zid({ data: { access_token: "old-mgr", authorization: "old-auth", refresh_token: "refused" } })),
      saveConnection(noRefresh.email, zid({ data: { access_token: "old-mgr", authorization: "old-auth" } })),
    ]);
    fakeZid({ status: 503 });
    expect((await getFreshConnection(passing.email, "zid"))?.data.access_token).toBe("old-mgr");
    expect((await getConnection(passing.email, "zid"))?.needsReconnect).toBeUndefined();
    await expect(getFreshConnection(refusedU.email, "zid")).rejects.toThrow("reconnect_required");
    expect((await getConnection(refusedU.email, "zid"))?.needsReconnect).toBeTruthy();
    expect((await getFreshConnection(noRefresh.email, "zid"))?.data.access_token).toBe("old-mgr");
    expect((await getConnection(noRefresh.email, "zid"))?.needsReconnect).toBeUndefined();
  });

  it("2211: an expired Zid token whose refresh fails is still marked, as before", async () => {
    fakeZid({ status: 503 });
    const u = await newUser("zidexpired500");
    await saveConnection(u.email, zid({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    await expect(getFreshConnection(u.email, "zid")).rejects.toThrow("reconnect_required");
    expect((await getConnection(u.email, "zid"))?.needsReconnect).toBeTruthy();
  });

  it("2212: the keep-alive picks Zid connections inside the lead time and counts only a refreshed one as refreshed", async () => {
    const [due, far, failing] = await Promise.all([newUser("kazid"), newUser("kazidfar"), newUser("kazidfail")]);
    await Promise.all([
      saveConnection(due.email, zid()),
      saveConnection(far.email, zid({ expiresAt: inDays(61) })),
    ]);
    fakeZid();
    expect(await keepTokensAlive([due.email, far.email])).toEqual({ due: 1, refreshed: 1, lost: 0, failed: 0 });
    expect((await getConnection(due.email, "zid"))?.data.refresh_token).toBe("new-refresh");
    expect((await getConnection(far.email, "zid"))?.data.refresh_token).toBe("old-refresh");
    await saveConnection(failing.email, zid());
    fakeZid({ status: 503 });
    expect(await keepTokensAlive([failing.email])).toEqual({ due: 1, refreshed: 0, lost: 0, failed: 1 });
    expect((await getConnection(failing.email, "zid"))?.needsReconnect).toBeUndefined();
  });

  it("2212: the keep-alive reads the lead time through refreshDue, not its own expiry test", () => {
    const src = readFileSync("src/lib/connectors/keepalive.ts", "utf8");
    expect(src).toContain("refreshDue(c, now)");
    expect(src).toContain("!!o?.refreshLeadDays");
    expect(src).not.toMatch(/Date\.parse\(c\.expiresAt\)/);
  });

  it("2213: Zid's refresh sends redirect_uri as its docs list; other providers' refreshes do not", async () => {
    fakeZid();
    await refreshTokens(getProvider("zid")!, "rt");
    expect(bodies[0]).toMatch(/redirect_uri=[^&]*%2Fapi%2Fconnect%2Fzid%2Fcallback/);
    expect(bodies[0]).toContain("client_id=test-zid-id");
    bodies = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: URLSearchParams }) => {
      bodies.push(String(init?.body ?? ""));
      return Response.json({ access_token: "a", refresh_token: "b", expires: 1209599 });
    }));
    await refreshTokens(getProvider("salla")!, "rt");
    expect(bodies[0]).not.toContain("redirect_uri");
  });
});
