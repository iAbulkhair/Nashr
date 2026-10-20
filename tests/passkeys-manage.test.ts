import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { codeAt } from "./helpers/staff";
import { softAuthenticator } from "./helpers/soft-authenticator";
import { currentUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { accountKey, globalKey, personKey, type PersonId } from "@/lib/keys";
import { createMcpToken } from "@/lib/mcp";
import { actingLogin } from "@/lib/own-password";
import { addPasskey, credHash, readSet } from "@/lib/passkeys";
import { setPasskeysOn } from "@/lib/passkey-switch";
import { updatePerson } from "@/lib/person";
import { resolveGoogle } from "@/lib/google-signin";
import { IMPERSONATION_BLOCKED, MIN_ROLE } from "@/lib/roles";
import { appDict } from "@/lib/app-i18n";
import { COPY } from "@/emails/copy";
import { sendEmail, type TemplateMail } from "@/lib/notify";
import { verifyRegistration, type RegisteredCred } from "@/lib/webauthn";
import PasskeySettings, { deviceLabel, showAddButton, showPasskeyCard } from "@/components/app/settings/PasskeySettings";
import * as route from "@/app/api/account/passkeys/route";
import * as twoFaRoute from "@/app/api/account/2fa/route";
import * as loginRoute from "@/app/api/auth/login/route";

/**
 * Customer passkeys, task 4: the security settings routes (GET/POST /api/account/passkeys), fresh re-authentication, the
 * notice email and the card (spec docs/specs/2026-10-20-passkeys.md flows A and B, rules 2400, 2407, 2410-2415, 2426,
 * 2429). The seam is a passthrough mock (pre-flight ruling 14): `verifyRegistration` is the real one unless a test
 * overrides one call with `mockResolvedValueOnce`, so the end-to-end case below runs real crypto through the real seam.
 */

const mail = vi.hoisted(() => ({ sent: [] as unknown[], fail: false, refuse: false }));
vi.mock("@/lib/notify", async () => {
  const real = await vi.importActual<typeof import("@/lib/notify")>("@/lib/notify");
  return {
    ...real,
    sendEmail: vi.fn(async (m: unknown) => {
      if (mail.fail) throw new Error("mail down");
      if (mail.refuse) return false;
      mail.sent.push(m);
      return true;
    }),
  };
});
vi.mock("@/lib/webauthn", async () => {
  const real = await vi.importActual<typeof import("@/lib/webauthn")>("@/lib/webauthn");
  return { ...real, verifyRegistration: vi.fn(real.verifyRegistration) };
});

const LIVE = "https://thakeen.com";
const PASSWORD = "abc12345";
let ipN = 0;
const ip = () => ({ "x-forwarded-for": `198.51.100.${(++ipN % 250) + 1}` });
const post = (body: unknown, headers: Record<string, string> = {}) => route.POST(json("/api/account/passkeys", "POST", body, { ...ip(), ...headers }));
const list = () => route.GET();
const answer = async (r: Response) => ({ status: r.status, body: await r.json() });
const twoFa = (body: Record<string, unknown>) => twoFaRoute.POST(json("/api/account/2fa", "POST", body, ip()));

const fakeCred = (over: Partial<RegisteredCred> = {}): RegisteredCred => ({
  id: randomBytes(32).toString("base64url"),
  pk: randomBytes(77).toString("base64url"),
  counter: 0,
  transports: ["internal"],
  aaguid: "00000000-0000-0000-0000-000000000000",
  backedUp: true,
  ...over,
});

/** The signed-in acting login: its pid and the person's birth, as the route reads them. */
async function me(): Promise<{ pid: PersonId; born: string }> {
  const u = (await currentUser())!;
  const a = (await actingLogin(u))!;
  const { getPerson } = await import("@/lib/person");
  return { pid: a.pid, born: (await getPerson(a.pid))!.createdAt };
}

/** Open a registration with `proof`, then verify one fake credential through a one-call seam override. */
async function add(name = "My laptop", proof: Record<string, unknown> = { password: PASSWORD }, cred = fakeCred()) {
  const o = await post({ action: "register-options", ...proof });
  expect(o.status).toBe(200);
  vi.mocked(verifyRegistration).mockResolvedValueOnce({ ok: true, cred });
  return { res: await post({ action: "register-verify", response: { id: cred.id }, name }), cred };
}

async function owner(prefix = "pk"): Promise<User> {
  const u = await newUser(prefix);
  await signIn(u.email);
  return u;
}

/** Turn two-step sign-in on for the signed-in login; returns the secret and the recovery codes. */
async function enrol(password = PASSWORD): Promise<{ secret: string; codes: string[] }> {
  const s = await (await twoFa({ action: "start", password })).json();
  const c = await (await twoFa({ action: "confirm", code: codeAt(s.secret) })).json();
  expect(c.ok).toBe(true);
  return { secret: s.secret, codes: c.codes };
}

beforeAll(() => { vi.stubEnv("CONNECT_SECRET", "passkeys-connect-secret-one"); });
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", LIVE);
  mail.sent.length = 0;
  mail.fail = false;
  mail.refuse = false;
});
afterEach(async () => {
  signOut();
  vi.useRealTimers();
  vi.mocked(verifyRegistration).mockReset();
  vi.mocked(verifyRegistration).mockImplementation((await vi.importActual<typeof import("@/lib/webauthn")>("@/lib/webauthn")).verifyRegistration);
  await setPasskeysOn(true);
});

describe("flows A and B: add, list, rename, remove", () => {
  it("an owner adds a passkey with the password; the list shows it; rename and remove work", async () => {
    await owner();
    expect(await answer(await list())).toEqual({ status: 200, body: { ok: true, items: [], max: 10, enabled: true, proof: "password" } });
    const { res } = await add("My laptop");
    const added = await answer(res);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ ok: true, item: { name: "My laptop", synced: true, transports: ["internal"] } });
    const ref = added.body.item.ref as string;
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    const l = await answer(await list());
    expect(l.body.items.map((i: { ref: string }) => i.ref)).toEqual([ref]);
    expect(await answer(await post({ action: "rename", ref, name: "Work laptop" }))).toEqual({ status: 200, body: { ok: true } });
    expect((await answer(await list())).body.items[0].name).toBe("Work laptop");
    expect(await answer(await post({ action: "remove", ref, password: PASSWORD }))).toEqual({ status: 200, body: { ok: true } });
    expect((await answer(await list())).body.items).toEqual([]);
  });

  it("an unknown action, a malformed ref or a body that is not an object is 400 bad_request", async () => {
    await owner();
    expect(await answer(await post({ action: "sign-in" }))).toEqual({ status: 400, body: { ok: false, error: "bad_request" } });
    expect(await answer(await post({ action: "rename", ref: "../x", name: "A" }))).toEqual({ status: 400, body: { ok: false, error: "bad_request" } });
    expect(await answer(await post("nope"))).toEqual({ status: 400, body: { ok: false, error: "bad_request" } });
  });

  it("a response the seam refuses is 400 invalid and stores nothing; a bad name is 400 invalid", async () => {
    await owner();
    expect((await post({ action: "register-options", password: PASSWORD })).status).toBe(200);
    expect(await answer(await post({ action: "register-verify", response: { id: "x" }, name: "A" }))).toEqual({ status: 400, body: { ok: false, error: "invalid" } });
    expect((await answer(await list())).body.items).toEqual([]);
    const { res } = await add("\u0000‮ ");
    expect(await answer(res)).toEqual({ status: 400, body: { ok: false, error: "invalid" } });
    const { res: ok } = await add("Phone");
    const ref = (await ok.json()).item.ref;
    expect(await answer(await post({ action: "rename", ref, name: "   " }))).toEqual({ status: 400, body: { ok: false, error: "invalid" } });
  });

  it("the eleventh passkey is refused with 409 limit before any proof is asked", async () => {
    await owner();
    const { pid, born } = await me();
    for (let i = 0; i < 10; i++) expect(await addPasskey(pid, born, fakeCred(), `Key ${i}`)).toMatchObject({ ok: true });
    expect(await answer(await post({ action: "register-options" }))).toEqual({ status: 409, body: { ok: false, error: "limit" } });
    expect(await db.get(personKey.passkeyReg(pid))).toBeNull();
  });

  it("a credential id another person holds is 409 credential_taken and nothing is stored", async () => {
    await owner("pka");
    const cred = fakeCred();
    expect((await add("A", { password: PASSWORD }, cred)).res.status).toBe(200);
    await owner("pkb");
    const { pid } = await me();
    expect(await answer((await add("B", { password: PASSWORD }, { ...fakeCred(), id: cred.id })).res)).toEqual({ status: 409, body: { ok: false, error: "credential_taken" } });
    expect((await answer(await list())).body.items).toEqual([]);
    expect(String(await db.get(globalKey.passkeyCred(credHash(cred.id))))).not.toBe(pid);
  });

  it("a held person lock answers 409 busy (rule 2414)", async () => {
    await owner();
    const { res } = await add("A");
    const ref = (await res.json()).item.ref;
    const { pid } = await me();
    await db.lock(personKey.lock(pid), 10);
    try {
      expect(await answer(await post({ action: "rename", ref, name: "B" }))).toEqual({ status: 409, body: { ok: false, error: "busy" } });
      expect(await answer(await post({ action: "remove", ref, password: PASSWORD }))).toEqual({ status: 409, body: { ok: false, error: "busy" } });
    } finally {
      await db.unlock(personKey.lock(pid));
    }
    expect((await answer(await list())).body.items[0].name).toBe("A");
  }, 30_000);

  it("end to end: a software authenticator registers through the real seam", async () => {
    await owner();
    const o = await answer(await post({ action: "register-options", password: PASSWORD }));
    expect(o.status).toBe(200);
    const opts = o.body.options;
    expect(opts.rp).toEqual({ id: "thakeen.com", name: "Thakeen" });
    expect(opts.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    const { pid, born } = await me();
    expect(opts.user.id).toBe((await readSet(pid, born))!.uid);
    const auth = softAuthenticator();
    const response = auth.makeAttestation({ challenge: opts.challenge, origin: LIVE, rpId: "thakeen.com", userHandle: opts.user.id });
    const v = await answer(await post({ action: "register-verify", response, name: "Soft key" }));
    expect(v).toMatchObject({ status: 200, body: { ok: true, item: { name: "Soft key" } } });
    const set = (await readSet(pid, born))!;
    expect(set.creds.map((c) => c.id)).toEqual([auth.credId]);
    expect(set.creds[0].pk).toBe(auth.cosePublicKey);
    expect(String(await db.get(globalKey.passkeyCred(credHash(auth.credId))))).toBe(pid);
    // The second registration excludes the first credential.
    const again = await answer(await post({ action: "register-options", password: PASSWORD }));
    expect(again.body.options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([auth.credId]);
  });
});

describe("rule 2407: the registration challenge is single-use, 300 s, bound to the session that opened it", () => {
  it("a verify from a second session of the same person is 410 expired, and the challenge is gone", async () => {
    const u = await owner();
    const { pid } = await me();
    expect((await post({ action: "register-options", password: PASSWORD })).status).toBe(200);
    const stored = await db.get<{ sess: string }>(personKey.passkeyReg(pid));
    expect(stored?.sess).toMatch(/^[0-9a-f]{64}$/);
    await signIn(u.email);
    vi.mocked(verifyRegistration).mockResolvedValueOnce({ ok: true, cred: fakeCred() });
    expect(await answer(await post({ action: "register-verify", response: {}, name: "A" }))).toEqual({ status: 410, body: { ok: false, error: "expired" } });
    expect(await db.get(personKey.passkeyReg(pid))).toBeNull();
    expect((await answer(await list())).body.items).toEqual([]);
  });

  it("a second verify with the same response is 410 expired", async () => {
    await owner();
    const { pid } = await me();
    const { res, cred } = await add("A");
    expect(res.status).toBe(200);
    expect(await db.get(personKey.passkeyReg(pid))).toBeNull();
    vi.mocked(verifyRegistration).mockResolvedValueOnce({ ok: true, cred });
    expect(await answer(await post({ action: "register-verify", response: { id: cred.id }, name: "A" }))).toEqual({ status: 410, body: { ok: false, error: "expired" } });
    expect(await db.get(personKey.passkeyReg(pid))).toBeNull();
  });

  it("a verify after 301 s is 410 expired", async () => {
    await owner();
    const { pid } = await me();
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await post({ action: "register-options", password: PASSWORD })).status).toBe(200);
    vi.setSystemTime(Date.now() + 301_000);
    vi.mocked(verifyRegistration).mockResolvedValueOnce({ ok: true, cred: fakeCred() });
    expect(await answer(await post({ action: "register-verify", response: {}, name: "A" }))).toEqual({ status: 410, body: { ok: false, error: "expired" } });
    expect(await db.get(personKey.passkeyReg(pid))).toBeNull();
  });

  it("a challenge whose stamp is older than 300 s is 410 expired even while the key lives", async () => {
    await owner();
    const { pid } = await me();
    expect((await post({ action: "register-options", password: PASSWORD })).status).toBe(200);
    const ch = (await db.get<{ challenge: string; sess: string; at: number }>(personKey.passkeyReg(pid)))!;
    await db.set(personKey.passkeyReg(pid), { ...ch, at: Date.now() - 300_001 }, 300);
    vi.mocked(verifyRegistration).mockResolvedValueOnce({ ok: true, cred: fakeCred() });
    expect(await answer(await post({ action: "register-verify", response: {}, name: "A" }))).toEqual({ status: 410, body: { ok: false, error: "expired" } });
    expect(await db.get(personKey.passkeyReg(pid))).toBeNull();
  });

  it("no open challenge is 410 expired", async () => {
    await owner();
    expect(await answer(await post({ action: "register-verify", response: {}, name: "A" }))).toEqual({ status: 410, body: { ok: false, error: "expired" } });
  });
});

describe("rule 2410: adding needs the password, or a code when two-step is on, counted in pkpw:{login}", () => {
  it("no proof or a wrong password is 401 wrong_password and opens no challenge", async () => {
    await owner();
    const { pid } = await me();
    expect(await answer(await post({ action: "register-options" }))).toEqual({ status: 401, body: { ok: false, error: "wrong_password" } });
    expect(await answer(await post({ action: "register-options", password: "wrong-pass" }))).toEqual({ status: 401, body: { ok: false, error: "wrong_password" } });
    expect(await db.get(personKey.passkeyReg(pid))).toBeNull();
  });

  it("with two-step on the password alone is refused; a TOTP code or a recovery code is accepted", async () => {
    const u = await owner();
    const { secret, codes } = await enrol();
    expect((await answer(await list())).body.proof).toBe("code");
    expect(await answer(await post({ action: "register-options", password: PASSWORD }))).toEqual({ status: 400, body: { ok: false, error: "bad_code" } });
    expect(await answer(await post({ action: "register-options", code: "000000" }))).toEqual({ status: 400, body: { ok: false, error: "bad_code" } });
    // The enrolment burned this step's code: take the next step's.
    expect((await post({ action: "register-options", code: codeAt(secret, Date.now() + 30_000) })).status).toBe(200);
    expect((await post({ action: "register-options", code: codes[0] })).status).toBe(200);
    expect(u.email).toBeTruthy();
  });

  it("a recovery code works once: the same code again is 400 bad_code", async () => {
    await owner();
    const { codes } = await enrol();
    expect((await post({ action: "register-options", code: codes[0] })).status).toBe(200);
    expect(await answer(await post({ action: "register-options", code: codes[0] }))).toEqual({ status: 400, body: { ok: false, error: "bad_code" } });
    const ref = (await (await add("A", { code: codes[1] })).res.json()).item.ref;
    expect(await answer(await post({ action: "remove", ref, code: codes[1] }))).toEqual({ status: 400, body: { ok: false, error: "bad_code" } });
    expect((await answer(await list())).body.items).toHaveLength(1);
  });

  it("the eleventh wrong proof in an hour is 429 slow_down with Retry-After, even with the right password", async () => {
    const u = await owner();
    for (let i = 0; i < 10; i++) expect((await post({ action: "register-options", password: `wrong-${i}` })).status).toBe(401);
    const r = await post({ action: "register-options", password: PASSWORD });
    expect(await answer(r.clone())).toEqual({ status: 429, body: { ok: false, error: "slow_down" } });
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await db.get(`rate:${accountKey.passkeyProofBucket(u.email)}`)).toBeTruthy();
  });

  it("a right proof gives its try back", async () => {
    await owner();
    for (let i = 0; i < 9; i++) expect((await post({ action: "register-options", password: `wrong-${i}` })).status).toBe(401);
    expect((await post({ action: "register-options", password: PASSWORD })).status).toBe(200);
    // Ten counted wrong ones would refuse this try; the right one was handed back, so it is still a plain 401.
    expect((await post({ action: "register-options", password: "wrong-x" })).status).toBe(401);
    expect((await post({ action: "register-options", password: "wrong-y" })).status).toBe(429);
  });
});

describe("rule 2411: remove needs the proof, rename only the session; no password and no two-step is reauth_unavailable", () => {
  it("remove without a proof is refused and keeps the passkey; rename without one works", async () => {
    await owner();
    const ref = (await (await add("A")).res.json()).item.ref;
    expect(await answer(await post({ action: "remove", ref }))).toEqual({ status: 401, body: { ok: false, error: "wrong_password" } });
    expect(await answer(await post({ action: "remove", ref, password: "wrong-pass" }))).toEqual({ status: 401, body: { ok: false, error: "wrong_password" } });
    expect((await answer(await list())).body.items).toHaveLength(1);
    expect((await post({ action: "rename", ref, name: "B" })).status).toBe(200);
  });

  it("with two-step on, remove takes a code", async () => {
    await owner();
    const ref = (await (await add("A")).res.json()).item.ref;
    const { codes } = await enrol();
    expect((await post({ action: "remove", ref, password: PASSWORD })).status).toBe(400);
    expect((await post({ action: "remove", ref, code: codes[1] })).status).toBe(200);
    expect((await answer(await list())).body.items).toEqual([]);
  });

  it("an unknown ref is 404 before the proof: no recovery code spent, no try counted", async () => {
    const u = await owner();
    const { codes } = await enrol();
    const stale = randomBytes(8).toString("hex");
    expect(await answer(await post({ action: "remove", ref: stale, code: codes[0] }))).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    expect(await db.get(`rate:${accountKey.passkeyProofBucket(u.email)}`)).toBeNull();
    // The code was not spent: it still opens a registration.
    expect((await post({ action: "register-options", code: codes[0] })).status).toBe(200);
  });

  it("a Google-only person (no password, two-step off) gets 403 reauth_unavailable for add and remove", async () => {
    const e = `pkg-${randomBytes(4).toString("hex")}@test.example`;
    expect((await resolveGoogle({ sub: `sub-${randomBytes(6).toString("hex")}`, email: e, name: "G" }, "signup", "en")).kind).toBe("created");
    await signIn(e);
    const { pid, born } = await me();
    expect((await answer(await list())).body.proof).toBe("none");
    expect(await answer(await post({ action: "register-options", password: "anything" }))).toEqual({ status: 403, body: { ok: false, error: "reauth_unavailable" } });
    const r = await addPasskey(pid, born, fakeCred(), "Planted");
    if (r === "limit" || r === "credential_taken" || r === "invalid") throw new Error(r);
    expect(await answer(await post({ action: "remove", ref: r.item.ref }))).toEqual({ status: 403, body: { ok: false, error: "reauth_unavailable" } });
    // Rename needs no proof, so it still works.
    expect((await post({ action: "rename", ref: r.item.ref, name: "Renamed" })).status).toBe(200);
    expect(await db.get(`rate:${accountKey.passkeyProofBucket(e)}`)).toBeNull();
  });
});

describe("rule 2416 (route half): removing the last passkey leaves password sign-in working", () => {
  it("remove the only passkey, then sign in with the password", async () => {
    const u = await owner();
    const ref = (await (await add("Only")).res.json()).item.ref;
    expect((await post({ action: "remove", ref, password: PASSWORD })).status).toBe(200);
    expect((await answer(await list())).body.items).toEqual([]);
    signOut();
    const res = await loginRoute.POST(json("/api/auth/login", "POST", { email: u.email, password: PASSWORD }, ip()));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe("rule 2412: who may manage passkeys", () => {
  it("passkeys.manage is member-level and refused while impersonating", () => {
    expect(MIN_ROLE["passkeys.manage"]).toBe("member");
    expect(IMPERSONATION_BLOCKED.has("passkeys.manage")).toBe(true);
  });

  it("signed out: 401 on GET and POST", async () => {
    signOut();
    expect((await list()).status).toBe(401);
    expect((await post({ action: "rename", ref: "0123456789abcdef", name: "A" })).status).toBe(401);
  });

  it("an impersonating founder gets 403 and no passkey key is read or written", async () => {
    const u = await newUser("pki");
    await signIn(u.email, { imp: "founder@test.example" });
    // Spies call through; every first argument (a key, or the keys of an MGET) is collected afterwards.
    const spies = (["get", "mget", "getdel", "set", "setNx", "setXx", "del", "lock"] as const).map((m) => vi.spyOn(db, m));
    const touched = () => spies.flatMap((s) => s.mock.calls.flatMap((c) => [c[0]].flat())).filter((k): k is string => typeof k === "string");
    try {
      expect((await list()).status).toBe(403);
      expect((await post({ action: "register-options", password: PASSWORD })).status).toBe(403);
      expect((await post({ action: "rename", ref: "0123456789abcdef", name: "A" })).status).toBe(403);
      expect((await post({ action: "remove", ref: "0123456789abcdef", password: PASSWORD })).status).toBe(403);
      expect(touched().length).toBeGreaterThan(0);
      expect(touched().filter((k) => /^(passkeys:|pkreg:|pkcred:|rate:pkpw:|lock:person:)/.test(k))).toEqual([]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("an MCP bearer token without a session is 401", async () => {
    const u = await newUser("pkt");
    const token = await createMcpToken(u.email);
    signOut();
    expect((await route.POST(json("/api/account/passkeys", "POST", { action: "register-options", password: PASSWORD }, { authorization: `Bearer ${token}` }))).status).toBe(401);
    expect((await route.GET()).status).toBe(401);
  });

  it("a member with role member adds to their own set, not the owner's", async () => {
    const o = await newUser("pko");
    const m = await newMember(o, "member");
    await signIn(m.email);
    const { pid } = await me();
    expect(pid).toBe(m.pid);
    expect((await add("Member key", { password: m.password })).res.status).toBe(200);
    expect((await answer(await list())).body.items.map((i: { name: string }) => i.name)).toEqual(["Member key"]);
    await signIn(o.email);
    expect((await answer(await list())).body.items).toEqual([]);
  });
});

describe("rule 2413: the list carries no credential data; a ref is matched only in the caller's own set", () => {
  it("GET answers ref, name, dates, synced and transports only", async () => {
    await owner();
    const { cred } = await add("A");
    const body = (await answer(await list())).body;
    expect(Object.keys(body.items[0]).sort()).toEqual(["createdAt", "name", "ref", "synced", "transports"]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(cred.id);
    expect(raw).not.toContain(cred.pk);
    expect(raw).not.toMatch(/"(id|pk|counter|aaguid|uid)"/);
  });

  it("another person's ref is 404 not_found for rename and remove, and their set is unchanged", async () => {
    await owner("pkx");
    const victim = await me();
    const ref = (await (await add("Victim key")).res.json()).item.ref;
    const before = await db.get(personKey.passkeys(victim.pid));
    await owner("pky");
    expect((await (await add("Mine")).res.json()).ok).toBe(true);
    expect(await answer(await post({ action: "rename", ref, name: "Hijacked" }))).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    expect(await answer(await post({ action: "remove", ref, password: PASSWORD }))).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    expect(await db.get(personKey.passkeys(victim.pid))).toEqual(before);
  });
});

describe("rule 2415: a successful add sends one notice email in the person's language", () => {
  type Mail = TemplateMail<"notice">;
  it("Arabic: one mail to the login's address, naming the passkey, without credential data", async () => {
    const u = await owner();
    const { cred } = await add("حاسوب العمل");
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0] as Mail;
    expect(m.to).toBe(u.email);
    expect(m.locale).toBe("ar");
    expect(m.template).toBe("notice");
    expect(m.subject).toBe(COPY.ar.passkey.title);
    expect(m.text).toContain("حاسوب العمل");
    expect(m.context.paragraphs.join(" ")).toContain("حاسوب العمل");
    expect(m.context.cta?.href).toBe(`${LIVE}/ar/app/settings/security`);
    expect(m.context.cta?.label).toBe(COPY.ar.passkey.action);
    const raw = JSON.stringify(m);
    expect(raw).not.toContain(cred.id);
    expect(raw).not.toContain(cred.pk);
    expect(raw).not.toContain(credHash(cred.id).slice(0, 16));
  });

  it("English: the person's language, not the request's", async () => {
    await owner();
    const { pid } = await me();
    await updatePerson(pid, { lang: "en" });
    await add("Work $& laptop");
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0] as Mail;
    expect(m.locale).toBe("en");
    expect(m.subject).toBe(COPY.en.passkey.title);
    expect(m.text).toContain("Work $& laptop");
    expect(m.context.cta?.href).toBe(`${LIVE}/en/app/settings/security`);
  });

  it("the time line is Asia/Riyadh and says so, in both languages", async () => {
    await owner();
    const { pid } = await me();
    // The clock stands still at mid-minute, so the minute cannot roll between the add and the expectation. Riyadh is UTC+3
    // all year (no daylight saving), which the expectation computes on its own.
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
    vi.setSystemTime(now);
    const riyadh = new Date(now + 3 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
    await add("A");
    const ar = mail.sent[0] as Mail;
    expect(ar.context.paragraphs).toContain(`وقت الإضافة: ${riyadh} بتوقيت الرياض.`);
    expect(ar.text).toContain(`${riyadh} بتوقيت الرياض`);
    expect(ar.text).not.toContain("UTC");
    await updatePerson(pid, { lang: "en" });
    mail.sent.length = 0;
    await add("B");
    expect((mail.sent[0] as Mail).context.paragraphs).toContain(`Added at: ${riyadh} (Riyadh time).`);
  });

  it("a send that answers false is logged without values and the add stands", async () => {
    await owner();
    mail.refuse = true;
    const warn = vi.spyOn(log, "warn");
    const { res } = await add("Secret name");
    expect(await answer(res)).toMatchObject({ status: 200, body: { ok: true } });
    expect((await answer(await list())).body.items).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("passkey notice failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Secret name");
    warn.mockRestore();
  });

  it("a failed or throwing send never undoes the add", async () => {
    await owner();
    mail.fail = true;
    const { res } = await add("A");
    expect(await answer(res)).toMatchObject({ status: 200, body: { ok: true } });
    expect((await answer(await list())).body.items).toHaveLength(1);
    expect(vi.mocked(sendEmail)).toHaveBeenCalled();
  });

  it("a refused registration sends nothing", async () => {
    await owner();
    expect((await post({ action: "register-options", password: PASSWORD })).status).toBe(200);
    expect((await post({ action: "register-verify", response: {}, name: "A" })).status).toBe(400);
    expect(mail.sent).toEqual([]);
  });
});

describe("rule 2426 (route half): the off switch stops adding, keeps the list, rename and remove", () => {
  it("register-options and register-verify are 404 unavailable; GET, rename and remove still work", async () => {
    await owner();
    const ref = (await (await add("A")).res.json()).item.ref;
    expect((await post({ action: "register-options", password: PASSWORD })).status).toBe(200);
    await setPasskeysOn(false);
    expect(await answer(await post({ action: "register-options", password: PASSWORD }))).toEqual({ status: 404, body: { ok: false, error: "unavailable" } });
    vi.mocked(verifyRegistration).mockResolvedValueOnce({ ok: true, cred: fakeCred() });
    expect(await answer(await post({ action: "register-verify", response: {}, name: "B" }))).toEqual({ status: 404, body: { ok: false, error: "unavailable" } });
    const l = await answer(await list());
    expect(l.body).toMatchObject({ ok: true, enabled: false, max: 10 });
    expect(l.body.items).toHaveLength(1);
    expect((await post({ action: "rename", ref, name: "B" })).status).toBe(200);
    expect((await post({ action: "remove", ref, password: PASSWORD })).status).toBe(200);
  });
});

describe("rule 2429 (settings half): copy in both languages; the card and the add button need WebAuthn", () => {
  const shape = (o: unknown): unknown =>
    o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : typeof o;
  const strings = (o: unknown): string[] => (typeof o === "string" ? [o] : o && typeof o === "object" ? Object.values(o).flatMap(strings) : []);

  it("every passkey string of the card and of the notice email exists in Arabic and English", () => {
    expect(shape(appDict.en.passkeys)).toEqual(shape(appDict.ar.passkeys));
    expect(shape(COPY.en.passkey)).toEqual(shape(COPY.ar.passkey));
    for (const s of [...strings(appDict.ar.passkeys), ...strings(appDict.en.passkeys), ...strings(COPY.ar.passkey), ...strings(COPY.en.passkey)]) expect(s.trim().length).toBeGreaterThan(0);
    expect(strings(appDict.ar.passkeys).length).toBeGreaterThan(20);
  });

  it("the card shows once support is known, true or false; only the add button needs WebAuthn and the switch on", () => {
    expect(showPasskeyCard(null)).toBe(false);
    // Without WebAuthn the list, rename and remove stay, so a lost device's passkey can be removed from any browser.
    expect(showPasskeyCard(false)).toBe(true);
    expect(showPasskeyCard(true)).toBe(true);
    expect(showAddButton(true, true)).toBe(true);
    expect(showAddButton(false, true)).toBe(false);
    expect(showAddButton(true, false)).toBe(false);
    expect(showAddButton(true, null)).toBe(false);
  });

  it("without WebAuthn the add button gives way to its own line, not the switch-off line", () => {
    for (const l of ["ar", "en"] as const) {
      expect(appDict[l].passkeys.unsupported).not.toBe(appDict[l].passkeys.off);
      expect(appDict[l].passkeys.unsupported.length).toBeGreaterThan(10);
    }
    expect(appDict.en.passkeys.unsupported).toMatch(/browser/i);
    const src = readFileSync("src/components/app/settings/PasskeySettings.tsx", "utf8");
    expect(src).toMatch(/!\(data\.enabled && enabled\) \? \(\s*<p[^>]*>\{T\.off\}<\/p>\s*\) : !showAddButton\(true, supported\) \? \(\s*<p[^>]*>\{T\.unsupported\}<\/p>/);
    expect(src).toMatch(/if \(supported !== null\) void readList\(\)/);
    expect(src).not.toMatch(/if \(!showPasskeyCard\(supported\)\) return null;[\s\S]*if \(!supported\)/);
  });

  it("each row's Rename and Remove buttons carry the passkey's name in their accessible name", () => {
    expect(appDict.en.passkeys.renameNamed).toBe("Rename {name}");
    expect(appDict.en.passkeys.removeNamed).toBe("Remove {name}");
    for (const l of ["ar", "en"] as const) for (const k of ["renameNamed", "removeNamed"] as const) expect(appDict[l].passkeys[k]).toContain("{name}");
    // WCAG 2.5.3 (label in name): the accessible name starts with the visible label, in both languages.
    expect(appDict.ar.passkeys.renameNamed).toBe("أعد التسمية {name}");
    for (const l of ["ar", "en"] as const) {
      expect(appDict[l].passkeys.renameNamed.startsWith(`${appDict[l].passkeys.rename} `)).toBe(true);
      expect(appDict[l].passkeys.removeNamed.startsWith(`${appDict[l].passkeys.remove} `)).toBe(true);
    }
    const src = readFileSync("src/components/app/settings/PasskeySettings.tsx", "utf8");
    expect(src).toContain('aria-label={fill(T.renameNamed, "name", p.name)}');
    expect(src).toContain('aria-label={fill(T.removeNamed, "name", p.name)}');
  });

  it("the default name is a device label from the user agent, else the fallback", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "Passkey")).toBe("iPhone");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Passkey")).toBe("Mac");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Passkey")).toBe("Windows");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 9)", "Passkey")).toBe("Android");
    expect(deviceLabel("", "Passkey")).toBe("Passkey");
  });

  it("the card reads browser support on the client only (unknown on the server), and renders nothing on the server", () => {
    const src = readFileSync("src/components/app/settings/PasskeySettings.tsx", "utf8");
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src).toMatch(/useSyncExternalStore\(noChange, browserSupportsWebAuthn, unknownOnServer\)/);
    expect(src).toMatch(/const unknownOnServer = \(\): boolean \| null => null;/);
    expect(src.match(/browserSupportsWebAuthn\b/g)!.length).toBe(2);
    const html = renderToStaticMarkup(createElement(PasskeySettings, { lang: "en", T: appDict.en.passkeys, enabled: true, forbidden: "x" }));
    expect(html).toBe("");
    expect(src).not.toMatch(/from "@\/lib\/(passkeys|passkey-switch|db|webauthn)"/);
  });
});

describe("rule 2400 (route half): the pid comes from the session only", () => {
  it("the route never calls storedPersonId and never reads an address, pid or account from the body", () => {
    const src = readFileSync("src/app/api/account/passkeys/route.ts", "utf8");
    expect(src).not.toMatch(/storedPersonId/);
    expect(src).not.toMatch(/\bb\.(email|pid|account|acct)\b/);
    expect(src).not.toMatch(/^\s*(email|pid|account|acct)\s*:\s*z\./m);
    expect(src).toMatch(/actingLogin\(u\)/);
    expect(src).not.toMatch(/req\.headers\.get\(["'](host|origin|x-forwarded-host)/i);
  });
});
