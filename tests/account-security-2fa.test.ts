import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { codeAt } from "./helpers/staff";
import { currentUser, getUser, saveUser, sessionRecord } from "@/lib/auth";
import { db } from "@/lib/db";
import { CHALLENGE_TRIES, MFA_COOKIE, MFA_LABEL, mfaKey, mfaRecoveryHash, type MfaEnrolment } from "@/lib/mfa";
import { openStaffSecret, openWithLabel, sealWithLabel, staffRecoveryHash } from "@/lib/staff";
import { MIN_ROLE, IMPERSONATION_BLOCKED } from "@/lib/roles";
import * as loginRoute from "@/app/api/auth/login/route";
import * as mfaRoute from "@/app/api/auth/login/mfa/route";
import * as twoFaRoute from "@/app/api/account/2fa/route";

/**
 * Customer two-step sign-in (rules 1930-1937, docs/system/tests/1930-account-security.md). Built from the staff code:
 * the same TOTP, the same sealed-secret keyring and hashed recovery codes, each under its own label.
 */
const read = (f: string) => readFileSync(f, "utf8");
let ipN = 0;
const ip = () => ({ "x-forwarded-for": `198.51.100.${(++ipN % 250) + 1}` });
const twoFa = (body: Record<string, unknown>) => twoFaRoute.POST(json("/api/account/2fa", "POST", body, ip()));
const login = (email: string, password = "abc12345") => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, ip()));
const code = (c: string) => mfaRoute.POST(json("/api/auth/login/mfa", "POST", { code: c }, ip()));
const STEP = 30_000;

beforeAll(() => { vi.stubEnv("CONNECT_SECRET", "mfa-connect-secret-one"); });
afterEach(() => { signOut(); vi.useRealTimers(); });

/** Turn two-step sign-in on for the signed-in login; returns the secret and the recovery codes. */
async function enrol(password = "abc12345"): Promise<{ secret: string; codes: string[] }> {
  const s = await (await twoFa({ action: "start", password })).json();
  expect(s.ok).toBe(true);
  const c = await (await twoFa({ action: "confirm", code: codeAt(s.secret) })).json();
  expect(c.ok).toBe(true);
  return { secret: s.secret, codes: c.codes };
}

describe("rule 1930: setup needs the password, then a code from the new secret; nothing is on before the code", () => {
  it("start, confirm, status", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    expect((await twoFa({ action: "start", password: "wrong-pass" })).status).toBe(401);
    const s = await (await twoFa({ action: "start", password: "abc12345" })).json();
    expect(s.uri).toMatch(/^otpauth:\/\/totp\/Thakeen%3A.*issuer=Thakeen/);
    // Started but not confirmed: still off, and a password alone still signs in.
    expect((await (await twoFaRoute.GET()).json()).enabled).toBe(false);
    expect((await twoFa({ action: "confirm", code: "000000" })).status).toBe(400);
    const c = await (await twoFa({ action: "confirm", code: codeAt(s.secret) })).json();
    expect(c.codes).toHaveLength(8);
    const st = await (await twoFaRoute.GET()).json();
    expect(st).toMatchObject({ ok: true, enabled: true, recoveryLeft: 8, recommended: true });
    expect((await twoFa({ action: "start", password: "abc12345" })).status).toBe(409);
  });

  it("a member is offered it too, without the owner recommendation", async () => {
    const owner = await newUser("mfa");
    const m = await newMember(owner);
    await signIn(m.email);
    expect((await (await twoFaRoute.GET()).json()).recommended).toBe(false);
    await enrol(m.password);
    expect(await db.get(mfaKey(m.email))).toBeTruthy();
    expect(await db.get(mfaKey(owner.email))).toBeNull();
  });
});

describe("rule 1931: the stored record never holds the secret or a recovery code in the clear, and labels never cross", () => {
  it("sealed under its own label; recovery codes hashed under their own label", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    const { secret, codes } = await enrol();
    const rec = (await db.get<MfaEnrolment>(mfaKey(u.email)))!;
    const raw = JSON.stringify(rec);
    expect(raw).not.toContain(secret);
    for (const c of codes) expect(raw).not.toContain(c);
    expect(openWithLabel(MFA_LABEL, rec)?.secret).toBe(secret);
    // A customer blob never opens as a staff secret, and a customer code's hash is not the staff hash.
    expect(openStaffSecret(rec)).toBeNull();
    expect(rec.rc).toContain(mfaRecoveryHash(codes[0]));
    expect(rec.rc).not.toContain(staffRecoveryHash(codes[0]));
  });
});

describe("rule 1932: the password alone opens no session when two-step sign-in is on", () => {
  it("login answers mfa_required with a challenge cookie and no session; the right code signs in", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    const { secret } = await enrol();
    signOut();
    const r = await login(u.email);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ ok: false, error: "mfa_required", mfa: true });
    expect(jar().get("thakeen_session")).toBeUndefined();
    expect(jar().get(MFA_COOKIE)).toBeTruthy();
    expect(await currentUser()).toBeNull();
    const ok = await code(codeAt(secret, Date.now() + STEP));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, verify: false });
    expect(jar().get(MFA_COOKIE)).toBeUndefined();
    expect((await currentUser())?.email).toBe(u.email);
  });

  it("a code is good once: the same code on a second sign-in is refused", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    const { secret } = await enrol();
    signOut();
    const c = codeAt(secret, Date.now() + STEP);
    await login(u.email);
    expect((await code(c)).status).toBe(200);
    signOut();
    await login(u.email);
    expect((await code(c)).status).toBe(400);
  });

  it("a wrong password never reaches the code step", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    await enrol();
    signOut();
    expect(await (await login(u.email, "wrong-pass")).json()).toMatchObject({ error: "invalid" });
    expect(jar().get(MFA_COOKIE)).toBeUndefined();
  });

  it("without a challenge the code route answers mfa_expired", async () => {
    expect(await (await code("123456")).json()).toMatchObject({ error: "mfa_expired" });
  });
});

describe("rule 1933: recovery codes work once each, on the code step", () => {
  it("one code signs in, then is spent", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    const { codes } = await enrol();
    signOut();
    await login(u.email);
    const r = await code(codes[3].toLowerCase().replace(/(.{5})/g, "$1-"));
    expect(r.status).toBe(200);
    expect((await r.json()).recoveryLeft).toBe(7);
    signOut();
    await login(u.email);
    expect((await code(codes[3])).status).toBe(400);
    expect((await db.get<MfaEnrolment>(mfaKey(u.email)))!.rc).toHaveLength(7);
  });
});

describe("rule 1934: the challenge is short, single use and drops after five wrong codes; refusals run again", () => {
  it("five wrong codes end the challenge", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    const { secret } = await enrol();
    signOut();
    await login(u.email);
    for (let i = 0; i < CHALLENGE_TRIES; i++) expect((await code("000000")).status).toBe(400);
    expect(await (await code(codeAt(secret, Date.now() + STEP))).json()).toMatchObject({ error: "mfa_expired" });
  });

  it("an account suspended between the password and the code gets no session", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    const { secret } = await enrol();
    signOut();
    await login(u.email);
    const x = (await getUser(u.email))!;
    x.suspended = true;
    await saveUser(x);
    const r = await code(codeAt(secret, Date.now() + STEP));
    expect(r.status).toBe(403);
    expect(jar().get("thakeen_session")).toBeUndefined();
  });

  it("the challenge expires after five minutes", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    const { secret } = await enrol();
    signOut();
    await login(u.email);
    vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ["Date"] });
    expect(await (await code(codeAt(secret))).json()).toMatchObject({ error: "mfa_expired" });
  });

  it("login and the code step share src/lib/login-finish.ts, and the code step takes the login rate limits", () => {
    const route = read("src/app/api/auth/login/route.ts");
    expect(route).toContain("finishLogin(login!, { via: \"password\" })");
    expect(route).not.toContain("createSession");
    const mfa = read("src/app/api/auth/login/mfa/route.ts");
    expect(mfa).toMatch(/allow\(`login:ip:\$\{clientIp\(req\)\}`, 20, 900\)/);
    expect(mfa).toMatch(/allow\(`login:em:\$\{ch\.email\}`, 8, 900\)/);
    expect(mfa.indexOf("takeChallenge(id)")).toBeLessThan(mfa.indexOf("finishLogin(login"));
    expect(read("src/lib/mfa.ts")).toContain("withLoginLock(login");
  });
});

describe("rule 1935: an enrolment older than the login record is ignored", () => {
  it("a re-registered address never inherits the old authenticator", async () => {
    const u = await newUser("mfa");
    await db.set(mfaKey(u.email), { ...sealWithLabel(MFA_LABEL, "JBSWY3DPEHPK3PXP"), rc: [], at: new Date(Date.parse(u.createdAt) - 60_000).toISOString() } satisfies MfaEnrolment);
    const r = await login(u.email);
    expect(r.status).toBe(200);
    expect(jar().get("thakeen_session")).toBeTruthy();
  });
});

describe("rule 1936: turning it off needs the password and a code; new recovery codes need the app's code", () => {
  it("disable with a recovery code; renew refuses a recovery code", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    const { secret, codes } = await enrol();
    expect((await twoFa({ action: "recovery", password: "abc12345", code: codes[0] })).status).toBe(400);
    const renewed = await (await twoFa({ action: "recovery", password: "abc12345", code: codeAt(secret, Date.now() + STEP) })).json();
    expect(renewed.codes).toHaveLength(8);
    expect(renewed.codes).not.toContain(codes[1]);
    expect((await twoFa({ action: "disable", password: "wrong-pass", code: renewed.codes[0] })).status).toBe(401);
    expect((await twoFa({ action: "disable", password: "abc12345", code: renewed.codes[0] })).status).toBe(200);
    expect(await db.get(mfaKey(u.email))).toBeNull();
    signOut();
    expect((await login(u.email)).status).toBe(200);
  });
});

describe("rule 1937: a founder impersonating can neither see a way to nor change two-step sign-in", () => {
  it("mfa.manage is open to every role (Viewer up, rule 3752) and impersonation-blocked; the route refuses an impersonation", async () => {
    expect(MIN_ROLE["mfa.manage"]).toBe("viewer");
    expect(IMPERSONATION_BLOCKED.has("mfa.manage")).toBe(true);
    vi.stubEnv("ADMIN_EMAILS", "founder-mfa@test.example");
    const u = await newUser("mfa");
    await signIn(u.email, { imp: "founder-mfa@test.example" });
    expect((await twoFa({ action: "start", password: "abc12345" })).status).toBe(403);
    expect((await twoFaRoute.GET()).status).toBe(403);
    vi.unstubAllEnvs();
    vi.stubEnv("CONNECT_SECRET", "mfa-connect-secret-one");
  });

  it("a session record is never written for a password-only proof", async () => {
    const u = await newUser("mfa");
    await signIn(u.email);
    await enrol();
    const before = jar().get("thakeen_session")!;
    signOut();
    await login(u.email);
    expect(jar().get("thakeen_session")).toBeUndefined();
    expect(await sessionRecord(before)).toBeTruthy();
  });
});
