import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { QueryClient } from "@tanstack/react-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { jar, json, newMember, newUser, signIn, signOut, withHeaders } from "./helpers/session";
import { RPC_ORIGIN, rpcInProcess, rpcSeen, rpcTestClient } from "./helpers/rpc";
import { sessionKey } from "@/lib/auth";
import { db } from "@/lib/db";
import { deviceId } from "@/lib/devices";
import { globalKey } from "@/lib/keys";
import { log } from "@/lib/log";
import { appDict } from "@/lib/app-i18n";
import { crossSiteRefusal } from "@/lib/csrf";
import { WORKSPACE_FREE, workspaceFree } from "@/lib/ws-path";
import { SIGN_OUT_OTHERS_PER_HOUR } from "@/lib/account-security";
import { WINDOW } from "@/lib/rate";
import { RPC_MAX_BODY, RPC_PREFIX } from "@/lib/rpc/handler";
import { RPC_CLIENT_PATH, browserRpcUrl, makeRpcClient, orpc, rpcFailure } from "@/lib/rpc/client";
import { router } from "@/lib/rpc/router";
import * as rpcRoute from "@/app/api/rpc/[[...rest]]/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as sessionsRoute from "@/app/api/account/sessions/route";
import * as passkeysRoute from "@/app/api/account/passkeys/route";
import SecuritySettings from "@/components/app/settings/SecuritySettings";

/**
 * oRPC behind AUTH_ENGINE, step (e) (rules 3421-3424, docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md
 * section 8, docs/system/tests/3400-better-auth-orpc.md). The typed client drives the real route module in-process; the
 * REST routes run on the same fixtures, and their answers are compared.
 */
const SECRET = randomBytes(24).toString("hex");
const PASSWORD = "abc12345";
const on = () => { vi.stubEnv("AUTH_ENGINE", "better-auth"); vi.stubEnv("BETTER_AUTH_SECRET", SECRET); };
beforeEach(() => { rpcSeen.length = 0; });
afterEach(() => { signOut(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const read = (f: string) => readFileSync(f, "utf8");
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
let ipN = 0;
/** Sign in through the real login route from a browser, so the device index has an entry; returns the cookie token. */
async function loginFrom(email: string, ua: string, password = PASSWORD): Promise<string> {
  const addr = `198.51.100.${(++ipN % 250) + 1}`;
  const r = await withHeaders({ "user-agent": ua, "x-forwarded-for": addr }, () => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, { "x-forwarded-for": addr })));
  expect(r.status).toBe(200);
  return jar().get("thakeen_session")!;
}
const use = (token: string) => jar().set("thakeen_session", token);

/** A raw POST to the route, as a browser on the same origin would send it. */
const raw = (path: string, body: string, headers: Record<string, string> = {}) =>
  rpcRoute.POST(new Request(`https://thakeen.com${path}`, { method: "POST", headers: { "content-type": "application/json", origin: RPC_ORIGIN, ...headers }, body }));
/** An oRPC failure, caught. */
const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return rpcFailure(e); } throw new Error("expected a refusal"); };
const restDelete = (id: string, password = PASSWORD) => sessionsRoute.DELETE(json("/api/account/sessions", "DELETE", { id, password }));
const bucketHits = async (email: string) => Number((await db.get(`rate:${globalKey.signOutOthersBucket(email)}`)) ?? 0);

describe("rule 3421: one oRPC endpoint and one typed client, only while AUTH_ENGINE is on", () => {
  it("off: every procedure, known or not, answers the legacy 404 and nothing is read or written", async () => {
    const u = await newUser("rp");
    const a = await loginFrom(u.email, CHROME);
    const b = await loginFrom(u.email, SAFARI);
    use(b);
    const spy = vi.spyOn(db, "get");
    for (const path of ["/api/rpc/account/devices/list", "/api/rpc/account/passkeys/list", "/api/rpc/nope"]) {
      const r = await raw(path, JSON.stringify({ json: {} }));
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ ok: false, error: "not_found" });
    }
    expect(spy).not.toHaveBeenCalled();
    const c = rpcTestClient();
    expect(await failure(c.account.devices.revoke({ id: deviceId(sessionKey(a)), password: PASSWORD }))).toEqual({ error: "not_found", status: 404 });
    expect(await bucketHits(u.email)).toBe(0);
    expect((await (await sessionsRoute.GET()).json()).devices).toHaveLength(2);
  });

  it("on: the typed client lists the devices and passkeys over POST, same-origin, at /api/rpc", async () => {
    const u = await newUser("rp");
    const a = await loginFrom(u.email, CHROME);
    const b = await loginFrom(u.email, SAFARI);
    on();
    use(b);
    const c = rpcTestClient();
    const devices = await c.account.devices.list();
    expect(devices.map((d) => [d.id, d.current])).toEqual([[deviceId(sessionKey(b)), true], [deviceId(sessionKey(a)), false]]);
    expect(await c.account.passkeys.list()).toEqual({ items: [], max: expect.any(Number), enabled: expect.any(Boolean), proof: "password" });
    expect(rpcSeen.map((s) => [new URL(s.url).pathname, s.method, s.credentials])).toEqual([
      ["/api/rpc/account/devices/list", "POST", "same-origin"],
      ["/api/rpc/account/passkeys/list", "POST", "same-origin"],
    ]);
  });

  it("the client and the server agree on the path; the route serves POST only", () => {
    expect(RPC_CLIENT_PATH).toBe(RPC_PREFIX);
    expect(Object.keys(rpcRoute).sort()).toEqual(["POST"]);
    expect(read("src/app/api/rpc/[[...rest]]/route.ts")).toMatch(/if \(!baOn\(\)\) return Response\.json\(\{ ok: false, error: "not_found" \}, \{ status: 404 \}\);\n\s+const user = await currentUser\(\);/);
  });

  it("the browser client imports the router as a type only and reads its address from the window when called", async () => {
    const src = read("src/lib/rpc/client.ts");
    const imports = [...src.matchAll(/^import (type )?.* from "([^"]+)";$/gm)].map((m) => `${m[1] ?? ""}${m[2]}`);
    expect(imports.sort()).toEqual(["@orpc/client", "@orpc/client/fetch", "@orpc/tanstack-query", "type ./router", "type @orpc/server"]);
    expect(src).not.toMatch(/process\.env/);
    expect(() => browserRpcUrl()).toThrow(/browser only/);
    vi.stubEnv("BETTER_AUTH_URL", "https://evil.example");
    vi.stubGlobal("window", { location: { origin: "https://thakeen.com" } });
    expect(browserRpcUrl()).toBe("https://thakeen.com/api/rpc");
    const calls: string[] = [];
    const c = makeRpcClient({ url: browserRpcUrl, fetchImpl: async (input) => { calls.push((input as Request).url); return new Response("{}", { status: 599 }); } });
    await c.account.devices.list().catch(() => null);
    expect(calls).toEqual(["https://thakeen.com/api/rpc/account/devices/list"]);
  });

  it("the module-level client builds nothing on the server: a call throws before any request", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { rpc } = await import("@/lib/rpc/client");
    expect(await failure(rpc.account.devices.list())).toEqual({ error: "failed", status: 0 });
    expect(f).not.toHaveBeenCalled();
  });

  it("TanStack utils over the client: keys per procedure, query and mutation options that call through it", async () => {
    expect(orpc.account.devices.list.key()).toEqual(orpc.account.devices.list.key());
    expect(orpc.account.devices.list.key()).not.toEqual(orpc.account.passkeys.list.key());
    const u = await newUser("rp");
    const a = await loginFrom(u.email, CHROME);
    const b = await loginFrom(u.email, SAFARI);
    on();
    use(b);
    const utils = createTanstackQueryUtils(rpcTestClient());
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    expect(await qc.fetchQuery(utils.account.devices.list.queryOptions())).toHaveLength(2);
    const m = utils.account.devices.revoke.mutationOptions();
    expect(await m.mutationFn!({ id: deviceId(sessionKey(a)), password: PASSWORD }, undefined as never)).toEqual({ ok: true });
    await qc.invalidateQueries({ queryKey: utils.account.devices.list.key() });
    expect(await qc.fetchQuery(utils.account.devices.list.queryOptions())).toHaveLength(1);
  });
});

describe("rule 3422: the session first, the same gates, limits and answers as REST", () => {
  it("signed out: every procedure is UNAUTHORIZED, before its input is read", async () => {
    on();
    signOut();
    const c = rpcTestClient();
    expect(await failure(c.account.devices.list())).toEqual({ error: "unauthorized", status: 401 });
    expect(await failure(c.account.passkeys.list())).toEqual({ error: "unauthorized", status: 401 });
    // A malformed input still answers 401, not 400: the session is checked before validation.
    const r = await raw("/api/rpc/account/devices/revoke", JSON.stringify({ json: { id: 5 } }));
    expect(r.status).toBe(401);
  });

  it("an MCP-style bearer header is not a session: still UNAUTHORIZED", async () => {
    on();
    signOut();
    const r = await raw("/api/rpc/account/devices/list", JSON.stringify({ json: null }), { authorization: `Bearer ${"a".repeat(64)}` });
    expect(r.status).toBe(401);
  });

  it("parity: the device list, the passkey list and each refusal match the REST routes on the same fixtures", async () => {
    const u = await newUser("rp");
    const a = await loginFrom(u.email, CHROME);
    const b = await loginFrom(u.email, SAFARI);
    on();
    use(b);
    const c = rpcTestClient();
    const rest = await (await sessionsRoute.GET()).json();
    expect(await c.account.devices.list()).toEqual(rest.devices);
    const { ok, ...pk } = await (await passkeysRoute.GET()).json();
    expect(ok).toBe(true);
    expect(await c.account.passkeys.list()).toEqual(pk);

    // Each refusal: the REST status and code, then the oRPC status and code, on the same state.
    const cases: [string, string, number, string][] = [
      [deviceId(sessionKey(a)), "wrong-pass", 401, "wrong_password"],
      [deviceId(sessionKey(b)), PASSWORD, 400, "current_device"],
      ["0".repeat(20), PASSWORD, 404, "not_found"],
      ["not-an-id", PASSWORD, 404, "not_found"],
    ];
    for (const [id, pw, status, error] of cases) {
      const r = await restDelete(id, pw);
      expect([r.status, (await r.json()).error], `REST ${error}`).toEqual([status, error]);
      expect(await failure(c.account.devices.revoke({ id, password: pw })), `RPC ${error}`).toEqual({ error, status });
    }
    expect(await c.account.devices.revoke({ id: deviceId(sessionKey(a)), password: PASSWORD })).toEqual({ ok: true });
    expect((await c.account.devices.list()).map((d) => d.id)).toEqual([deviceId(sessionKey(b))]);
  });

  it("a member ends their own device only; an owner's device id is not found for them", async () => {
    const owner = await newUser("rp");
    const oa = await loginFrom(owner.email, CHROME);
    const m = await newMember(owner, "member", "rm");
    const ma = await loginFrom(m.email, CHROME, m.password);
    const mb = await loginFrom(m.email, SAFARI, m.password);
    on();
    use(mb);
    const c = rpcTestClient();
    expect((await c.account.devices.list()).map((d) => d.id).sort()).toEqual([deviceId(sessionKey(ma)), deviceId(sessionKey(mb))].sort());
    expect(await failure(c.account.devices.revoke({ id: deviceId(sessionKey(oa)), password: m.password }))).toEqual({ error: "not_found", status: 404 });
    expect(await c.account.devices.revoke({ id: deviceId(sessionKey(ma)), password: m.password })).toEqual({ ok: true });
  });

  it("a founder impersonating gets FORBIDDEN on every procedure, as on REST", async () => {
    const u = await newUser("rp");
    on();
    await signIn(u.email, { imp: "founder@test.example" });
    const c = rpcTestClient();
    expect((await sessionsRoute.GET()).status).toBe(403);
    expect((await passkeysRoute.GET()).status).toBe(403);
    expect(await failure(c.account.devices.list())).toEqual({ error: "forbidden", status: 403 });
    expect(await failure(c.account.passkeys.list())).toEqual({ error: "forbidden", status: 403 });
    expect(await failure(c.account.devices.revoke({ id: "0".repeat(20), password: PASSWORD }))).toEqual({ error: "forbidden", status: 403 });
    expect(await bucketHits(u.email)).toBe(0);
  });

  it("one wrong-password counter for both paths: REST spends it, oRPC is slowed down, and the other way round", async () => {
    for (const restFirst of [true, false]) {
      const u = await newUser("rp");
      const a = await loginFrom(u.email, CHROME);
      on();
      use(a);
      const c = rpcTestClient();
      for (let i = 0; i < SIGN_OUT_OTHERS_PER_HOUR; i++) {
        if (restFirst) expect((await restDelete("0".repeat(20), "wrong-pass")).status).toBe(401);
        else expect((await failure(c.account.devices.revoke({ id: "0".repeat(20), password: "wrong-pass" }))).status).toBe(401);
      }
      expect(await bucketHits(u.email)).toBe(SIGN_OUT_OTHERS_PER_HOUR);
      if (restFirst) expect(await failure(c.account.devices.revoke({ id: "0".repeat(20), password: PASSWORD }))).toEqual({ error: "slow_down", status: 429 });
      else expect([(await restDelete("0".repeat(20))).status]).toEqual([429]);
      // Both 429s say when to try again (rule 680): the bucket's hour, as REST's retryLater sends it.
      const r = await raw("/api/rpc/account/devices/revoke", JSON.stringify({ json: { id: "0".repeat(20), password: PASSWORD } }));
      expect([r.status, r.headers.get("retry-after")]).toEqual([429, String(WINDOW.hour)]);
      expect((await restDelete("0".repeat(20))).headers.get("retry-after")).toBe(String(WINDOW.hour));
    }
  });

  it("only a 429 carries Retry-After", async () => {
    const u = await newUser("rp");
    await loginFrom(u.email, CHROME);
    on();
    const r = await raw("/api/rpc/account/devices/revoke", JSON.stringify({ json: { id: "0".repeat(20), password: "wrong-pass" } }));
    expect([r.status, r.headers.get("retry-after")]).toEqual([401, null]);
  });

  it("a correct password gives its hit back, as on REST", async () => {
    const u = await newUser("rp");
    const a = await loginFrom(u.email, CHROME);
    on();
    use(a);
    const c = rpcTestClient();
    for (let i = 0; i < 12; i++) expect((await failure(c.account.devices.revoke({ id: "0".repeat(20), password: PASSWORD }))).status).toBe(404);
    expect(await bucketHits(u.email)).toBe(0);
  });

  it("input is bounded and validated after the session; a refusal never echoes the password", async () => {
    const u = await newUser("rp");
    await loginFrom(u.email, CHROME);
    on();
    const long = "p".repeat(1025);
    for (const body of [{ json: { id: 5, password: PASSWORD } }, { json: { id: "x", password: long } }, { json: { id: "x" } }]) {
      const r = await raw("/api/rpc/account/devices/revoke", JSON.stringify(body));
      expect(r.status).toBe(400);
      const text = await r.text();
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(long);
    }
    expect(await bucketHits(u.email)).toBe(0);
  });

  it("a body over the limit is refused before it is parsed", async () => {
    const u = await newUser("rp");
    await loginFrom(u.email, CHROME);
    on();
    const big = JSON.stringify({ json: { id: "x", password: "p".repeat(RPC_MAX_BODY) } });
    expect((await raw("/api/rpc/account/devices/revoke", big)).status).toBe(413);
    expect(await bucketHits(u.email)).toBe(0);
  });

  it("an unexpected failure is a bare 500: no message leaves, and the log line carries the path and the name only", async () => {
    const u = await newUser("rp");
    await loginFrom(u.email, CHROME);
    on();
    const real = db.hgetall.bind(db);
    vi.spyOn(db, "hgetall").mockImplementation(((key: string) => (key.startsWith("devs:") ? Promise.reject(new Error("redis said secret-xyz")) : real(key))) as typeof db.hgetall);
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    const r = await raw("/api/rpc/account/devices/list", JSON.stringify({ json: null }));
    expect(r.status).toBe(500);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const text = await r.text();
    expect(text).toContain("Internal server error");
    expect(text).not.toContain("secret-xyz");
    expect(logged).toHaveBeenCalledWith("rpc_failed", { path: "account.devices.list", name: "Error" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-xyz");
  });

  it("an unknown procedure is the legacy 404; answers are never cached", async () => {
    const u = await newUser("rp");
    await loginFrom(u.email, CHROME);
    on();
    const r = await raw("/api/rpc/account/nope", JSON.stringify({ json: null }));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ ok: false, error: "not_found" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await raw("/api/rpc/account/passkeys/list", JSON.stringify({ json: null }))).headers.get("cache-control")).toBe("no-store");
  });
});

describe("rule 3423: nothing on the RPC path names a person, a workspace or a scope from the request", () => {
  const files = [...readdirSync("src/lib/rpc").map((f) => join("src/lib/rpc", f)), "src/lib/account-security.ts", "src/app/api/rpc/[[...rest]]/route.ts"];

  it("no file keys a workspace, touches Redis or builds a raw key", () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/\bsc\(/);
      expect(src, f).not.toMatch(/from "@\/lib\/db"/);
      expect(src, f).not.toMatch(/`[a-z]+:\$\{/);
    }
  });

  it("the only input is a device id and a password: no address, person, account, brand or scope", () => {
    const shape = (router.account.devices.revoke["~orpc"].inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape).sort()).toEqual(["id", "password"]);
    expect(router.account.devices.list["~orpc"].inputSchema).toBeUndefined();
    expect(router.account.passkeys.list["~orpc"].inputSchema).toBeUndefined();
    expect(read("src/lib/account-security.ts")).toMatch(/actingLogin\(u\)/);
  });

  it("outside the workspace guard (person-level), inside the same-origin check", async () => {
    expect(WORKSPACE_FREE).toEqual(expect.arrayContaining(["/api/rpc/", "/api/better-auth/"]));
    expect(workspaceFree("/api/rpc/account/devices/revoke")).toBe(true);
    expect(workspaceFree("/api/better-auth/sign-in/email")).toBe(true);
    expect(workspaceFree("/api/rpcx")).toBe(false);
    const cross = new NextRequest("https://thakeen.com/api/rpc/account/devices/revoke", {
      method: "POST",
      headers: { host: "thakeen.com", "x-forwarded-host": "thakeen.com", "x-forwarded-proto": "https", "content-type": "application/json", "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      body: "{}",
    });
    const res = crossSiteRefusal(cross);
    expect(res?.status).toBe(403);
  });
});

describe("rule 3424: the security screen's device list goes through oRPC only while on", () => {
  const ui = read("src/components/app/settings/DeviceList.tsx");

  it("the page passes the switch; the card passes it to the list", () => {
    expect(read("src/app/[lang]/app/settings/security/page.tsx")).toContain("rpc={baOn()}");
    expect(read("src/components/app/settings/SecuritySettings.tsx")).toContain("refresh={devicesRefresh} rpc={rpc} />");
  });

  it("the list loads the client only inside its rpc branch (a dynamic import), never at module level", () => {
    expect(ui).not.toMatch(/^import .*rpc\/client/m);
    expect(ui.match(/await import\("@\/lib\/rpc\/client"\)/g)).toHaveLength(2);
    for (const m of ui.matchAll(/await import\("@\/lib\/rpc\/client"\)/g)) expect(ui.slice(Math.max(0, m.index! - 160), m.index)).toMatch(/if \(rpc\) \{/);
    // Off: main's REST calls, unchanged.
    expect(ui).toContain('await fetch("/api/account/sessions").catch(() => null)');
    expect(ui).toContain('await fetch("/api/account/sessions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, password }) }).catch(() => null)');
  });

  it("server markup is the same with and without the switch (the first paint does not change)", () => {
    const props = { lang: "en" as const, rules: appDict.en.join.rules, may: true, owner: true, forbidden: "x", passkeys: { T: appDict.en.passkeys, enabled: true } };
    expect(renderToStaticMarkup(h(SecuritySettings, { ...props, rpc: true }))).toBe(renderToStaticMarkup(h(SecuritySettings, props)));
  });

  it("rpcFailure keeps the server's code and status, and calls anything else failed", () => {
    expect(rpcFailure(new Error("x"))).toEqual({ error: "failed", status: 0 });
    expect(rpcFailure(null)).toEqual({ error: "failed", status: 0 });
  });

  it("the in-process helper hands the real route a same-origin POST", async () => {
    on();
    signOut();
    await rpcInProcess(new Request("https://nashr.test/api/rpc/account/devices/list", { method: "POST", body: "{}" }));
    expect(rpcSeen[0]).toMatchObject({ method: "POST" });
  });
});
