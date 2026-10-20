import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { codeAt } from "./helpers/staff";
import { softAuthenticator, type AssertionJSON, type SoftAuthenticator } from "./helpers/soft-authenticator";
import { getLogin, getUser, saveUser, sessionIds, sessionKey, type User } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/cookie-names";
import { db } from "@/lib/db";
import { devicesKey } from "@/lib/devices";
import { globalKey, personKey, storedPersonId, type PersonId } from "@/lib/keys";
import type { FinishVia } from "@/lib/login-finish";
import type { Challenge } from "@/lib/mfa";
import { addPasskey, credHash, ensureUid, readSet } from "@/lib/passkeys";
import { PASSKEY_COOKIE, PASSKEY_COOKIE_PATH, setPasskeysOn } from "@/lib/passkey-switch";
import { getPerson } from "@/lib/person";
import { getMember, saveMember } from "@/lib/team";
import { track } from "@/lib/track";
import { appDict } from "@/lib/app-i18n";
import { AUTOFILL_BACKOFF_MS, AUTOFILL_MAX_FAILURES, AUTOFILL_PATIENT_MS, AUTOFILL_REFRESH_MS, LoginForm, nextAutofill, showPasskeyButton } from "@/components/app/AuthForm";
import { PASSKEY_CHALLENGE_TTL } from "@/lib/passkey-limits";
import * as optionsRoute from "@/app/api/auth/passkey/options/route";
import * as verifyRoute from "@/app/api/auth/passkey/verify/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as twoFaRoute from "@/app/api/account/2fa/route";

/**
 * Customer passkeys, task 5: sign in with a passkey (spec docs/specs/2026-10-20-passkeys.md flow C, rules 2403, 2405,
 * 2408, 2409, 2417-2423, 2426, 2429). Real crypto through the real seam (src/lib/webauthn.ts) with the soft
 * authenticator; credentials are registered through the Task 3 store directly. `track` is a passthrough spy.
 */

vi.mock("@/lib/track", async () => {
  const real = await vi.importActual<typeof import("@/lib/track")>("@/lib/track");
  return { ...real, track: vi.fn(real.track) };
});
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const LIVE = "https://thakeen.com";
const RP = "thakeen.com";
const PASSWORD = "abc12345";
const FAILED = { ok: false, error: "passkey_failed" };
let ipN = 0;
const ip = () => ({ "x-forwarded-for": `203.0.113.${(++ipN % 250) + 1}` });
const cookieCalls = () => (globalThis as unknown as { __testCookieCalls: { op: string; name: string; options: Record<string, unknown> }[] }).__testCookieCalls;
const answer = async (r: Response) => ({ status: r.status, body: await r.json() });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** POST /api/auth/passkey/options from `headers`: the cookie lands in the jar; answers the challenge. */
async function begin(headers: Record<string, string> = ip()): Promise<string> {
  const r = await optionsRoute.POST(json("/api/auth/passkey/options", "POST", {}, headers));
  expect(r.status).toBe(200);
  return (await r.json()).options.challenge;
}
const finish = (response: unknown, headers: Record<string, string> = ip()) => verifyRoute.POST(json("/api/auth/passkey/verify", "POST", { response }, headers));

type Key = { soft: SoftAuthenticator; uid: string; pid: PersonId; born: string; email: string };
/** Registers a fresh soft passkey for the login at `email` through the store (as the settings route would). */
async function enrolKey(email: string, counter = 0): Promise<Key> {
  const l = (await getLogin(email))!;
  const pid = l.pid;
  const born = (await getPerson(pid))!.createdAt;
  const u = await ensureUid(pid, born);
  if (u === "invalid") throw new Error("ensureUid answered invalid");
  const soft = softAuthenticator();
  const added = await addPasskey(pid, born, { id: soft.credId, pk: soft.cosePublicKey, counter, transports: ["internal"], aaguid: "00000000-0000-0000-0000-000000000000", backedUp: true }, "Laptop");
  expect(added).toMatchObject({ ok: true });
  return { soft, uid: u.uid, pid, born, email };
}
/** A good assertion for `challenge` from `k`, with any field bent. */
const assert = (k: Key, challenge: string, over: Partial<Parameters<SoftAuthenticator["makeAssertion"]>[0]> = {}, counter = 1): AssertionJSON =>
  k.soft.makeAssertion({ challenge, origin: LIVE, rpId: RP, userHandle: k.uid, counter, ...over });
/** Options then verify with a good assertion. */
async function signInWith(k: Key, over: Partial<Parameters<SoftAuthenticator["makeAssertion"]>[0]> = {}, counter = 1) {
  const h = ip();
  const challenge = await begin(h);
  return finish(assert(k, challenge, over, counter), h);
}
/** The one refusal body (rule 2423), byte for byte. */
async function refused(r: Response) {
  expect(await answer(r)).toEqual({ status: 401, body: FAILED });
}
const setKeys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

async function owner(prefix = "pks", opts: { verified?: boolean } = {}): Promise<User> {
  return newUser(prefix, opts);
}

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", LIVE);
  vi.mocked(track).mockClear();
  cookieCalls().length = 0;
});
afterEach(async () => {
  signOut();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await setPasskeysOn(true);
});

describe("passkey sign-in end to end (flow C)", () => {
  it("signs a verified owner in: the session carries pid and acct, a device row exists, one login is tracked", async () => {
    const u = await owner();
    const k = await enrolKey(u.email);
    const r = await signInWith(k);
    expect(await answer(r)).toEqual({ status: 200, body: { ok: true, verify: false } });
    const token = jar().get(SESSION_COOKIE)!;
    const rec = await db.get<{ email: string; pid?: string; acct?: string }>(sessionKey(token));
    const ids = await sessionIds(u.email);
    expect(rec).toMatchObject({ pid: k.pid, ...(ids.acct ? { acct: ids.acct } : {}) });
    expect(Object.keys(await db.hgetall(devicesKey(u.email)) ?? {})).toHaveLength(1);
    expect(vi.mocked(track).mock.calls).toEqual([[u.email, "login"]]);
  });

  it("the options cookie: thakeen_pk, httpOnly, SameSite=Lax, path /api/auth/passkey, 300 s; the nonce is stored only hashed", async () => {
    await begin();
    const set = cookieCalls().filter((c) => c.op === "set" && c.name === PASSKEY_COOKIE);
    expect(set).toHaveLength(1);
    expect(set[0].options).toMatchObject({ httpOnly: true, sameSite: "lax", path: PASSKEY_COOKIE_PATH, maxAge: 300 });
    const nonce = jar().get(PASSKEY_COOKIE)!;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await db.get(globalKey.passkeyAuth(sha256(nonce)))).toMatchObject({ challenge: expect.any(String), at: expect.any(Number) });
    expect(await db.get(globalKey.passkeyAuth(nonce))).toBeNull();
  });

  it("an owner who has not proved the address gets the password path's verify flag", async () => {
    const u = await owner("pku", { verified: false });
    const k = await enrolKey(u.email);
    expect(await answer(await signInWith(k))).toEqual({ status: 200, body: { ok: true, verify: true } });
  });
});

describe("rule 2405: the credential leads to the person, never the other way round", () => {
  it("an orphaned reverse entry (set deleted), an entry naming another pid, and a pid whose login is someone else's: 401, no session", async () => {
    const a = await owner("pko");
    const ka = await enrolKey(a.email);
    // 1. Orphaned: the set is gone, the reverse entry stays.
    await db.del(personKey.passkeys(ka.pid));
    // 2. A reverse entry naming B while the credential sits in A's set.
    const b = await owner("pkb");
    const c = await owner("pkc");
    const kb = await enrolKey(b.email);
    const kc = await enrolKey(c.email);
    await db.set(globalKey.passkeyCred(credHash(kb.soft.credId)), kc.pid);
    // 3. A person row whose address belongs to another login: getLogin(person.email).pid differs.
    const d = await owner("pkd");
    const kd = await enrolKey(d.email);
    const ghost = storedPersonId(`p_${randomBytes(12).toString("hex")}`);
    await db.set(personKey.person(ghost), { pid: ghost, email: d.email, name: "", lang: "ar", createdAt: kd.born });
    const gu = await ensureUid(ghost, kd.born);
    if (gu === "invalid") throw new Error("invalid");
    const gsoft = softAuthenticator();
    expect(await addPasskey(ghost, kd.born, { id: gsoft.credId, pk: gsoft.cosePublicKey, counter: 0, transports: ["internal"], aaguid: "00000000-0000-0000-0000-000000000000", backedUp: true }, "Ghost")).toMatchObject({ ok: true });
    const gk: Key = { soft: gsoft, uid: gu.uid, pid: ghost, born: kd.born, email: d.email };

    const set = vi.spyOn(db, "set");
    for (const k of [ka, kb, gk]) await refused(await signInWith(k));
    expect(setKeys(set).filter((key) => key.startsWith("session:h:"))).toEqual([]);
    expect(jar().get(SESSION_COOKIE)).toBeUndefined();
  });
});

describe("rule 2408: the challenge is single use, lives 300 s, and the cookie is always cleared", () => {
  const cleared = () => cookieCalls().filter((c) => c.op === "delete" && c.name === PASSKEY_COOKIE);

  it("no cookie: 401, and the clear names the cookie's own path", async () => {
    const u = await owner();
    const k = await enrolKey(u.email);
    const h = ip();
    const challenge = await begin(h);
    jar().delete(PASSKEY_COOKIE);
    cookieCalls().length = 0;
    await refused(await finish(assert(k, challenge), h));
    expect(cleared()).toEqual([{ op: "delete", name: PASSKEY_COOKIE, options: { path: PASSKEY_COOKIE_PATH } }]);
  });

  it("replaying the same cookie and response: the second answer is 401", async () => {
    const u = await owner();
    const k = await enrolKey(u.email);
    const h = ip();
    const challenge = await begin(h);
    const nonce = jar().get(PASSKEY_COOKIE)!;
    const response = assert(k, challenge);
    expect((await finish(response, h)).status).toBe(200);
    expect(jar().get(PASSKEY_COOKIE)).toBeUndefined();
    // Taken with GETDEL: the challenge is gone, so the replay fails before the counter is even reached.
    expect(await db.get(globalKey.passkeyAuth(sha256(nonce)))).toBeNull();
    signOut();
    jar().set(PASSKEY_COOKIE, nonce);
    await refused(await finish(response, h));
  });

  it("a challenge older than 300 s is refused, even when the store still holds it", async () => {
    const u = await owner();
    const k = await enrolKey(u.email);
    const nonce = randomBytes(32).toString("base64url");
    const challenge = randomBytes(32).toString("base64url");
    await db.set(globalKey.passkeyAuth(sha256(nonce)), { challenge, at: Date.now() - 301_000 }, 300);
    jar().set(PASSKEY_COOKIE, nonce);
    await refused(await finish(assert(k, challenge)));
    // Taken all the same: single use.
    expect(await db.get(globalKey.passkeyAuth(sha256(nonce)))).toBeNull();
  });

  it("after 301 s on the clock: 401", async () => {
    const u = await owner();
    const k = await enrolKey(u.email);
    const h = ip();
    const challenge = await begin(h);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 301_000);
    await refused(await finish(assert(k, challenge), h));
  });

  it("every outcome clears it: success, refusal, 404 and 429", async () => {
    const u = await owner();
    const k = await enrolKey(u.email);
    cookieCalls().length = 0;
    expect((await signInWith(k)).status).toBe(200);
    expect(cleared()).toHaveLength(1);
    await refused(await finish({}));
    expect(cleared()).toHaveLength(2);
    await setPasskeysOn(false);
    expect((await finish({})).status).toBe(404);
    expect(cleared()).toHaveLength(3);
    await setPasskeysOn(true);
    const h = ip();
    for (let i = 0; i < 20; i++) await finish({}, h);
    const r = await finish({}, h);
    expect(r.status).toBe(429);
    expect(cleared()).toHaveLength(24);
    expect(cleared().every((c) => c.options.path === PASSKEY_COOKIE_PATH)).toBe(true);
  });
});

describe("rules 2409 and 2403 (route halves)", () => {
  it("an assertion without user verification: 401", async () => {
    const u = await owner();
    const k = await enrolKey(u.email);
    await refused(await signInWith(k, { uv: false }));
  });

  it("a user handle that is another person's uid, or none at all: 401", async () => {
    const a = await owner();
    const b = await owner();
    const ka = await enrolKey(a.email);
    const kb = await enrolKey(b.email);
    await refused(await signInWith(ka, { userHandle: kb.uid }));
    await refused(await signInWith(ka, { userHandle: null }));
    expect((await signInWith(ka)).status).toBe(200);
  });
});

describe("rule 2417: the options route", () => {
  it("is limited to 60 per IP per 15 minutes (429 with Retry-After), names no person, and allows any credential", async () => {
    const h = ip();
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) last = await optionsRoute.POST(json("/api/auth/passkey/options", "POST", {}, h));
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBe("900");
    expect(await last!.json()).toEqual({ ok: false, error: "slow_down" });
    const r = await optionsRoute.POST(json("/api/auth/passkey/options", "POST", {}, ip()));
    const { options } = await r.json();
    expect(options.allowCredentials).toEqual([]);
    expect(options.userVerification).toBe("required");
    expect(options.rpId).toBe(RP);
    expect(JSON.stringify(options)).not.toContain("@");
  });
});

describe("rule 2418: the verify route's limits come before any person is read", () => {
  it("the 21st verify from one IP is 429 before any pkcred: read", async () => {
    const u = await owner();
    const k = await enrolKey(u.email);
    const h = ip();
    for (let i = 0; i < 20; i++) await refused(await finish({}, h));
    const challenge = await begin(ip());
    const get = vi.spyOn(db, "get");
    const r = await finish(assert(k, challenge), h);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("900");
    expect(get.mock.calls.map((c) => String(c[0])).filter((key) => key.startsWith("pkcred:") || key.startsWith("person:"))).toEqual([]);
  });

  it("the 11th verify for one credential from varying IPs is 429", async () => {
    const u = await owner();
    const k = await enrolKey(u.email);
    for (let i = 0; i < 10; i++) {
      const h = ip();
      await begin(h);
      // A signature over another challenge: refused after the credential bucket counted it.
      await refused(await finish(assert(k, randomBytes(32).toString("base64url")), h));
    }
    const h = ip();
    const challenge = await begin(h);
    const get = vi.spyOn(db, "get");
    const r = await finish(assert(k, challenge), h);
    expect(r.status).toBe(429);
    expect(get.mock.calls.map((c) => String(c[0])).filter((key) => key.startsWith("pkcred:"))).toEqual([]);
  });
});

describe("rule 2419: every gate of the password path", () => {
  /** The same fixture through POST /api/auth/login and through the passkey: the same answer. */
  async function both(email: string, password = PASSWORD) {
    const k = await enrolKey(email);
    const pw = await answer(await loginRoute.POST(json("/api/auth/login", "POST", { email, password }, ip())));
    signOut();
    const pk = await answer(await signInWith(k));
    signOut();
    return { pw, pk };
  }

  it("a suspended account", async () => {
    const u = await owner();
    await saveUser({ ...(await getUser(u.email))!, suspended: true });
    const { pw, pk } = await both(u.email);
    expect(pw.status).toBe(403);
    expect(pk).toEqual(pw);
  });

  it("a suspended person", async () => {
    const u = await owner();
    const pid = (await getLogin(u.email))!.pid;
    // The person row is written in both fixture modes (a legacy person gets one from its account), so the person-level
    // suspension (rule 2131) is really there and the answer is pinned, not just "both the same".
    const person: Record<string, unknown> = { ...(await getPerson(pid))! };
    delete person.source;
    await db.set(personKey.person(pid), { ...person, suspended: true });
    expect(await db.get(personKey.person(pid))).toMatchObject({ suspended: true });
    const { pw, pk } = await both(u.email);
    expect(pw).toEqual({ status: 403, body: { ok: false, error: "suspended" } });
    expect(pk).toEqual(pw);
  });

  it("an owner who has not proved the address", async () => {
    const u = await owner("pkv", { verified: false });
    const { pw, pk } = await both(u.email);
    expect(pw).toEqual({ status: 200, body: { ok: true, verify: true } });
    expect(pk).toEqual(pw);
  });

  it("a member whose owner has not proved the address", async () => {
    const o = await owner("pkw", { verified: false });
    const m = await newMember(o);
    const { pw, pk } = await both(m.email, m.password);
    expect(pw.status).toBe(403);
    expect(pk).toEqual(pw);
  });

  it("a member paused by the seat limit", async () => {
    const o = await owner();
    // A legacy member record in both fixture modes: `disabled` lives on it, and `loginRefusal` reads it there.
    const m = await newMember(o, "member", "m", { legacy: true });
    await saveMember({ ...(await getMember(m.email))!, disabled: "seats" });
    const { pw, pk } = await both(m.email, m.password);
    expect(pw).toEqual({ status: 403, body: { ok: false, error: "disabled" } });
    expect(pk).toEqual(pw);
  });

  it("a live member signs in, and the session names the member's own pid", async () => {
    const o = await owner();
    const m = await newMember(o);
    const k = await enrolKey(m.email);
    expect(await answer(await signInWith(k))).toEqual({ status: 200, body: { ok: true } });
    const rec = await db.get<{ pid?: string }>(sessionKey(jar().get(SESSION_COOKIE)!));
    expect(rec?.pid).toBe(k.pid);
    expect(vi.mocked(track).mock.calls).toEqual([[o.email, "login"]]);
  });
});

describe("rule 2420: no two-step code after a passkey", () => {
  it("with two-step on, the session is created at once: no mfachal: key, no thakeen_mfa cookie", async () => {
    const u = await owner();
    await signIn(u.email);
    const s = await (await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "start", password: PASSWORD }, ip()))).json();
    expect((await (await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "confirm", code: codeAt(s.secret) }, ip()))).json()).ok).toBe(true);
    signOut();
    // The password path asks for the code.
    expect((await answer(await loginRoute.POST(json("/api/auth/login", "POST", { email: u.email, password: PASSWORD }, ip())))).body).toMatchObject({ error: "mfa_required" });
    signOut();
    const k = await enrolKey(u.email);
    cookieCalls().length = 0;
    const set = vi.spyOn(db, "set");
    expect(await answer(await signInWith(k))).toEqual({ status: 200, body: { ok: true, verify: false } });
    expect(setKeys(set).filter((key) => key.startsWith("mfachal:"))).toEqual([]);
    expect(cookieCalls().filter((c) => c.name === "thakeen_mfa")).toEqual([]);
    expect(jar().get(SESSION_COOKIE)).toBeTruthy();
  });

  it("the types: a passkey always says codeDone, and no two-step challenge can name a passkey", () => {
    const ok: FinishVia = { via: "passkey", codeDone: true };
    // @ts-expect-error a passkey finish must say codeDone: true
    const noCode: FinishVia = { via: "passkey" };
    // @ts-expect-error a two-step challenge is opened for a password or Google only
    const via: Challenge["via"] = "passkey";
    expect([ok.via, noCode.via, via]).toEqual(["passkey", "passkey", "passkey"]);
  });
});

describe("rules 2421 and 2422 (route halves): the counter", () => {
  it("a counter that did not move: 401, one audit row with an 8-hex hash and no id or key, the stored counter stays", async () => {
    const u = await owner();
    const k = await enrolKey(u.email, 5);
    await refused(await signInWith(k, {}, 5));
    const rows = (await db.lrange("admin:log", 0, -1)).map(String).filter((r) => r.includes("passkey.counter_refused") && r.includes(u.email));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain(k.soft.credId);
    expect(rows[0]).not.toContain(k.soft.cosePublicKey);
    const row = JSON.parse(rows[0]);
    expect(row).toMatchObject({ actor: "system", section: "users", action: "passkey.counter_refused", reason: "counter" });
    expect(row.after.cred).toMatch(/^[0-9a-f]{8}$/);
    expect((await readSet(k.pid, k.born))!.creds[0].counter).toBe(5);
    expect(jar().get(SESSION_COOKIE)).toBeUndefined();
  });

  it("a sign-in writes the counter and lastUsedAt with SET XX before the session exists", async () => {
    const u = await owner();
    const k = await enrolKey(u.email, 3);
    const order: string[] = [];
    const realXx = db.setXx.bind(db);
    vi.spyOn(db, "setXx").mockImplementation(async (...a: Parameters<typeof db.setXx>) => {
      order.push(`xx ${String(a[0])}`);
      return realXx(...a);
    });
    const realSet = db.set.bind(db);
    vi.spyOn(db, "set").mockImplementation(async (...a: Parameters<typeof db.set>) => {
      order.push(`set ${String(a[0])}`);
      return realSet(...a);
    });
    expect((await signInWith(k, {}, 9)).status).toBe(200);
    const xx = order.indexOf(`xx ${personKey.passkeys(k.pid)}`);
    const session = order.findIndex((o) => o.startsWith("set session:h:"));
    expect(xx).toBeGreaterThanOrEqual(0);
    expect(session).toBeGreaterThan(xx);
    const c = (await readSet(k.pid, k.born))!.creds[0];
    expect(c.counter).toBe(9);
    expect(c.lastUsedAt).toEqual(expect.any(String));
  });
});

describe("rule 2423: one answer for every failure before finishLogin", () => {
  it("no challenge, a bad body, an unknown credential, a wrong signature, a wrong or missing handle, UV off, a stale counter", async () => {
    const u = await owner();
    const k = await enrolKey(u.email, 2);
    const stranger = softAuthenticator();
    const bodies: Response[] = [];
    bodies.push(await finish(assert(k, randomBytes(32).toString("base64url")))); // no cookie
    let h = ip();
    await begin(h);
    bodies.push(await finish({ nope: true }, h)); // no credential id
    h = ip();
    let ch = await begin(h);
    bodies.push(await finish(stranger.makeAssertion({ challenge: ch, origin: LIVE, rpId: RP, userHandle: k.uid, counter: 3 }), h)); // unknown
    h = ip();
    await begin(h);
    bodies.push(await finish(assert(k, randomBytes(32).toString("base64url"), {}, 3), h)); // wrong challenge signed
    bodies.push(await signInWith(k, { userHandle: randomBytes(32).toString("base64url") }, 3));
    bodies.push(await signInWith(k, { userHandle: null }, 3));
    bodies.push(await signInWith(k, { uv: false }, 3));
    h = ip();
    ch = await begin(h);
    bodies.push(await finish(assert(k, ch, {}, 1), h)); // counter 1 after 2
    const seen = await Promise.all(bodies.map(async (r) => JSON.stringify({ s: r.status, b: await r.json() })));
    expect(new Set(seen)).toEqual(new Set([JSON.stringify({ s: 401, b: FAILED })]));
    expect(seen).toHaveLength(8);
  });
});

describe("rule 2426 (sign-in half): the off switch", () => {
  it("both routes answer 404 unavailable, and no challenge is stored", async () => {
    await setPasskeysOn(false);
    const set = vi.spyOn(db, "set");
    expect(await answer(await optionsRoute.POST(json("/api/auth/passkey/options", "POST", {}, ip())))).toEqual({ status: 404, body: { ok: false, error: "unavailable" } });
    expect(await answer(await finish({}))).toEqual({ status: 404, body: { ok: false, error: "unavailable" } });
    expect(setKeys(set).filter((key) => key.startsWith("pkauth:"))).toEqual([]);
    expect(jar().get(PASSKEY_COOKIE)).toBeUndefined();
  });

  it("the button is drawn only with passkeys on and WebAuthn known to work", () => {
    expect(showPasskeyButton(true, true)).toBe(true);
    expect(showPasskeyButton(false, true)).toBe(false);
    expect(showPasskeyButton(true, false)).toBe(false);
    expect(showPasskeyButton(true, null)).toBe(false);
    expect(showPasskeyButton(false, null)).toBe(false);
  });

  it("the log-in form: no button in server HTML, and the address field offers passkeys only when they are on", () => {
    for (const lang of ["ar", "en"] as const) {
      const off = renderToStaticMarkup(createElement(LoginForm, { t: appDict[lang], lang, passkeys: false }));
      const on = renderToStaticMarkup(createElement(LoginForm, { t: appDict[lang], lang, passkeys: true }));
      expect(off).toContain('autoComplete="username"');
      expect(off).not.toContain("webauthn");
      expect(on).toContain('autoComplete="username webauthn"');
      for (const html of [off, on]) expect(html).not.toContain(appDict[lang].login.passkey);
    }
  });
});

describe("rule 2426 (sign-in half): the autofill is armed again after it settles", () => {
  it("a sign-in re-arms nothing and clears the count", () => {
    expect(nextAutofill(2, true, 1_000)).toEqual({ failures: 0, rearmIn: null });
    expect(nextAutofill(0, true, 100_000)).toEqual({ failures: 0, rearmIn: null });
  });

  it("quick failures in a row back off, doubling, and stop at the limit: never a tight loop", () => {
    let failures = 0;
    const waits: (number | null)[] = [];
    for (let i = 0; i < AUTOFILL_MAX_FAILURES + 2; i++) {
      const step = nextAutofill(failures, false, 0);
      failures = step.failures;
      waits.push(step.rearmIn);
      if (step.rearmIn === null) break;
    }
    expect(waits).toEqual([AUTOFILL_BACKOFF_MS, AUTOFILL_BACKOFF_MS * 2, null]);
    expect(AUTOFILL_MAX_FAILURES).toBe(3);
    expect(AUTOFILL_BACKOFF_MS).toBeGreaterThanOrEqual(1_000);
    for (const w of waits) if (w !== null) expect(w).toBeGreaterThan(0);
  });

  it("a ceremony that waited (the person, or the browser's own timeout) starts the count again", () => {
    expect(nextAutofill(2, false, AUTOFILL_PATIENT_MS)).toEqual({ failures: 1, rearmIn: AUTOFILL_BACKOFF_MS });
    expect(nextAutofill(2, false, AUTOFILL_PATIENT_MS - 1)).toEqual({ failures: 3, rearmIn: null });
  });

  it("the refresh comes before the challenge and its cookie expire", () => {
    expect(AUTOFILL_REFRESH_MS).toBeLessThan(PASSKEY_CHALLENGE_TTL * 1000);
    expect(AUTOFILL_REFRESH_MS).toBeGreaterThanOrEqual(PASSKEY_CHALLENGE_TTL * 1000 - 60_000);
  });

  it("the effect re-arms on a counter, refreshes on a timer, and its cleanup cancels the options call and the ceremony", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    const effect = src.slice(src.indexOf("useEffect(() => {\n    if (!passkeys"), src.indexOf("}, [passkeys, mfa, busy, leaving, arm]);"));
    expect(effect).toContain("setTimeout(again, AUTOFILL_REFRESH_MS)");
    expect(effect).toContain("new AbortController()");
    expect(effect).toMatch(/return \(\) => \{[^}]*live = false;[^}]*options\.abort\(\);[^}]*WebAuthnAbortService\.cancelCeremony\(\);/);
    // `live` is checked after every await of the run.
    expect(effect).toMatch(/await browserSupportsWebAuthnAutofill\(\);\s*if \(!live\) return;/);
    expect(effect).toMatch(/const settle = [\s\S]*?=> \{\s*if \(!live\) return;/);
    // The button's `finally` arms it again.
    const button = src.slice(src.indexOf("async function onPasskey()"), src.indexOf("const onAutofill"));
    expect(button).toMatch(/finally \{[^}]*setArm\(\(n\) => n \+ 1\);/);
  });
});

describe("rule 2429 (log-in half): the strings", () => {
  it("exist in Arabic and English and claim nothing", () => {
    for (const lang of ["ar", "en"] as const) {
      expect(appDict[lang].login.passkey.length).toBeGreaterThan(3);
      expect(appDict[lang].login.passkeyFailed.length).toBeGreaterThan(10);
    }
    expect(appDict.en.login.passkey).toBe("Sign in with a passkey");
    expect(appDict.ar.login.passkey).toContain("مفتاح مرور");
  });
});
