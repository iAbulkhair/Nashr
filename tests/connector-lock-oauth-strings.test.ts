import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, newUser, params, signIn, signOut } from "./helpers/session";
import { sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { deleteConnection, getConnection, saveConnection, saveState, takeState, type Connection } from "@/lib/connectors/store";
import { ConnectionBusy, getFreshConnection, withConnectionLock } from "@/lib/connectors/fresh";
import { issueCode, registerClient } from "@/lib/oauth";
import * as connRoute from "@/app/api/connect/[provider]/route";
import * as token from "@/app/api/oauth/token/route";

/**
 * Rule 2931: a disconnect and a new connection take the connection lock the token refresh takes (rule 2192), and the
 * refresh reads the record again under the lock and before its save, so it never brings a deleted connection back and
 * never writes the old grant's tokens over a new connection. The OAuth state is taken with one GETDEL.
 * Rule 2932: POST /api/oauth/token answers a JSON body with non-string fields with OAuth's 400, never a 500.
 */

const read = (p: string) => readFileSync(p, "utf8");
const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();
const OLD_AT = "2025-12-01T00:00:00.000Z";
const NEW_AT = "2026-10-22T00:00:00.000Z";
const zid = (over: Partial<Connection> = {}): Connection => ({ provider: "zid", data: { access_token: "old-mgr", authorization: "old-auth", refresh_token: "old-refresh" }, meta: { storeId: "77" }, connectedAt: OLD_AT, expiresAt: inDays(30), ...over });
const lockOf = (scope: string) => `connlock:${scope}:zid`;

/** Zid's token URL; `during` runs while the refresh is in flight, under the refresher's lock. */
function fakeZid(during: () => Promise<void>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!String(url).startsWith("https://oauth.zid.sa/oauth/token")) return new Response("{}", { status: 404 });
    await during();
    return Response.json({ access_token: "refreshed-mgr", Authorization: "refreshed-auth", refresh_token: "refreshed-refresh", expires_in: 31536000 });
  }));
}

describe("connection lock: disconnect and reconnect never race the token refresh (rule 2931)", () => {
  beforeEach(() => {
    vi.stubEnv("ZID_CLIENT_ID", "test-zid-id");
    vi.stubEnv("ZID_CLIENT_SECRET", "test-zid-secret");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    signOut();
  });

  it("2931: the refresh has no fallback to the record read before the lock, and reads again before its save", () => {
    const src = read("src/lib/connectors/fresh.ts");
    expect(src).not.toMatch(/getConnection\(scope, provider\)\)\s*\?\?\s*c\b/);
    expect(src).not.toMatch(/refresh_token\s*\?\?\s*c\.data\.refresh_token/);
    const body = src.slice(src.indexOf("export async function getFreshConnection"), src.indexOf("export async function refusedToken"));
    const reread = body.indexOf("const again = await getConnection(scope, provider)");
    expect(reread).toBeGreaterThan(body.indexOf("refreshTokens("));
    expect(reread).toBeLessThan(body.indexOf("await saveConnection(scope, next)"));
    expect(body).toMatch(/again\.connectedAt !== cur\.connectedAt/);
    // One lock name for the refresh, the disconnect and the new connection.
    expect(src).toMatch(/const connLock = \(scope: string, provider: string\) => `connlock:\$\{scope\}:\$\{provider\}`/);
    const helper = src.slice(src.indexOf("export async function withConnectionLock"), src.indexOf("export async function getFreshConnection"));
    expect(helper).toMatch(/db\.lockOwned\(lock, LOCK_S\)/);
    expect(helper).toMatch(/finally \{\s*await db\.unlockOwned\(lock, token\)/);
  });

  it("2931: DELETE and both callback saves run under withConnectionLock; a held lock is 409 busy", () => {
    const route = read("src/app/api/connect/[provider]/route.ts");
    const del = route.slice(route.indexOf("export async function DELETE"), route.indexOf("const ACTION_ROLE"));
    expect(del.indexOf("withConnectionLock(sc(u), provider")).toBeGreaterThan(-1);
    expect(del.indexOf("withConnectionLock(")).toBeLessThan(del.indexOf("deleteConnection("));
    expect(del).toMatch(/e instanceof ConnectionBusy\) return NextResponse\.json\(\{ ok: false, error: "busy" \}, \{ status: 409/);
    const cb = read("src/app/api/connect/[provider]/callback/route.ts");
    const saves = [...cb.matchAll(/await saveConnection\(st\.email, (\w+)\)/g)];
    expect(saves.length).toBe(2);
    for (const m of saves) {
      const lockAt = cb.lastIndexOf("withConnectionLock(st.email, p.id", m.index);
      expect(lockAt, m[0]).toBeGreaterThan(-1);
      // The save is inside that lock's callback: no closing of the call between them.
      expect(cb.slice(lockAt, m.index), m[0]).not.toMatch(/\n\s{4,6}\}\);/);
    }
  });

  it("2931: a connection deleted during the refresh stays deleted, and the refresh returns null", async () => {
    const u = await newUser("lockdel");
    await saveConnection(u.email, zid({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    fakeZid(() => deleteConnection(u.email, "zid"));
    expect(await getFreshConnection(u.email, "zid")).toBeNull();
    expect(await getConnection(u.email, "zid")).toBeNull();
    // The lock was released.
    const t = await db.lockOwned(lockOf(u.email), 30);
    expect(t).toBeTruthy();
    await db.unlockOwned(lockOf(u.email), t!);
  });

  it("2931: a connection made again during the refresh keeps its own tokens, never the old grant's", async () => {
    const u = await newUser("lockre");
    await saveConnection(u.email, zid({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const fresh = zid({ data: { access_token: "new-grant-mgr", authorization: "new-grant-auth", refresh_token: "new-grant-refresh" }, connectedAt: NEW_AT, expiresAt: inDays(365) });
    fakeZid(() => saveConnection(u.email, fresh));
    const got = await getFreshConnection(u.email, "zid");
    expect(got?.connectedAt).toBe(NEW_AT);
    expect(got?.data.access_token).toBe("new-grant-mgr");
    const stored = await getConnection(u.email, "zid");
    expect(stored?.connectedAt).toBe(NEW_AT);
    expect(stored?.data.refresh_token).toBe("new-grant-refresh");
  });

  it("2931: the same grant, unchanged during the refresh, is still saved with the new tokens", async () => {
    const u = await newUser("locksame");
    await saveConnection(u.email, zid({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    fakeZid(async () => {});
    expect((await getFreshConnection(u.email, "zid"))?.data.access_token).toBe("refreshed-mgr");
    expect((await getConnection(u.email, "zid"))?.data.refresh_token).toBe("refreshed-refresh");
  });

  it("2931: DELETE waits for the refresh's lock; one held through every wait is 409 busy and deletes nothing", async () => {
    const u = await newUser("lockdelroute");
    const scope = sc(u);
    await saveConnection(scope, zid());
    await signIn(u.email);
    const holder = await db.lockOwned(lockOf(scope), 30);
    expect(holder).toBeTruthy();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const p = connRoute.DELETE(json("/api/connect/zid", "DELETE"), params({ provider: "zid" }));
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "busy" });
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(await getConnection(scope, "zid")).not.toBeNull();
    // The holder's lock was never freed by the refused DELETE.
    expect(await db.lockOwned(lockOf(scope), 30)).toBeNull();
    await db.unlockOwned(lockOf(scope), holder!);
    vi.useRealTimers();
    // Once the lock is free the disconnect goes through and leaves no lock behind.
    const ok = await connRoute.DELETE(json("/api/connect/zid", "DELETE"), params({ provider: "zid" }));
    expect(ok.status).toBe(200);
    expect(await getConnection(scope, "zid")).toBeNull();
    const t = await db.lockOwned(lockOf(scope), 30);
    expect(t).toBeTruthy();
    await db.unlockOwned(lockOf(scope), t!);
  });

  it("2931: withConnectionLock runs nothing when the lock stays held, and releases its own lock after an error", async () => {
    const u = await newUser("lockhelper");
    const holder = await db.lockOwned(lockOf(u.email), 30);
    const fn = vi.fn(async () => "ran");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const p = withConnectionLock(u.email, "zid", fn);
    const done = expect(p).rejects.toBeInstanceOf(ConnectionBusy);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(fn).not.toHaveBeenCalled();
    await db.unlockOwned(lockOf(u.email), holder!);
    vi.useRealTimers();
    await expect(withConnectionLock(u.email, "zid", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withConnectionLock(u.email, "zid", fn)).toBe("ran");
  });

  it("2931: the OAuth state is taken once: two callbacks racing on it, only one gets it", async () => {
    expect(read("src/lib/connectors/store.ts")).toMatch(/db\.getdel<Record<string, string>>\(globalKey\.oauthState\(state\)\)/);
    await saveState("race-state-2931", { provider: "zid", email: "x@test.example" });
    const [a, b] = await Promise.all([takeState("race-state-2931"), takeState("race-state-2931")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await takeState("race-state-2931")).toBeNull();
  });
});

describe("POST /api/oauth/token takes only string fields (rule 2932)", () => {
  let ipN = 0;
  const ip = () => ({ "x-forwarded-for": `198.51.100.${++ipN}` });
  const REDIRECT = "https://claude.example/cb";
  const verifier = "w".repeat(50), challenge = createHash("sha256").update(verifier).digest("base64url");
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://nashr.test/api/oauth/token", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("2932: non-string code, verifier, refresh token, client id, grant type or a non-object body are a 400, never a throw", async () => {
    const u = await newUser("oauthstr");
    const client = await registerClient({ redirect_uris: [REDIRECT], client_name: "Claude" });
    const cid = client.client_id;
    const cases: [unknown, string][] = [
      [{ grant_type: "authorization_code", client_id: cid, code: {}, code_verifier: 1, redirect_uri: "x" }, "invalid_request"],
      [{ grant_type: "authorization_code", client_id: cid, code: ["a"], code_verifier: verifier, redirect_uri: REDIRECT }, "invalid_request"],
      [{ grant_type: "authorization_code", client_id: cid, code: "c", code_verifier: { v: 1 }, redirect_uri: REDIRECT }, "invalid_request"],
      [{ grant_type: "authorization_code", client_id: cid, code: "c", code_verifier: verifier, redirect_uri: 7 }, "invalid_request"],
      [{ grant_type: "refresh_token", client_id: cid, refresh_token: { t: "x" } }, "invalid_grant"],
      [{ grant_type: "refresh_token", client_id: cid, refresh_token: 12345 }, "invalid_grant"],
      [{ grant_type: ["authorization_code"], client_id: cid }, "unsupported_grant_type"],
      [{ grant_type: "authorization_code", client_id: { id: cid } }, "invalid_client"],
      [{ grant_type: "authorization_code", client_id: 5 }, "invalid_client"],
      [null, "invalid_client"],
      [[cid], "invalid_client"],
      ["just a string", "invalid_client"],
    ];
    for (const [i, [body, error]] of cases.entries()) {
      const res = await token.POST(post(body, ip()));
      expect(res.status, `case ${i + 1}`).toBe(400);
      expect(await res.json(), `case ${i + 1}`).toMatchObject({ error });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    // None of the refusals spent anything: a real code still redeems once.
    const code = await issueCode({ client_id: cid, redirect_uri: REDIRECT, challenge, email: u.email, scope: "noor" });
    const ok = await token.POST(post({ grant_type: "authorization_code", client_id: cid, code, code_verifier: verifier, redirect_uri: REDIRECT }, ip()));
    expect(ok.status).toBe(200);
    expect((await ok.json()).access_token).toMatch(/^thakeen_/);
  });

  it("2932: the route coerces every field to a string before the client lookup", () => {
    const src = read("src/app/api/oauth/token/route.ts");
    expect(src).toMatch(/const s = \(v: unknown\) => \(typeof v === "string" \? v : ""\)/);
    for (const f of ["grant_type", "client_id", "client_secret", "code", "code_verifier", "redirect_uri", "refresh_token"]) expect(src).toMatch(new RegExp(`${f}: s\\(o\\.${f}`));
    expect(src.indexOf("const b = {")).toBeLessThan(src.indexOf("getClient("));
    expect(src).not.toMatch(/b = await req\.json\(\)/);
  });
});
