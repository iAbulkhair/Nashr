import { afterEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { jar, json, markVerified, newMember as helperNewMember, newUser as helperNewUser, params, signIn, signOut } from "./helpers/session";
import { acct, createUser, currentUser, getUser, saveUser, verifyPassword, type User } from "@/lib/auth";
import { loginIndexOf, newAccountId } from "@/lib/account-id";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { accountKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { ownerOf } from "@/lib/membership";
import { createPersonRecord, getPerson, personFromRaw, updatePerson } from "@/lib/person";
import { newPersonId } from "@/lib/multi-org";
import { resolveGoogle } from "@/lib/google-signin";
import { issueVerifyCode, markVerified as verifyAddress, moveUnverifiedAccount } from "@/lib/verify-email";
import * as accountRoute from "@/app/api/account/route";
import * as sessionsRoute from "@/app/api/account/sessions/route";
import * as profileRoute from "@/app/api/profile/route";
import * as resetRoute from "@/app/api/auth/reset/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as signupRoute from "@/app/api/auth/signup/route";
import * as adminUserRoute from "@/app/api/admin/users/[email]/route";
import * as verifyCheckRoute from "@/app/api/auth/verify/check/route";

// Legacy persons (pid = its address), so the address names the person's `user:` / `member:` keys in the assertions below;
// each still holds a shadow membership unless it says `shadow: false`.
const newUser = (prefix?: string, o: Parameters<typeof helperNewUser>[1] = {}) => helperNewUser(prefix, { legacy: true, ...o });
const newMember = (owner: Parameters<typeof helperNewMember>[0], role?: Parameters<typeof helperNewMember>[1], prefix?: string, o: Parameters<typeof helperNewMember>[3] = {}) => helperNewMember(owner, role, prefix, { legacy: true, ...o });

/**
 * Multi-workspace (docs/specs/2026-10-18-multi-org.md sections 2 and 6): every credential write goes through
 * `updatePerson` (or `createPersonRecord` for a new login). Rule 2138 (M4 contract, credential part; it replaced rule
 * 2132's mirror): every person, legacy or `p_`, writes `person:` only, and `user:` / `member:` hold no credentials
 * (`saveUser` strips them, Script S2 removes what is left). Rule 2139 (credential part): `lock:person` first, and a held
 * person lock answers 409 `busy` with nothing written. Plan reconciliations 6 (a new login's row is written whole) and
 * 11 (a proved address lands on the person and every account it owns).
 */

const FOUNDER = "founder-credentials@test.example";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); signOut(); });

let ipN = 0;
const ip = () => ({ "x-forwarded-for": `198.51.100.${(++ipN % 250) + 1}` });
const answer = async (res: Response) => ({ status: res.status, body: await res.json() });
let n = 0;
const address = (p: string) => `${p}${++n}-${Math.random().toString(36).slice(2, 8)}@test.example`;
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-05T00:00:00.000Z";
const NEW = "newpass123";

const login = (email: string, password: string) => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, ip()));
const changePassword = (current: string) => accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: current, newPassword: NEW }));
const signOutOthers = (password: string) => sessionsRoute.POST(json("/api/account/sessions", "POST", { password }));
const saveProfile = (body: Record<string, string>) => profileRoute.PUT(json("/api/profile", "PUT", body));
async function resetWith(email: string, kind: "owner" | "member") {
  const token = randomBytes(32).toString("hex");
  await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, { email, kind }, 3600);
  return resetRoute.POST(json("/api/auth/reset", "POST", { token, password: NEW }, ip()));
}

/** The fields M4 never writes on an account or member record (rule 2138); Script S2 removes the ones left. */
const LEGACY_CREDENTIALS = ["passHash", "sessionsAfter", "devicesAfter"] as const;
/**
 * The person holds its credentials on `person:{pid}` alone: the row exists with a birth, the record at `user:{pid}` (a
 * legacy owner's own account, when there is one) holds no credential field, and no `member:{pid}` record exists.
 */
async function expectPersonOnly(pid: string) {
  const [row, account, member] = await Promise.all([
    db.get<Record<string, unknown>>(personKey.person(storedPersonId(pid))),
    db.get<Record<string, unknown>>(accountKey.user(pid)),
    db.get(accountKey.member(pid)),
  ]);
  expect(row, "person row").toBeTruthy();
  expect(row!.createdAt, "person birth").toBeTruthy();
  if (account) for (const f of LEGACY_CREDENTIALS) expect(account, f).not.toHaveProperty(f);
  expect(member, "member record").toBeNull();
}
const tick = () => new Promise((r) => setTimeout(r, 5));
/** Act with a session token issued earlier (as a second browser holding it would). */
const useSession = (token: string) => { jar().clear(); jar().set("thakeen_session", token); };
const staleLogs = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter((c) => c[0] === "person stale");

/** A `p_` person at `email` (raw writes): its row and the login index naming it. */
async function putPerson(email: string, password = "pw-person-1", over: Record<string, unknown> = {}): Promise<PersonId> {
  const pid = storedPersonId(newPersonId());
  await Promise.all([
    db.set(personKey.person(pid), { pid, email, name: "Person", lang: "ar", passHash: await bcrypt.hash(password, 4), emailVerifiedAt: T0, sessionsAfter: T0, createdAt: T0, ...over }),
    db.set(accountKey.login(email), loginIndexOf(pid)),
  ]);
  return pid;
}
/** An account record at a new opaque id, verified unless `over` says otherwise. */
async function putAccount(over: Partial<User> = {}): Promise<AccountId> {
  const id = newAccountId();
  await db.set(accountKey.user(id), { id, email: address("acct"), name: "Account", phone: "", plan: "trial", credits: 40, trialEnds: T1, createdAt: T0, lang: "en", emailVerifiedAt: T0, ...over });
  return storedAccountId(id);
}

describe("rule 2138 (credential part): a legacy login's credential writes land on person: only", () => {
  it("an owner's password change: the new hash and stamp on person:, none on user:", async () => {
    const o = await newUser("pw");
    await signIn(o.email);
    expect(await answer(await changePassword("abc12345"))).toEqual({ status: 200, body: { ok: true } });
    await expectPersonOnly(acct(o));
    const p = (await getPerson(storedPersonId(acct(o))))!;
    expect(await verifyPassword(p, NEW)).toBe(true);
    expect(await verifyPassword(p, "abc12345")).toBe(false);
  });

  it("a member's password change: the person only; no member: record appears and the owner's record is untouched", async () => {
    const o = await newUser("mpo");
    const m = await newMember(o);
    const ownerBefore = await db.get<User>(accountKey.user(acct(o)));
    await signIn(m.email);
    expect(await answer(await changePassword(m.password))).toEqual({ status: 200, body: { ok: true } });
    await expectPersonOnly(m.pid);
    expect(await verifyPassword((await getPerson(m.pid))!, NEW)).toBe(true);
    expect(await db.get<User>(accountKey.user(acct(o)))).toEqual(ownerBefore);
  });

  it("name, language and the device stamp: owner and member, through the profile and the sessions routes", async () => {
    const o = await newUser("nl");
    const m = await newMember(o);
    await signIn(o.email);
    expect((await saveProfile({ name: "Owner Renamed", lang: "en", phone: "+966500002132" })).status).toBe(200);
    expect((await getPerson(storedPersonId(acct(o))))).toMatchObject({ name: "Owner Renamed", lang: "en" });
    expect((await signOutOthers("abc12345")).status).toBe(200);
    expect((await getPerson(storedPersonId(acct(o))))!.devicesAfter).toBeTruthy();
    await expectPersonOnly(acct(o));
    await signIn(m.email);
    expect((await saveProfile({ name: "Member Renamed", lang: "en" })).status).toBe(200);
    expect((await signOutOthers(m.password)).status).toBe(200);
    expect((await getPerson(m.pid))).toMatchObject({ name: "Member Renamed", lang: "en", devicesAfter: expect.any(String) });
    await expectPersonOnly(m.pid);
  });

  it("resets, a proof and every route write leave the legacy records without credentials, and no `person stale` is logged", async () => {
    const warn = vi.spyOn(log, "warn");
    const o = await newUser("ag", { verified: false });
    await verifyAddress(o.email);
    const m = await newMember(o);
    expect((await resetWith(o.email, "owner")).status).toBe(200);
    expect((await resetWith(m.email, "member")).status).toBe(200);
    await signIn(o.email);
    expect((await changePassword(NEW)).status).toBe(200);
    expect((await saveProfile({ lang: "en", phone: "+966500002133" })).status).toBe(200);
    expect((await signOutOthers(NEW)).status).toBe(200);
    await signIn(m.email);
    expect((await saveProfile({ name: "M" })).status).toBe(200);
    expect((await signOutOthers(NEW)).status).toBe(200);
    await Promise.all([expectPersonOnly(acct(o)), expectPersonOnly(m.pid)]);
    expect(staleLogs(warn)).toEqual([]);
  });

  it("the founder's reset and language change write the owner person; the account record gets no password", async () => {
    vi.stubEnv("ADMIN_EMAILS", FOUNDER);
    if (!(await getUser(FOUNDER))) await markVerified((await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "ar" })).email);
    const o = await newUser("fr");
    await signIn(FOUNDER);
    const res = await adminUserRoute.POST(json("/api/admin/users/x", "POST", { action: "resetPassword" }), params({ email: encodeURIComponent(o.email) }));
    expect(res.status).toBe(200);
    const { tempPassword } = (await res.json()) as { tempPassword: string };
    expect(await verifyPassword((await getPerson(storedPersonId(acct(o))))!, tempPassword)).toBe(true);
    expect((await adminUserRoute.POST(json("/api/admin/users/x", "POST", { action: "setLang", lang: "en" }), params({ email: encodeURIComponent(o.email) }))).status).toBe(200);
    expect((await getPerson(storedPersonId(acct(o))))!.lang).toBe("en");
    await expectPersonOnly(acct(o));
  });

  it("saveUser strips the credential fields, so no writer can put them back on an account record", async () => {
    const o = await newUser("strip");
    const u = (await getUser(o.email))!;
    await saveUser({ ...u, passHash: "hash-should-not-land", sessionsAfter: T1, devicesAfter: T1 });
    const raw = (await db.get<Record<string, unknown>>(accountKey.user(acct(o))))!;
    for (const f of LEGACY_CREDENTIALS) expect(raw, f).not.toHaveProperty(f);
  });

  it("rule 2766: saveUser keeps the credential fields while the owner has no person row (the only copy)", async () => {
    const o = await newUser("keep");
    const u = (await getUser(o.email))!;
    await db.del(personKey.person(ownerOf(u)));
    const warn = vi.spyOn(log, "warn");
    await saveUser({ ...u, passHash: "only-copy", sessionsAfter: T1 });
    const raw = (await db.get<Record<string, unknown>>(accountKey.user(acct(o))))!;
    expect(raw).toMatchObject({ passHash: "only-copy", sessionsAfter: T1 });
    expect(raw).not.toHaveProperty("devicesAfter");
    expect(warn).toHaveBeenCalledWith("save_user_kept_credentials", {});
    // An account with no credential left costs no extra read.
    const get = vi.spyOn(db, "get");
    const { passHash: _h, sessionsAfter: _s, ...clean } = u;
    void _h; void _s;
    await saveUser(clean as User);
    expect(get.mock.calls.filter(([k]) => k === personKey.person(ownerOf(u)))).toEqual([]);
  });
});

describe("rule 2138: the person row alone holds the revocation stamps", () => {
  it("a stamp a build before M4 wrote on the legacy record is not read: the person's own stamps decide", async () => {
    const o = await newUser("rb");
    const pid = storedPersonId(acct(o));
    const before = await signIn(o.email);
    await tick();
    const raw = (await db.get<Record<string, unknown>>(accountKey.user(acct(o))))!;
    await db.set(accountKey.user(acct(o)), { ...raw, devicesAfter: new Date().toISOString(), sessionsAfter: new Date().toISOString() });
    expect((await getPerson(pid))!.devicesAfter).toBeUndefined();
    useSession(before);
    expect(await currentUser()).not.toBeNull();
    // The person's own sign-out ends it.
    await updatePerson(pid, { devicesAfter: new Date(Date.now() + 1000).toISOString() });
    expect(await currentUser()).toBeNull();
  });

  it("a patch never moves a stamp backwards, and the pure reader reads the row alone", async () => {
    const o = await newUser("rbp");
    const pid = storedPersonId(acct(o));
    const late = new Date(Date.now() + 60_000).toISOString();
    const sessionsBefore = (await getPerson(pid))!.sessionsAfter;
    expect(sessionsBefore).toBeTruthy();
    await updatePerson(pid, { devicesAfter: late });
    await updatePerson(pid, { devicesAfter: T0, sessionsAfter: T0 });
    const p = (await getPerson(pid))!;
    expect(p.devicesAfter).toBe(late);
    expect(p.sessionsAfter).toBe(sessionsBefore);
    const row = { pid, email: o.email, name: "R", lang: "ar", createdAt: o.createdAt, sessionsAfter: T1, devicesAfter: T0 };
    expect(personFromRaw(pid, row)).toMatchObject({ source: "person", name: "R", sessionsAfter: T1, devicesAfter: T0 });
  });

  it("an address move carries the person's device stamp to the new address; the moved account record holds none", async () => {
    const o = await newUser("mvd", { verified: false });
    const pid = storedPersonId(acct(o));
    const at = new Date().toISOString();
    await updatePerson(pid, { devicesAfter: at });
    const to = address("mvdto");
    expect(await moveUnverifiedAccount((await getUser(o.email))!, to)).toBe("ok");
    expect((await getPerson(storedPersonId(to)))!.devicesAfter).toBe(at);
    await expectPersonOnly(to);
  });
});

describe("plan reconciliation 6: a new login's row is written under lock:person", () => {
  it("createPersonRecord waits for a held person lock, then writes", async () => {
    const e = address("cpl");
    const pid = storedPersonId(e);
    await db.lock(personKey.lock(pid), 10);
    let done = false;
    const pending = createPersonRecord({ pid, email: e, name: "N", lang: "ar", createdAt: T0, sessionsAfter: T0 }, { loginLocked: true }).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    await db.unlock(personKey.lock(pid));
    await pending;
    expect((await db.get<{ name: string }>(personKey.person(pid)))!.name).toBe("N");
  });

  it("signup with the person lock held past the wait answers 409 busy and writes nothing", async () => {
    const e = address("cps");
    const pid = storedPersonId(e);
    await db.lock(personKey.lock(pid), 10);
    try {
      const res = await signupRoute.POST(json("/api/auth/signup", "POST", { email: e, password: "abc12345", name: "Busy", lang: "en" }, ip()));
      expect(await answer(res)).toEqual({ status: 409, body: { ok: false, error: "busy" } });
    } finally {
      await db.unlock(personKey.lock(pid));
    }
    expect(await db.get(accountKey.user(e))).toBeNull();
    expect(await db.get(accountKey.login(e))).toBeNull();
    expect(await db.get(personKey.person(pid))).toBeNull();
  }, 30_000);

  it("a Google sign-up with the person lock held past the wait throws person_lock_timeout and writes nothing", async () => {
    const e = address("ggl");
    await db.lock(personKey.lock(storedPersonId(e)), 10);
    try {
      await expect(resolveGoogle({ sub: `sub-${randomBytes(6).toString("hex")}`, email: e, name: "G" }, "signup", "en")).rejects.toThrow("person_lock_timeout");
    } finally {
      await db.unlock(personKey.lock(storedPersonId(e)));
    }
    expect(await db.get(accountKey.user(e))).toBeNull();
    expect(await db.get(personKey.person(storedPersonId(e)))).toBeNull();
    expect(await db.get(accountKey.login(e))).toBeNull();
  }, 30_000);
});

describe("rule 2138 (credential part): a p_ person writes person: only", () => {
  it("a p_ owner's reset: the new password is on the person, never on the account record", async () => {
    const e = address("po");
    const u = await createUser({ email: e, name: "P Owner", phone: "", password: "abc12345", lang: "en" }, { person: "p" });
    const pid = ownerOf(u);
    expect(pid.startsWith("p_")).toBe(true);
    expect(await db.get(accountKey.user(acct(u)))).not.toHaveProperty("passHash");
    expect((await resetWith(e, "owner")).status).toBe(200);
    const account = (await db.get<User>(accountKey.user(acct(u))))!;
    expect(account).not.toHaveProperty("passHash");
    expect(account).not.toHaveProperty("sessionsAfter");
    // The link proved the address: the person and the account it owns are verified (rule 769, reconciliation 11).
    expect(account.emailVerifiedAt).toBeTruthy();
    const p = (await getPerson(pid))!;
    expect(p.emailVerifiedAt).toBeTruthy();
    expect(await verifyPassword(p, NEW)).toBe(true);
    expect(await db.get(accountKey.user(pid))).toBeNull();
    expect(await db.get(accountKey.member(pid))).toBeNull();
    signOut();
    expect(await answer(await login(e, NEW))).toEqual({ status: 200, body: { ok: true, verify: false } });
  });

  it("a p_ owner's reset stamps an unverified owned account with the person's EXISTING proof date", async () => {
    const e = address("pre");
    const pid = await putPerson(e, "pw-person-1", { emailVerifiedAt: T0 });
    const home = await putAccount({ email: e, ownerPid: pid, emailVerifiedAt: T0 });
    const fresh = await putAccount({ ownerPid: pid, emailVerifiedAt: undefined });
    await Promise.all([home, fresh].map((x) => db.sadd(personKey.orgs(pid), x)));
    expect((await resetWith(e, "owner")).status).toBe(200);
    expect((await getPerson(pid))!.emailVerifiedAt).toBe(T0);
    expect((await db.get<User>(accountKey.user(fresh)))!.emailVerifiedAt).toBe(T0);
    expect((await db.get<User>(accountKey.user(home)))!.emailVerifiedAt).toBe(T0);
  });

  it("a p_ member's reset: the person only, no member record appears, and the new password signs in", async () => {
    const o = await newUser("pmo");
    const e = address("pm");
    const pid = await putPerson(e);
    await Promise.all([
      db.set(accountKey.membership(storedAccountId(acct(o)), pid), { aid: acct(o), pid, role: "member", acceptedAt: new Date().toISOString(), invitedBy: o.email }),
      db.sadd(accountKey.members(acct(o)), pid),
      db.sadd(personKey.orgs(pid), acct(o)),
    ]);
    expect((await resetWith(e, "member")).status).toBe(200);
    expect(await verifyPassword((await getPerson(pid))!, NEW)).toBe(true);
    expect(await db.get(accountKey.member(pid))).toBeNull();
    expect(await db.get(accountKey.member(e))).toBeNull();
    signOut();
    expect(await answer(await login(e, NEW))).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("plan reconciliation 6: a new login's person row is written whole", () => {
  it("signup overwrites a leftover person:{email} row: the leftover password does not sign in", async () => {
    const e = address("lo");
    await db.set(personKey.person(storedPersonId(e)), { pid: e, email: e, name: "Leftover", lang: "ar", passHash: await bcrypt.hash("leftover-pass-1", 4), createdAt: T0, sessionsAfter: T0, suspended: true });
    expect((await signupRoute.POST(json("/api/auth/signup", "POST", { email: e, password: "abc12345", name: "New", lang: "en" }, ip()))).status).toBe(200);
    const row = (await db.get<Record<string, unknown>>(personKey.person(storedPersonId(e))))!;
    expect(row.name).toBe("New");
    expect(row).not.toHaveProperty("suspended");
    signOut();
    expect(await answer(await login(e, "leftover-pass-1"))).toEqual({ status: 401, body: { ok: false, error: "invalid" } });
    expect((await login(e, "abc12345")).status).toBe(200);
    await expectPersonOnly(e);
  });

  it("an owner's address move writes the person at the new address whole, with the moved password and birth", async () => {
    // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
    const o = await newUser("mv", { verified: false, shadow: false });
    const to = address("mvto");
    await db.set(personKey.person(storedPersonId(to)), { pid: to, email: to, name: "Leftover", lang: "ar", passHash: await bcrypt.hash("leftover-pass-1", 4), createdAt: T0, sessionsAfter: T0, suspended: true });
    expect(await moveUnverifiedAccount((await getUser(o.email))!, to)).toBe("ok");
    const row = (await db.get<Record<string, unknown>>(personKey.person(storedPersonId(to))))!;
    expect(row).not.toHaveProperty("suspended");
    expect(row.createdAt).toBe(o.createdAt);
    expect(await verifyPassword((await getPerson(storedPersonId(to)))!, "abc12345")).toBe(true);
    await expectPersonOnly(to);
    expect(await db.get(personKey.person(storedPersonId(o.email)))).toBeNull();
  });

  it("a Google sign-up: the person has no password and is proved, and so is the account it owns", async () => {
    const e = address("gg");
    const r = await resolveGoogle({ sub: `sub-${randomBytes(6).toString("hex")}`, email: e, name: "Google Person" }, "signup", "en");
    expect(r.kind).toBe("created");
    const p = (await getPerson(storedPersonId(e)))!;
    expect(p).not.toHaveProperty("passHash");
    expect(p.emailVerifiedAt).toBeTruthy();
    expect(await verifyPassword(p, "anything-at-all")).toBe(false);
    const account = (await db.get<User>(accountKey.user(e)))!;
    expect(account.emailVerifiedAt).toBe(p.emailVerifiedAt);
    // Rule 2138: no account record holds a password, a placeholder hash included.
    expect(account).not.toHaveProperty("passHash");
  });
});

describe("plan reconciliation 11: a proved address lands on the person and on every account it owns", () => {
  it("a legacy owner: the person and the account; the date never moves on a repeat", async () => {
    const o = await newUser("v", { verified: false });
    await verifyAddress(o.email);
    const first = (await getPerson(storedPersonId(acct(o))))!.emailVerifiedAt;
    expect(first).toBeTruthy();
    expect((await getUser(o.email))!.emailVerifiedAt).toBe(first);
    await new Promise((r) => setTimeout(r, 5));
    await verifyAddress(o.email);
    expect((await getPerson(storedPersonId(acct(o))))!.emailVerifiedAt).toBe(first);
    expect((await getUser(o.email))!.emailVerifiedAt).toBe(first);
  });

  it("a p_ owner: every account it owns, never an account in its list that another person owns", async () => {
    const pid = await putPerson(address("pv"), "pw-person-1", { emailVerifiedAt: undefined });
    const [a, b, other] = await Promise.all([putAccount({ ownerPid: pid, emailVerifiedAt: undefined }), putAccount({ ownerPid: pid, emailVerifiedAt: undefined }), putAccount({ ownerPid: "p_someoneelsesomeoneelsesom", emailVerifiedAt: undefined })]);
    await Promise.all([a, b, other].map((x) => db.sadd(personKey.orgs(pid), x)));
    await updatePerson(pid, { emailVerifiedAt: T1 });
    expect((await getPerson(pid))!.emailVerifiedAt).toBe(T1);
    expect((await db.get<User>(accountKey.user(a)))!.emailVerifiedAt).toBe(T1);
    expect((await db.get<User>(accountKey.user(b)))!.emailVerifiedAt).toBe(T1);
    expect((await db.get<User>(accountKey.user(other)))!.emailVerifiedAt).toBeUndefined();
  });

  it("a member's proof stamps no account and writes no member record", async () => {
    const o = await newUser("vo", { verified: false });
    const m = await newMember(o);
    await updatePerson(storedPersonId(m.email), { emailVerifiedAt: T1 });
    expect((await getPerson(storedPersonId(m.email)))!.emailVerifiedAt).toBe(T1);
    expect(await db.get(accountKey.member(m.email))).toBeNull();
    expect((await getUser(o.email))!.emailVerifiedAt).toBeUndefined();
  });
});

describe("rule 2139 (credential part): lock:person first, and a held one waits or answers busy", () => {
  const lockKeys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).filter((k) => /^lock:(person|member|user):/.test(k));

  it("updatePerson takes lock:person alone (rule 2138: no legacy record to mirror), and lock:user only to stamp an owned account", async () => {
    const o = await newUser("lk");
    const m = await newMember(o);
    const spy = vi.spyOn(db, "lock");
    await updatePerson(storedPersonId(acct(o)), { name: "Locked Owner" });
    expect(lockKeys(spy)).toEqual([`lock:person:${acct(o)}`]);
    spy.mockClear();
    await updatePerson(storedPersonId(m.email), { name: "Locked Member" });
    expect(lockKeys(spy)).toEqual([`lock:person:${m.email}`]);
    spy.mockClear();
    await signIn(o.email);
    expect((await saveProfile({ name: "Via Profile", phone: "+966500002139" })).status).toBe(200);
    expect(lockKeys(spy)[0]).toBe(`lock:person:${acct(o)}`);
    expect(lockKeys(spy)).not.toContain(`lock:member:${acct(o)}`);
    spy.mockClear();
    // A proof stamps the account the person owns, under its user lock, after the person lock.
    const u = await newUser("lkv", { verified: false });
    spy.mockClear();
    await updatePerson(storedPersonId(acct(u)), { emailVerifiedAt: T1 });
    expect(lockKeys(spy)).toEqual([`lock:person:${acct(u)}`, `lock:user:${acct(u)}`]);
  });

  it("a held lock:person makes a concurrent updatePerson wait, then run on the fresh record", async () => {
    const o = await newUser("wt");
    const pid = storedPersonId(acct(o));
    expect(await db.lock(personKey.lock(pid), 10)).toBe(true);
    let done = false;
    const pending = updatePerson(pid, { name: "After Wait" }).then((p) => { done = true; return p; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect((await getPerson(pid))!.name).toBe("Test");
    await db.unlock(personKey.lock(pid));
    expect((await pending)!.name).toBe("After Wait");
    await expectPersonOnly(acct(o));
  });

  it("a person lock held for the whole wait: the profile, password and sign-out routes answer 409 busy and write nothing", async () => {
    const o = await newUser("bz");
    const pid = storedPersonId(acct(o));
    await signIn(o.email);
    const before = { person: await db.get(personKey.person(pid)), user: await db.get(accountKey.user(acct(o))) };
    await db.lock(personKey.lock(pid), 10);
    try {
      expect(await answer(await saveProfile({ name: "Busy", phone: "+966500002140" }))).toEqual({ status: 409, body: { ok: false, error: "busy" } });
      expect(await answer(await changePassword("abc12345"))).toEqual({ status: 409, body: { ok: false, error: "busy" } });
      expect(await answer(await signOutOthers("abc12345"))).toEqual({ status: 409, body: { ok: false, error: "busy" } });
    } finally {
      await db.unlock(personKey.lock(pid));
    }
    expect({ person: await db.get(personKey.person(pid)), user: await db.get(accountKey.user(acct(o))) }).toEqual(before);
  }, 30_000);

  it("the verify-code check: a held person lock answers 409 busy and keeps the code, which then verifies", async () => {
    const o = await newUser("bzv", { verified: false });
    const pid = storedPersonId(acct(o));
    await signIn(o.email);
    const code = await issueVerifyCode(o.email);
    const check = () => verifyCheckRoute.POST(json("/api/auth/verify/check", "POST", { code }, ip()));
    await db.lock(personKey.lock(pid), 10);
    try {
      expect(await answer(await check())).toEqual({ status: 409, body: { ok: false, error: "busy" } });
    } finally {
      await db.unlock(personKey.lock(pid));
    }
    expect((await getUser(o.email))!.emailVerifiedAt).toBeUndefined();
    expect(await answer(await check())).toEqual({ status: 200, body: { ok: true } });
    expect((await getPerson(pid))!.emailVerifiedAt).toBeTruthy();
    await expectPersonOnly(acct(o));
  }, 30_000);
});

describe("source scans (rule 2138, credential part)", () => {
  const files = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f)).map((f) => join(dir, f));
  const SRC = files("src");

  it("no file outside person.ts, auth.ts (createUser) and team.ts (legacy member creation) writes a customer passHash", () => {
    const WRITE = /\.passHash\s*=(?!=)|passHash:\s*(await\s+)?bcrypt\.hash/;
    // Staff records (src/lib/staff*.ts, the staff routes) are the console's own logins, not persons.
    const staff = (f: string) => /src\/lib\/staff|src\/app\/api\/admin\/staff\//.test(f);
    const allowed = new Set([join("src", "lib", "person.ts"), join("src", "lib", "auth.ts"), join("src", "lib", "team.ts")]);
    expect(SRC.filter((f) => !allowed.has(f) && !staff(f) && WRITE.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("own-password.ts reads the person and never compares the actor's address with the account's", () => {
    const src = readFileSync("src/lib/own-password.ts", "utf8");
    expect(src).not.toMatch(/\.email\s*===\s*u\.email/);
    expect(src).toMatch(/getPerson\(/);
    expect(src).toMatch(/roleIn\(/);
  });

  it("no route or page makes a p_ person through createUser", () => {
    expect(files(join("src", "app")).filter((f) => /person:\s*["']p["']/.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("every route that takes the person lock, directly or through a library writer, answers its timeout with busy", () => {
    const direct = files(join("src", "app")).filter((f) => /\bupdatePerson\(|\bwithPersonLock\(|\bmarkVerified\(/.test(readFileSync(f, "utf8")));
    expect(direct.length).toBeGreaterThanOrEqual(6);
    // Routes that reach the person lock only through a library writer, which a call-name scan of the route cannot see:
    // `createUser` (signup), `resolveGoogle` → `createUser` (the Google callback), and the owner address moves
    // (`moveUnverifiedAccount`, `moveOwnerLogin`), which take both person locks before `lock:user` (passkeys Task 6, rule
    // 2414). A new library caller of `updatePerson`/`createUser` adds its route here.
    // Multi-workspace M1: src/lib/team.ts writes member persons (`acceptInvite`) and deletes a person left with
    // nothing (`removeMember`, `leaveTeam`, `forceRemoveMember`, `wipeMemberships` through `wipeAccount`, `moveMemberLogin`
    // through `confirmEmailChange`) under the person lock.
    const indirect = [
      join("src", "app", "api", "auth", "signup", "route.ts"),
      join("src", "app", "api", "auth", "google", "callback", "route.ts"),
      join("src", "app", "api", "team", "accept", "route.ts"),
      join("src", "app", "api", "team", "member", "route.ts"),
      join("src", "app", "api", "team", "leave", "route.ts"),
      join("src", "app", "api", "account", "route.ts"),
      join("src", "app", "api", "account", "email", "route.ts"),
      join("src", "app", "api", "auth", "verify", "email", "route.ts"),
      join("src", "app", "api", "admin", "users", "[email]", "route.ts"),
      // Multi-workspace M2: create a workspace (`createWorkspace`, src/lib/workspaces.ts) and the signed-in accept
      // (`acceptInviteAsPerson` → `joinInviteAsPerson`, the accept route above) take the person lock.
      join("src", "app", "api", "workspaces", "route.ts"),
      // Customer passkeys (rule 2414): `ensureUid`, `addPasskey`, `renamePasskey`, `removePasskey` take the person lock.
      join("src", "app", "api", "account", "passkeys", "route.ts"),
      // Passkey sign-in (rules 2414, 2422): `recordUse` writes the counter under the person lock.
      join("src", "app", "api", "auth", "passkey", "verify", "route.ts"),
    ];
    // The sign-in options route (rule 2417) reads no person and takes no lock: it stays off the list, and this pins that
    // it still imports no person writer, so a lock added to it later lands here first.
    const optionsSrc = readFileSync(join("src", "app", "api", "auth", "passkey", "options", "route.ts"), "utf8");
    expect(optionsSrc).not.toMatch(/@\/lib\/(passkeys|person|team)"|\b(updatePerson|withPersonLock|createUser|markVerified)\(/);
    const libWriters = files(join("src", "lib")).filter((f) => /\b(updatePerson|createUser|withPersonLock)\(/.test(readFileSync(f, "utf8")) && !/src\/lib\/(person|auth)\.ts$/.test(f));
    // The library files that call a person writer, so a new one fails here until its routes are listed above.
    expect(libWriters.map((f) => f.replace(/\\/g, "/")).sort()).toEqual(["src/lib/google-signin.ts", "src/lib/passkeys.ts", "src/lib/team.ts", "src/lib/verify-email.ts", "src/lib/workspaces.ts"]);
    // src/lib/passkeys.ts: every route that imports the store is listed, so a new one (the sign-in verify route) fails
    // here until it is, and then must answer the lock timeout (Task 3 review minor 7).
    const passkeyRoutes = files(join("src", "app")).filter((f) => /from "@\/lib\/passkeys"/.test(readFileSync(f, "utf8")));
    expect(passkeyRoutes.length).toBeGreaterThanOrEqual(1);
    expect(passkeyRoutes.filter((f) => !indirect.includes(f) && !direct.includes(f))).toEqual([]);
    // A call, not a name: an import line alone does not answer the timeout (Task 4 review minor 5). PERSON_LOCK_TIMEOUT
    // counts only when it is used past its import (src/app/api/profile/route.ts keeps it in a set of lock codes).
    const answersTimeout = (src: string) => /\bisPersonLockTimeout\(/.test(src) || (src.match(/\bPERSON_LOCK_TIMEOUT\b/g)?.length ?? 0) >= 2;
    expect([...direct, ...indirect].filter((f) => !answersTimeout(readFileSync(f, "utf8")))).toEqual([]);
    expect(answersTimeout('import { isPersonLockTimeout } from "@/lib/person";')).toBe(false);
    expect(answersTimeout('import { PERSON_LOCK_TIMEOUT } from "@/lib/person";')).toBe(false);
  });
});
