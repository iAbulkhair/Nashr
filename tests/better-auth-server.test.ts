import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { currentUser, currentUserUnverified, getUser, saveUser, sessionIds, sessionKey } from "@/lib/auth";
import { db } from "@/lib/db";
import { deviceId, devicesKey } from "@/lib/devices";
import { globalKey } from "@/lib/keys";
import { ownerOf } from "@/lib/membership";
import { MFA_COOKIE, mfaKey, type MfaEnrolment } from "@/lib/mfa";
import { getMember, saveMember } from "@/lib/team";
import { BA_ROUTES, legacyError, signedSessionCookie } from "@/lib/better-auth/handler";
import { BA_GOOGLE, BA_SESSION_COOKIE, baOptions, getAuth } from "@/lib/better-auth/server";
import { GATE_PATHS, GateRefusal, sessionGate } from "@/lib/better-auth/gate";
import { pendingApprovals } from "@/lib/better-auth/approvals";
import * as route from "@/app/api/better-auth/[...all]/route";
import * as login from "@/app/api/auth/login/route";

/**
 * better-auth behind AUTH_ENGINE, step (b): the server config, the session gate and the route wrapper
 * (docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md, rules 3400, 3410-3414; docs/system/tests/3400-better-auth-orpc.md).
 */
const SECRET = randomBytes(24).toString("hex");
const ORIGIN = "https://thakeen.com";
const PASSWORD = "abc12345";
afterEach(() => { signOut(); vi.unstubAllEnvs(); });
const on = () => { vi.stubEnv("AUTH_ENGINE", "better-auth"); vi.stubEnv("BETTER_AUTH_SECRET", SECRET); };

let ipN = 0;
/** Never repeats within a run, and never meets the IPs other test files use. */
const freshIp = () => { ipN++; return `198.51.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}`; };
const ba = (path: string, method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}) => {
  const req = json(`/api/better-auth${path}`, method, body, { origin: ORIGIN, "x-forwarded-for": freshIp(), ...headers });
  return method === "GET" ? route.GET(req) : route.POST(req);
};
const baSignIn = (email: string, password = PASSWORD, headers: Record<string, string> = {}) => ba("/sign-in/email", "POST", { email, password }, headers);
const legacySignIn = (email: string, password = PASSWORD, headers: Record<string, string> = {}) =>
  login.POST(json("/api/auth/login", "POST", { email, password }, { "x-forwarded-for": freshIp(), ...headers }));
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as unknown });
const enrol = (email: string) => db.set(mfaKey(email), { enc: "sealed", kid: "k", rc: [], at: new Date(Date.now() + 1000).toISOString() } satisfies MfaEnrolment);

/** The same proof through both engines, each from a signed-out jar: the answers and whether a session cookie came back. */
async function both(email: string, password = PASSWORD) {
  signOut();
  const legacy = await answer(await legacySignIn(email, password));
  const legacyCookie = jar().get("thakeen_session") ?? null;
  const legacyMfa = jar().get(MFA_COOKIE) ?? null;
  signOut();
  const engine = await answer(await baSignIn(email, password));
  const engineCookie = jar().get("thakeen_session") ?? null;
  const engineMfa = jar().get(MFA_COOKIE) ?? null;
  signOut();
  return { legacy, engine, legacyCookie, engineCookie, legacyMfa, engineMfa };
}

/** Every key anywhere in a JSON value, at any depth. */
const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);

describe("rule 3400: with the switch off every better-auth path is 404, before the store", () => {
  const paths: [string, "GET" | "POST"][] = [["/sign-in/email", "POST"], ["/get-session", "GET"], ["/sign-out", "POST"], ["/list-accounts", "GET"], ["/sign-up/email", "POST"], ["/nothing", "GET"]];

  it("answers 404 with no AUTH_ENGINE, another value, or a short secret, and writes no rate counter", async () => {
    const u = await newUser("bo");
    const ip = "203.0.113.77";
    for (const env of [{ AUTH_ENGINE: "", BETTER_AUTH_SECRET: SECRET }, { AUTH_ENGINE: "legacy", BETTER_AUTH_SECRET: SECRET }, { AUTH_ENGINE: "better-auth", BETTER_AUTH_SECRET: "short" }]) {
      vi.stubEnv("AUTH_ENGINE", env.AUTH_ENGINE);
      vi.stubEnv("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET);
      for (const [p, m] of paths) {
        const res = await ba(p, m, m === "POST" ? { email: u.email, password: PASSWORD } : undefined, { "x-forwarded-for": ip });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ ok: false, error: "not_found" });
      }
    }
    expect(await db.get(globalKey.rate(globalKey.loginIpBucket(ip)))).toBeNull();
    expect(await db.get(globalKey.rate(globalKey.loginEmailBucket(u.email)))).toBeNull();
    expect(await db.get(globalKey.rate(globalKey.baReadIpBucket(ip)))).toBeNull();
    expect(jar().get("thakeen_session")).toBeUndefined();
    expect(getAuth()).toBeNull();
  });

  it("the legacy log-in answers as on main with the switch off", async () => {
    const u = await newUser("bo");
    signOut();
    expect(await answer(await legacySignIn(u.email))).toEqual({ status: 200, body: { ok: true, verify: false } });
    expect((await currentUser())!.email).toBe(u.email);
  });
});

describe("rule 3413: only the allow-list reaches better-auth", () => {
  it("lists five routes (the magic link request since rule 3415), Google stays off and no social provider is configured", () => {
    expect(Object.keys(BA_ROUTES).sort()).toEqual(["/get-session", "/list-accounts", "/sign-in/email", "/sign-in/magic-link", "/sign-out"]);
    expect(BA_GOOGLE).toBe(false);
    const o = baOptions(SECRET);
    expect("socialProviders" in o).toBe(false);
    expect(o.emailAndPassword).toMatchObject({ enabled: true, disableSignUp: true });
    expect(o.session).toMatchObject({ disableSessionRefresh: true, cookieCache: { enabled: false } });
    expect(o.rateLimit.enabled).toBe(false);
    expect(o.telemetry.enabled).toBe(false);
    expect(o.account.accountLinking.enabled).toBe(false);
    expect(o.user).toEqual({ changeEmail: { enabled: false }, deleteUser: { enabled: false } });
  });

  it("answers 404 for every other endpoint better-auth has, and for a wrong method", async () => {
    on();
    const u = await newUser("bl");
    await signIn(u.email);
    const others: [string, "GET" | "POST"][] = [
      ["/sign-up/email", "POST"], ["/update-user", "POST"], ["/list-sessions", "GET"], ["/revoke-session", "POST"], ["/revoke-sessions", "POST"],
      ["/revoke-other-sessions", "POST"], ["/change-password", "POST"], ["/set-password", "POST"], ["/reset-password", "POST"], ["/request-password-reset", "POST"],
      ["/delete-user", "POST"], ["/change-email", "POST"], ["/sign-in/social", "POST"], ["/callback/google", "GET"], ["/link-social", "POST"],
      ["/unlink-account", "POST"], ["/verify-email", "GET"], ["/send-verification-email", "POST"], ["/magic-link/verify", "GET"], ["/ok", "GET"], ["/error", "GET"],
      ["/sign-in/email", "GET"], ["/get-session", "POST"], ["/sign-out", "GET"], ["/list-accounts", "POST"], ["/get-session/", "GET"], ["", "GET"],
    ];
    for (const [p, m] of others) {
      const res = await ba(p, m, m === "POST" ? { email: u.email, password: PASSWORD, name: "x" } : undefined);
      expect([p, m, res.status]).toEqual([p, m, 404]);
    }
    // The session is untouched by all of it.
    expect((await currentUser())!.email).toBe(u.email);
  });

  it("a path outside the base is 404", async () => {
    on();
    const res = await route.GET(new Request("https://nashr.test/api/better-authx/get-session", { headers: { origin: ORIGIN } }));
    expect(res.status).toBe(404);
  });
});

describe("rule 3410: one session cookie, one record shape, both engines", () => {
  it("a better-auth sign-in sets thakeen_session (64 hex), writes the legacy record and nothing better-auth-specific", async () => {
    on();
    const u = await newUser("bc");
    signOut();
    const res = await baSignIn(u.email);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, verify: false, redirect: false, user: { id: ownerOf(u), email: u.email, emailVerified: true } });
    const token = jar().get("thakeen_session")!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.get(sessionKey(token))).toEqual({ email: u.email, at: expect.any(Number), ...(await sessionIds(u.email)) });
    // better-auth's own cookies never reach the browser: none in the answer, none in the jar.
    expect(res.headers.getSetCookie().filter((c) => c.startsWith("thakeen."))).toEqual([]);
    expect([...jar().keys()].filter((k) => k.startsWith("thakeen."))).toEqual([]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(body)).not.toContain(token);
    expect(pendingApprovals()).toBe(0);
    expect((await currentUser())!.email).toBe(u.email);
    // The device list has this session, as after a legacy sign-in.
    expect(await db.hgetall(devicesKey(u.email))).toHaveProperty(deviceId(sessionKey(token)));
  });

  it("a member signs in through better-auth as through the legacy route", async () => {
    on();
    const o = await newUser("bm");
    const m = await newMember(o);
    const { legacy, engine, engineCookie } = await both(m.email, m.password);
    expect(legacy).toEqual({ status: 200, body: { ok: true } });
    expect(engine.status).toBe(200);
    expect(engine.body).toMatchObject({ ok: true, user: { email: m.email } });
    expect(engine.body).not.toHaveProperty("verify");
    expect(engineCookie).toMatch(/^[0-9a-f]{64}$/);
  });

  it("get-session answers a session the legacy engine made, exactly when currentUser resolves it", async () => {
    on();
    const u = await newUser("bg");
    // A record from before R1 (`{email, at}`) resolves for a legacy person and not for a `p_` one (rule 2135): the
    // projection follows `currentUser` either way, so both stored shapes are checked for parity.
    for (const legacyShape of [false, true]) {
      const token = await signIn(u.email, { legacyShape });
      const res = await ba("/get-session", "GET");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { session: Record<string, unknown>; user: Record<string, unknown> } | null;
      const me = await currentUser();
      expect(body === null).toBe(me === null);
      if (!legacyShape) expect(body).not.toBeNull();
      if (!body) continue;
      expect(body.user).toMatchObject({ id: ownerOf(u), email: u.email });
      expect(Object.keys(body.session).sort()).toEqual(["createdAt", "expiresAt", "id", "updatedAt", "userId"]);
      expect(body.session).toMatchObject({ id: deviceId(sessionKey(token)), userId: ownerOf(u) });
      expect(JSON.stringify(body)).not.toContain(token);
      // Reading it changed nothing.
      expect(await db.get(sessionKey(token))).not.toBeNull();
    }
  });

  it("get-session is null for no cookie, an unknown token, a malformed cookie and an impersonation", async () => {
    on();
    const u = await newUser("bn");
    const read = async () => (await ba("/get-session", "GET")).json();
    expect(await read()).toBeNull();
    jar().set("thakeen_session", randomBytes(32).toString("hex"));
    expect(await read()).toBeNull();
    jar().set("thakeen_session", "a.b;c=d");
    expect(await read()).toBeNull();
    await signIn(u.email, { imp: "founder@test.example" });
    expect(await read()).toBeNull();
    // An unverified owner reads as signed out, as `currentUser` reads it.
    const v = await newUser("bn", { verified: false });
    await signIn(v.email);
    expect(await read()).toBeNull();
  });

  it("a better-auth cookie the request carries is ignored: only thakeen_session counts", async () => {
    on();
    const u = await newUser("bf");
    const token = await signIn(u.email);
    signOut();
    const res = await ba("/get-session", "GET", undefined, { cookie: `${signedSessionCookie(token, SECRET)}; thakeen_session=${token}` });
    expect(await res.json()).toBeNull();
  });

  it("better-auth accepts the cookie the wrapper signs, and only with the secret", async () => {
    on();
    const u = await newUser("bs");
    const token = await signIn(u.email);
    const auth = getAuth()!;
    const ok = await auth.api.getSession({ headers: new Headers({ cookie: signedSessionCookie(token, SECRET), origin: ORIGIN }) });
    expect(ok?.user.email).toBe(u.email);
    const forged = await auth.api.getSession({ headers: new Headers({ cookie: signedSessionCookie(token, "x".repeat(40)), origin: ORIGIN }) });
    expect(forged).toBeNull();
    expect(BA_SESSION_COOKIE).toBe("thakeen.session_token");
  });

  it("a session better-auth made survives the switch going off", async () => {
    on();
    const u = await newUser("bt");
    signOut();
    await baSignIn(u.email);
    const token = jar().get("thakeen_session")!;
    vi.unstubAllEnvs();
    expect((await currentUser())!.email).toBe(u.email);
    expect((await ba("/get-session", "GET")).status).toBe(404);
    expect(jar().get("thakeen_session")).toBe(token);
  });

  it("sign-out drops the record, the device entry and the cookie", async () => {
    on();
    const u = await newUser("bx");
    signOut();
    await baSignIn(u.email);
    const token = jar().get("thakeen_session")!;
    const res = await ba("/sign-out", "POST", {});
    expect(await answer(res)).toEqual({ status: 200, body: { success: true } });
    expect(await db.get(sessionKey(token))).toBeNull();
    expect(await db.hgetall(devicesKey(u.email))).not.toHaveProperty(deviceId(sessionKey(token)));
    expect(jar().get("thakeen_session")).toBeUndefined();
    expect(await currentUser()).toBeNull();
    // Signed out already: the same answer.
    expect(await answer(await ba("/sign-out", "POST", {}))).toEqual({ status: 200, body: { success: true } });
  });

  it("list-accounts shows the password login without the hash or an account id", async () => {
    on();
    const u = await newUser("ba");
    await signIn(u.email);
    const res = await ba("/list-accounts", "GET");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerId: "credential" });
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "id", "providerId", "updatedAt"]);
    signOut();
    expect((await ba("/list-accounts", "GET")).status).toBe(401);
  });
});

describe("rule 3411: the session gate gives the legacy answers and opens no session it would refuse", () => {
  it("a wrong password, an unknown address, an empty or oversized body", async () => {
    on();
    const u = await newUser("gw");
    const wrong = await both(u.email, "wrong-pass");
    expect(wrong.engine).toEqual({ status: 401, body: { ok: false, error: "invalid" } });
    expect(wrong.engine).toEqual(wrong.legacy);
    expect(wrong.engineCookie).toBeNull();
    const unknown = await both(`nobody-${randomBytes(3).toString("hex")}@test.example`);
    expect(unknown.engine).toEqual(unknown.legacy);
    for (const body of [{}, { email: u.email }, { email: u.email, password: "x".repeat(1025) }, "not json"]) {
      const res = await ba("/sign-in/email", "POST", body);
      expect(await answer(res)).toEqual({ status: 401, body: { ok: false, error: "invalid" } });
    }
    expect(jar().get("thakeen_session")).toBeUndefined();
  });

  it("only email and password reach better-auth: no rememberMe, no callbackURL", async () => {
    on();
    const u = await newUser("gr");
    signOut();
    const res = await ba("/sign-in/email", "POST", { email: u.email, password: PASSWORD, rememberMe: false, callbackURL: "https://evil.example/x" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.redirect).toBe(false);
    expect(body).not.toHaveProperty("url");
    // A full session, not a one-day one: the record's TTL is the legacy 30 days.
    const token = jar().get("thakeen_session")!;
    expect(await db.ttl(sessionKey(token))).toBeGreaterThan(29 * 86400);
  });

  it("a suspended account, with and without an end date", async () => {
    on();
    const u = await newUser("gs");
    await saveUser({ ...(await getUser(u.email))!, suspended: true });
    const r = await both(u.email);
    expect(r.engine).toEqual({ status: 403, body: { ok: false, error: "suspended" } });
    expect(r.engine).toEqual(r.legacy);
    expect(r.engineCookie).toBeNull();
    const until = new Date(Date.now() + 864e5).toISOString();
    await saveUser({ ...(await getUser(u.email))!, suspended: { until } });
    const t = await both(u.email);
    expect(t.engine).toEqual({ status: 403, body: { ok: false, error: "suspended", until } });
    expect(t.engine).toEqual(t.legacy);
  });

  it("a member of an unverified owner, and a member paused by the seat limit", async () => {
    on();
    const uo = await newUser("gu", { verified: false });
    const um = await newMember(uo);
    const a = await both(um.email, um.password);
    expect(a.engine).toEqual({ status: 403, body: { ok: false, error: "owner_unverified" } });
    expect(a.engine).toEqual(a.legacy);
    expect(a.engineCookie).toBeNull();
    const o = await newUser("gp");
    const m = await newMember(o, "member", "m", { legacy: true });
    await saveMember({ ...(await getMember(m.email))!, disabled: "seats" });
    const b = await both(m.email, m.password);
    expect(b.engine).toEqual({ status: 403, body: { ok: false, error: "disabled" } });
    expect(b.engine).toEqual(b.legacy);
    expect(b.engineCookie).toBeNull();
  });

  it("two-step sign-in: the same challenge and NO session (rule 1934)", async () => {
    on();
    const u = await newUser("gm");
    await enrol(u.email);
    const r = await both(u.email);
    expect(r.engine).toEqual({ status: 401, body: { ok: false, error: "mfa_required", mfa: true } });
    expect(r.engine).toEqual(r.legacy);
    expect(r.engineCookie).toBeNull();
    expect(r.engineMfa).toBeTruthy();
    expect(r.legacyMfa).toBeTruthy();
    expect(pendingApprovals()).toBe(0);
  });

  it("an owner who has not proved the address gets a session and verify: true, as before", async () => {
    on();
    const u = await newUser("gv", { verified: false });
    const r = await both(u.email);
    expect(r.legacy).toEqual({ status: 200, body: { ok: true, verify: true } });
    expect(r.engine.body).toMatchObject({ ok: true, verify: true });
    expect(r.engineCookie).toMatch(/^[0-9a-f]{64}$/);
    jar().set("thakeen_session", r.engineCookie!);
    expect(await currentUser()).toBeNull();
    expect((await currentUserUnverified())!.email).toBe(u.email);
  });

  it("refuses any other better-auth path and a call with no endpoint", async () => {
    const u = await newUser("gx");
    expect([...GATE_PATHS].sort()).toEqual(["/magic-link/verify", "/sign-in/email"]);
    for (const ctx of [null, {}, { path: "/sign-up/email" }, { path: "/callback/google" }, { path: "/sign-in/social" }]) {
      await expect(sessionGate({ userId: ownerOf(u) }, ctx)).rejects.toBeInstanceOf(GateRefusal);
    }
    await expect(sessionGate({ userId: "p_nobody" }, { path: "/sign-in/email" })).rejects.toBeInstanceOf(GateRefusal);
    expect(pendingApprovals()).toBe(0);
    // The one allowed path approves exactly one token, which the adapter then takes.
    const ok = await sessionGate({ userId: ownerOf(u) }, { path: "/sign-in/email" });
    expect(ok.data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(pendingApprovals()).toBe(1);
  });
});

describe("rule 3412: no token, address or browser string leaves the server", () => {
  it("sign-in, get-session and list-accounts carry none of them", async () => {
    on();
    const u = await newUser("bk");
    signOut();
    const s = await baSignIn(u.email, PASSWORD, { "user-agent": "UA-MARKER" });
    const token = jar().get("thakeen_session")!;
    const answers = [await s.json(), await (await ba("/get-session", "GET")).json(), await (await ba("/list-accounts", "GET")).json()];
    for (const a of answers) {
      const keys = keysOf(a);
      for (const k of ["token", "ipAddress", "userAgent", "password", "accessToken", "refreshToken", "idToken"]) expect(keys).not.toContain(k);
      const text = JSON.stringify(a);
      expect(text).not.toContain(token);
      expect(text).not.toContain("UA-MARKER");
      expect(text).not.toContain("$2");
    }
  });

  it("better-auth's own error bodies come back as the legacy codes only", async () => {
    expect(await answer(legacyError(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }))).toEqual({ status: 401, body: { ok: false, error: "invalid" } });
    expect(await answer(legacyError(400, { code: "VALIDATION_ERROR", message: "x" }))).toEqual({ status: 401, body: { ok: false, error: "invalid" } });
    expect(await answer(legacyError(403, { code: "INVALID_ORIGIN" }))).toEqual({ status: 403, body: { ok: false, error: "forbidden" } });
    expect(await answer(legacyError(500, { stack: "secret path" }))).toEqual({ status: 500, body: { ok: false, error: "failed" } });
    const slow = legacyError(429, null);
    expect(slow.status).toBe(429);
    expect(await slow.json()).toEqual({ ok: false, error: "slow_down" });
    // A gate body passes through with only its known fields.
    expect(await answer(legacyError(401, { ok: false, error: "mfa_required", mfa: true, code: "mfa_required", message: "mfa_required" }))).toEqual({ status: 401, body: { ok: false, error: "mfa_required", mfa: true } });
  });
});

describe("rule 3414: Thakeen's rate limits run before better-auth", () => {
  it("both engines share the log-in buckets: the ninth try on one address is refused", async () => {
    on();
    const u = await newUser("rl");
    for (let i = 0; i < 4; i++) expect((await legacySignIn(u.email, "wrong-pass")).status).toBe(401);
    for (let i = 0; i < 4; i++) expect((await baSignIn(u.email, "wrong-pass")).status).toBe(401);
    const res = await baSignIn(u.email);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "slow_down" });
    expect(res.headers.get("retry-after")).toBe("900");
    expect(jar().get("thakeen_session")).toBeUndefined();
    expect((await legacySignIn(u.email)).status).toBe(429);
  });

  it("one IP: twenty tries across both engines", async () => {
    on();
    const ip = "203.0.113.20";
    for (let i = 0; i < 10; i++) await legacySignIn(`ip${i}-${randomBytes(2).toString("hex")}@test.example`, "x", { "x-forwarded-for": ip });
    for (let i = 0; i < 10; i++) await baSignIn(`ipb${i}-${randomBytes(2).toString("hex")}@test.example`, "x", { "x-forwarded-for": ip });
    expect((await baSignIn("fresh@test.example", "x", { "x-forwarded-for": ip })).status).toBe(429);
  });

  it("the read routes have their own per-IP bucket", async () => {
    on();
    const ip = "203.0.113.30";
    await db.incrby(globalKey.rate(globalKey.baReadIpBucket(ip)), 300);
    const res = await ba("/get-session", "GET", undefined, { "x-forwarded-for": ip });
    expect(res.status).toBe(429);
    expect((await ba("/get-session", "GET", undefined, { "x-forwarded-for": "203.0.113.31" })).status).toBe(200);
  });
});
