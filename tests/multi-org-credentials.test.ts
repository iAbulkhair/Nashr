import { afterEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { jar, json, markVerified, newMember as helperNewMember, newUser as helperNewUser, params, signIn, signOut } from "./helpers/session";
import { acct, createUser, currentUser, getUser, verifyPassword, type User } from "@/lib/auth";
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

// Pins the legacy shape (multi-org M1): this file reads and writes R1's records by address (`user:`/`member:`, address-shaped
// person ids and actors), so its persons are legacy ones; each still holds a shadow membership unless it says `shadow: false`.
const newUser = (prefix?: string, o: Parameters<typeof helperNewUser>[1] = {}) => helperNewUser(prefix, { legacy: true, ...o });
const newMember = (owner: Parameters<typeof helperNewMember>[0], role?: Parameters<typeof helperNewMember>[1], prefix?: string, o: Parameters<typeof helperNewMember>[3] = {}) => helperNewMember(owner, role, prefix, { legacy: true, ...o });

/**
 * Multi-workspace M1 expand (docs/specs/2026-10-18-multi-org.md sections 2 and 6): every credential write goes
 * through `updatePerson` (or `createPersonRecord` for a new login). Rule 2132 (credential part): the person row and the
 * legacy record it mirrors agree after every write, so a build rolled back to R1 reads the new credentials, and the
 * stale guard never fires; a `p_` person writes `person:` only. Rule 2139 (credential part): `lock:person` before
 * `lock:member` / `lock:user`, and a held person lock answers 409 `busy` with nothing written. Plan reconciliations 6
 * (a new login's row is written whole) and 11 (a proved address lands on the person and every account it owns).
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

const OWNER_FIELDS = ["email", "name", "lang", "passHash", "emailVerifiedAt", "sessionsAfter", "devicesAfter"] as const;
const MEMBER_FIELDS = ["email", "name", "lang", "passHash", "sessionsAfter", "devicesAfter"] as const;
/** The `person:` row and the legacy record it mirrors hold the same credentials, and the row's birth is the legacy one. */
async function expectAgree(pid: string, kind: "owner" | "member") {
  const row = await db.get<Record<string, unknown>>(personKey.person(storedPersonId(pid)));
  const legacy = await db.get<Record<string, unknown>>(kind === "owner" ? accountKey.user(pid) : accountKey.member(pid));
  expect(row, "person row").toBeTruthy();
  for (const f of kind === "owner" ? OWNER_FIELDS : MEMBER_FIELDS) expect(row![f], f).toEqual(legacy![f]);
  expect(row!.createdAt).toBe(kind === "owner" ? legacy!.createdAt : legacy!.acceptedAt);
  if (kind === "member") expect(legacy).not.toHaveProperty("emailVerifiedAt");
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

describe("rule 2132 (credential part): a legacy login's writes land on the person and on its legacy record", () => {
  it("an owner's password change: the same hash and stamp on person: and user:, which an R1 reader checks", async () => {
    const o = await newUser("pw");
    await signIn(o.email);
    expect(await answer(await changePassword("abc12345"))).toEqual({ status: 200, body: { ok: true } });
    await expectAgree(acct(o), "owner");
    // What an R1 build reads: the account record's own hash.
    const r1 = (await db.get<User>(accountKey.user(acct(o))))!;
    expect(await bcrypt.compare(NEW, r1.passHash!)).toBe(true);
    expect(await bcrypt.compare("abc12345", r1.passHash!)).toBe(false);
    expect(await verifyPassword((await getPerson(storedPersonId(acct(o))))!, NEW)).toBe(true);
  });

  it("a member's password change: the same hash and stamp on person: and member:, and the owner's record is untouched", async () => {
    const o = await newUser("mpo");
    const m = await newMember(o);
    const ownerBefore = await db.get<User>(accountKey.user(acct(o)));
    await signIn(m.email);
    expect(await answer(await changePassword(m.password))).toEqual({ status: 200, body: { ok: true } });
    await expectAgree(m.email, "member");
    const r1 = (await db.get<{ passHash: string }>(accountKey.member(m.email)))!;
    expect(await bcrypt.compare(NEW, r1.passHash)).toBe(true);
    expect(await db.get<User>(accountKey.user(acct(o)))).toEqual(ownerBefore);
  });

  it("name, language and the device stamp: owner and member, through the profile and the sessions routes", async () => {
    const o = await newUser("nl");
    const m = await newMember(o);
    await signIn(o.email);
    expect((await saveProfile({ name: "Owner Renamed", lang: "en", phone: "+966500002132" })).status).toBe(200);
    await expectAgree(acct(o), "owner");
    expect((await getPerson(storedPersonId(acct(o))))).toMatchObject({ name: "Owner Renamed", lang: "en" });
    expect((await signOutOthers("abc12345")).status).toBe(200);
    await expectAgree(acct(o), "owner");
    expect((await getPerson(storedPersonId(acct(o))))!.devicesAfter).toBeTruthy();
    await signIn(m.email);
    expect((await saveProfile({ name: "Member Renamed", lang: "en" })).status).toBe(200);
    await expectAgree(m.email, "member");
    expect((await signOutOthers(m.password)).status).toBe(200);
    await expectAgree(m.email, "member");
    expect((await db.get<{ name: string; devicesAfter?: string }>(accountKey.member(m.email)))).toMatchObject({ name: "Member Renamed" });
  });

  it("after every credential write the two records agree and no `person stale` is logged", async () => {
    const warn = vi.spyOn(log, "warn");
    const o = await newUser("ag", { verified: false });
    await verifyAddress(o.email);
    await expectAgree(acct(o), "owner");
    const m = await newMember(o);
    expect((await resetWith(o.email, "owner")).status).toBe(200);
    await expectAgree(acct(o), "owner");
    expect((await resetWith(m.email, "member")).status).toBe(200);
    await expectAgree(m.email, "member");
    await signIn(o.email);
    expect((await changePassword(NEW)).status).toBe(200);
    expect((await saveProfile({ lang: "en", phone: "+966500002133" })).status).toBe(200);
    expect((await signOutOthers(NEW)).status).toBe(200);
    await expectAgree(acct(o), "owner");
    await signIn(m.email);
    expect((await saveProfile({ name: "M" })).status).toBe(200);
    expect((await signOutOthers(NEW)).status).toBe(200);
    await expectAgree(m.email, "member");
    // Every read since (the sessions above resolved through the person) found both records agreeing.
    expect(staleLogs(warn)).toEqual([]);
  });

  it("the founder's reset and language change write the owner person and the account alike", async () => {
    vi.stubEnv("ADMIN_EMAILS", FOUNDER);
    if (!(await getUser(FOUNDER))) await markVerified((await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "ar" })).email);
    const o = await newUser("fr");
    await signIn(FOUNDER);
    const res = await adminUserRoute.POST(json("/api/admin/users/x", "POST", { action: "resetPassword" }), params({ email: encodeURIComponent(o.email) }));
    expect(res.status).toBe(200);
    const { tempPassword } = (await res.json()) as { tempPassword: string };
    await expectAgree(acct(o), "owner");
    expect(await verifyPassword((await getPerson(storedPersonId(acct(o))))!, tempPassword)).toBe(true);
    expect((await adminUserRoute.POST(json("/api/admin/users/x", "POST", { action: "setLang", lang: "en" }), params({ email: encodeURIComponent(o.email) }))).status).toBe(200);
    await expectAgree(acct(o), "owner");
    expect((await getPerson(storedPersonId(acct(o))))!.lang).toBe("en");
  });
});

describe("rule 2132: a revocation stamp never moves backwards", () => {
  /** A newer `devicesAfter` written to the legacy record only, as R1's "sign out other devices" does (rule 1170). */
  async function r1SignOutOthers(key: string): Promise<string> {
    await tick();
    const at = new Date().toISOString();
    const rec = (await db.get<Record<string, unknown>>(key))!;
    await db.set(key, { ...rec, devicesAfter: at });
    await tick();
    return at;
  }

  it("owner: a rolled-back sign-out survives a name change and a password change, on both records", async () => {
    const o = await newUser("rb");
    const pid = storedPersonId(acct(o));
    await updatePerson(pid, { devicesAfter: new Date().toISOString() }); // an M1 sign-out: the row holds an older stamp
    await tick();
    const before = await signIn(o.email);
    const at = await r1SignOutOthers(accountKey.user(acct(o)));
    // Read: the newer legacy stamp already ends the session issued before it.
    expect((await getPerson(pid))!.devicesAfter).toBe(at);
    useSession(before);
    expect(await currentUser()).toBeNull();
    // A name change (no session stamp moves) keeps it on both records, and the session stays ended.
    await signIn(o.email);
    expect((await saveProfile({ name: "Still Out", phone: "+966500002141" })).status).toBe(200);
    expect((await db.get<User>(accountKey.user(acct(o))))!.devicesAfter).toBe(at);
    expect((await db.get<{ devicesAfter?: string }>(personKey.person(pid)))!.devicesAfter).toBe(at);
    useSession(before);
    expect(await currentUser()).toBeNull();
    // A password change likewise.
    await signIn(o.email);
    expect((await changePassword("abc12345")).status).toBe(200);
    expect((await db.get<User>(accountKey.user(acct(o))))!.devicesAfter).toBe(at);
    expect((await db.get<{ devicesAfter?: string }>(personKey.person(pid)))!.devicesAfter).toBe(at);
    await expectAgree(acct(o), "owner");
    useSession(before);
    expect(await currentUser()).toBeNull();
  });

  it("member: a rolled-back sign-out survives a name change and a password change, on both records", async () => {
    const o = await newUser("rbo");
    const m = await newMember(o);
    const pid = storedPersonId(m.email);
    await updatePerson(pid, { devicesAfter: new Date().toISOString() });
    await tick();
    const before = await signIn(m.email);
    const at = await r1SignOutOthers(accountKey.member(m.email));
    useSession(before);
    expect(await currentUser()).toBeNull();
    await signIn(m.email);
    expect((await saveProfile({ name: "Member Still Out" })).status).toBe(200);
    expect((await changePassword(m.password)).status).toBe(200);
    expect((await db.get<{ devicesAfter?: string }>(accountKey.member(m.email)))!.devicesAfter).toBe(at);
    expect((await db.get<{ devicesAfter?: string }>(personKey.person(pid)))!.devicesAfter).toBe(at);
    await expectAgree(m.email, "member");
    useSession(before);
    expect(await currentUser()).toBeNull();
  });

  it("a patch never moves a stamp backwards either, and the read keeps the later of both records", async () => {
    const o = await newUser("rbp");
    const pid = storedPersonId(acct(o));
    const late = new Date(Date.now() + 60_000).toISOString();
    await updatePerson(pid, { devicesAfter: late });
    await updatePerson(pid, { devicesAfter: T0, sessionsAfter: T0 });
    const p = (await getPerson(pid))!;
    expect(p.devicesAfter).toBe(late);
    expect(p.sessionsAfter).toBe(o.sessionsAfter);
    // The pure reader: the row wins, but each stamp is the later of the row and the legacy record.
    const row = { pid, email: o.email, name: "R", lang: "ar", createdAt: o.createdAt, sessionsAfter: T1, devicesAfter: T0 };
    const legacy = { ...(await db.get<User>(accountKey.user(acct(o))))!, sessionsAfter: T0, devicesAfter: T1 };
    expect(personFromRaw(pid, row, legacy, null)).toMatchObject({ source: "person", name: "R", sessionsAfter: T1, devicesAfter: T1 });
  });

  it("an address move writes the same device stamp on the moved account and the person", async () => {
    const o = await newUser("mvd", { verified: false });
    const pid = storedPersonId(acct(o));
    await updatePerson(pid, { devicesAfter: new Date().toISOString() });
    const at = await r1SignOutOthers(accountKey.user(acct(o)));
    const to = address("mvdto");
    expect(await moveUnverifiedAccount((await getUser(o.email))!, to)).toBe("ok");
    expect((await db.get<User>(accountKey.user(to)))!.devicesAfter).toBe(at);
    await expectAgree(to, "owner");
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

describe("rule 2132 (credential part): a p_ person writes person: only", () => {
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
    await expectAgree(e, "owner");
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
    await expectAgree(to, "owner");
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
    // A build rolled back to R1 compares `user.passHash`: the account keeps a hash nobody knows.
    expect(typeof account.passHash).toBe("string");
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

  it("a member's proof stamps no account and is never written to the member record", async () => {
    const o = await newUser("vo", { verified: false });
    const m = await newMember(o);
    await updatePerson(storedPersonId(m.email), { emailVerifiedAt: T1 });
    expect((await getPerson(storedPersonId(m.email)))!.emailVerifiedAt).toBe(T1);
    expect(await db.get(accountKey.member(m.email))).not.toHaveProperty("emailVerifiedAt");
    expect((await getUser(o.email))!.emailVerifiedAt).toBeUndefined();
  });
});

describe("rule 2139 (credential part): lock:person first, and a held one waits or answers busy", () => {
  const lockKeys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).filter((k) => /^lock:(person|member|user):/.test(k));

  it("updatePerson takes lock:person before lock:user (owner) and before lock:member (member)", async () => {
    const o = await newUser("lk");
    const m = await newMember(o);
    const spy = vi.spyOn(db, "lock");
    await updatePerson(storedPersonId(acct(o)), { name: "Locked Owner" });
    expect(lockKeys(spy)).toEqual([`lock:person:${acct(o)}`, `lock:user:${acct(o)}`]);
    spy.mockClear();
    await updatePerson(storedPersonId(m.email), { name: "Locked Member" });
    expect(lockKeys(spy)).toEqual([`lock:person:${m.email}`, `lock:member:${m.email}`]);
    spy.mockClear();
    await signIn(o.email);
    expect((await saveProfile({ name: "Via Profile", phone: "+966500002139" })).status).toBe(200);
    expect(lockKeys(spy)).toEqual([`lock:person:${acct(o)}`, `lock:user:${acct(o)}`]);
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
    await expectAgree(acct(o), "owner");
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
    await expectAgree(acct(o), "owner");
  }, 30_000);
});

describe("source scans (rule 2132, credential part)", () => {
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
