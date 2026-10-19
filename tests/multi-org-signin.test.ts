import { afterEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { jar, json, markVerified, newMember, newOpaqueUser, newUser, signIn, signOut } from "./helpers/session";
import { acct, getLogin, getUser, saveUser, sessionIds, sessionKey, verifyPassword, type User } from "@/lib/auth";
import { loginIndexOf, newAccountId } from "@/lib/account-id";
import { db } from "@/lib/db";
import { accountKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { pickAccount } from "@/lib/membership";
import { getPerson } from "@/lib/person";
import { newPersonId } from "@/lib/multi-org";
import { getMember, saveMember } from "@/lib/team";
import * as loginRoute from "@/app/api/auth/login/route";
import * as signupRoute from "@/app/api/auth/signup/route";

/**
 * Multi-workspace M1 expand, Task 3 (docs/specs/2026-10-18-multi-org.md section 5): sign-in resolves a person and picks
 * the account the session stands for. Rule 2132 (sign-in part): a legacy owner and a legacy member sign in exactly as
 * in R1. Rule 2136 (the pick order): `lastorg:` while it still holds, else the owned account, else the oldest live
 * membership. Plan reconciliation 5 (a stale `person:` row never beats a newer legacy record) and 7 (a person with no
 * membership left is nobody: the address is free). The `p_` persons are built with raw writes through the key
 * builders, never through the code under test.
 */

afterEach(() => { vi.restoreAllMocks(); signOut(); });

let ipN = 0;
const ip = () => ({ "x-forwarded-for": `203.0.113.${(++ipN % 250) + 1}` });
const login = (email: string, password = "abc12345") => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, ip()));
const signup = (email: string) => signupRoute.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "X", lang: "en" }, ip()));
/** The session record behind the test jar's cookie. */
const sessionNow = () => db.get<Record<string, unknown>>(sessionKey(jar().get("thakeen_session")!));
const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

let n = 0;
const address = (p: string) => `${p}${++n}-${Math.random().toString(36).slice(2, 8)}@test.example`;
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-05T00:00:00.000Z";
const T2 = "2026-10-10T00:00:00.000Z";
const T3 = "2026-10-15T00:00:00.000Z";

/** A verified account record at `user:{aid}` (the spec's owner of a `p_` person carries `ownerPid`). */
async function putAccount(over: Partial<User> = {}): Promise<AccountId> {
  const id = newAccountId();
  const u = { id, email: address("acct"), name: "Account", phone: "", passHash: "hash-account", plan: "trial", credits: 40, trialEnds: T3, createdAt: T0, lang: "en", emailVerifiedAt: T0, sessionsAfter: T0, ...over } as User;
  await db.set(accountKey.user(id), u);
  return storedAccountId(id);
}

/** A `p_` person at `email`: its row, the login index naming it, and the given password's hash. */
async function putPerson(email: string, password = "pw-person-1", over: Record<string, unknown> = {}): Promise<PersonId> {
  const pid = storedPersonId(newPersonId());
  const passHash = await bcrypt.hash(password, 4);
  await Promise.all([
    db.set(personKey.person(pid), { pid, email, name: "Person", lang: "ar", passHash, emailVerifiedAt: T0, sessionsAfter: T0, createdAt: T0, ...over }),
    db.set(accountKey.login(email), loginIndexOf(pid)),
  ]);
  return pid;
}

/** A membership of `pid` in `aid`: the row, the roster entry and the person's index entry. */
async function join(aid: AccountId, pid: PersonId, over: Record<string, unknown> = {}): Promise<void> {
  await Promise.all([
    db.set(accountKey.membership(aid, pid), { aid, pid, role: "member", acceptedAt: T1, invitedBy: "p_inviterinviterinviterinv", ...over }),
    db.sadd(accountKey.members(aid), pid),
    db.sadd(personKey.orgs(pid), aid),
  ]);
}

/** An account the person owns: `ownerPid` on the record, listed in `orgs:{pid}`. */
async function own(pid: PersonId): Promise<AccountId> {
  const aid = await putAccount({ ownerPid: pid } as Partial<User>);
  await db.sadd(personKey.orgs(pid), aid);
  return aid;
}

describe("rule 2132: a legacy owner and a legacy member sign in exactly as in R1", () => {
  it("a verified owner: 200 {ok, verify: false}; the session holds the R1 pid and acct (the account id)", async () => {
    const o = await newUser("o");
    expect(await answer(await login(o.email))).toEqual({ status: 200, body: { ok: true, verify: false } });
    const s = await sessionNow();
    expect(s).toMatchObject({ email: o.email, pid: acct(o), acct: acct(o) });
    expect(Object.keys(s!).sort()).toEqual(["acct", "at", "email", "pid"]);
  });

  it("an opaque owner (id differs from the address): pid and acct are the account id, as R1 wrote", async () => {
    const o = await newOpaqueUser("oo");
    expect(await answer(await login(o.email))).toEqual({ status: 200, body: { ok: true, verify: false } });
    expect(await sessionNow()).toMatchObject({ email: o.email, pid: acct(o), acct: acct(o) });
  });

  it("an unverified owner still gets a session and verify: true", async () => {
    const o = await newUser("ou", { verified: false });
    expect(await answer(await login(o.email))).toEqual({ status: 200, body: { ok: true, verify: true } });
    expect(await sessionNow()).toMatchObject({ email: o.email, pid: acct(o), acct: acct(o) });
  });

  it("a member: 200 {ok}; the session pid is the member's address and acct its memberOf", async () => {
    const o = await newUser("mo");
    const m = await newMember(o);
    expect(await answer(await login(m.email, m.password))).toEqual({ status: 200, body: { ok: true } });
    expect(await sessionNow()).toMatchObject({ email: m.email, pid: m.email, acct: acct(o) });
  });

  it("the refusals keep their answers: wrong password, unknown address, a paused member, an unverified owner's member, a removed member", async () => {
    const o = await newUser("ro");
    expect(await answer(await login(o.email, "wrong-pass"))).toEqual({ status: 401, body: { ok: false, error: "invalid" } });
    expect(await answer(await login(address("nobody")))).toEqual({ status: 401, body: { ok: false, error: "invalid" } });
    const paused = await newMember(o);
    await saveMember({ ...(await getMember(paused.email))!, disabled: "seats" });
    expect(await answer(await login(paused.email))).toEqual({ status: 403, body: { ok: false, error: "disabled" } });
    const uo = await newUser("ruo", { verified: false });
    const um = await newMember(uo);
    expect(await answer(await login(um.email))).toEqual({ status: 403, body: { ok: false, error: "owner_unverified" } });
    const gone = await newMember(o);
    await db.srem(accountKey.members(acct(o)), gone.email);
    expect(await answer(await login(gone.email))).toEqual({ status: 401, body: { ok: false, error: "invalid" } });
    expect(jar().get("thakeen_session")).toBeFalsy();
  });

  it("getLogin keeps R1's kinds and ids, and adds the person and the account", async () => {
    const o = await newUser("go");
    const m = await newMember(o);
    expect(await getLogin(o.email)).toMatchObject({ kind: "owner", pid: acct(o), acct: acct(o), person: { email: o.email, source: "owner" } });
    expect(await getLogin(m.email)).toMatchObject({ kind: "member", pid: m.email, acct: acct(o), member: { email: m.email }, person: { email: m.email, source: "member" } });
  });

  it("the test helper writes the R1 ids by default, none with legacyShape, and the given acct when asked", async () => {
    const o = await newUser("ho");
    const m = await newMember(o);
    expect(await sessionIds(o.email)).toEqual({ pid: acct(o), acct: acct(o) });
    expect(await sessionIds(m.email)).toEqual({ pid: m.email, acct: acct(o) });
    await signIn(o.email, { legacyShape: true });
    expect(Object.keys((await sessionNow())!).sort()).toEqual(["at", "email"]);
    await signIn(m.email);
    expect(await sessionNow()).toMatchObject({ email: m.email, pid: m.email, acct: acct(o) });
  });

  it("a lastorg: or orgs: key never moves a legacy person off the home account unless the forward records hold it", async () => {
    const o = await newUser("lo");
    const other = await putAccount();
    await db.set(personKey.lastOrg(storedPersonId(acct(o))), other);
    await db.sadd(personKey.orgs(storedPersonId(acct(o))), other);
    expect(await sessionIds(o.email)).toEqual({ pid: acct(o), acct: acct(o) });
  });
});

describe("rule 2136: a p_ person signs in to the account the pick order names", () => {
  it("with an owned account: that account, even with an older membership", async () => {
    const e = address("po");
    const pid = await putPerson(e);
    const owned = await own(pid);
    await join(await putAccount(), pid, { acceptedAt: T1 });
    expect(await answer(await login(e, "pw-person-1"))).toEqual({ status: 200, body: { ok: true, verify: false } });
    expect(await sessionNow()).toMatchObject({ email: e, pid, acct: owned });
    expect(await getLogin(e)).toMatchObject({ kind: "owner", pid, acct: owned, person: { source: "person" } });
  });

  it("with only memberships: the oldest live one; a paused or unlisted one is skipped", async () => {
    const e = address("pm");
    const pid = await putPerson(e);
    const [paused, older, newer, unlisted] = await Promise.all([putAccount(), putAccount(), putAccount(), putAccount()]);
    await Promise.all([
      join(paused, pid, { acceptedAt: T0, disabled: "seats" }),
      join(older, pid, { acceptedAt: T1 }),
      join(newer, pid, { acceptedAt: T2 }),
      join(unlisted, pid, { acceptedAt: T0 }),
    ]);
    await db.srem(accountKey.members(unlisted), pid);
    expect(await answer(await login(e, "pw-person-1"))).toEqual({ status: 200, body: { ok: true } });
    expect(await sessionNow()).toMatchObject({ email: e, pid, acct: older });
    expect(await getLogin(e)).toMatchObject({ kind: "member", member: null, pid, acct: older });
  });

  it("lastorg: naming a live membership wins over the owned account", async () => {
    const e = address("pl");
    const pid = await putPerson(e);
    await own(pid);
    const kept = await putAccount();
    await join(kept, pid, { acceptedAt: T2 });
    await db.set(personKey.lastOrg(pid), kept);
    expect((await login(e, "pw-person-1")).status).toBe(200);
    expect(await sessionNow()).toMatchObject({ pid, acct: kept });
  });

  it("lastorg: naming a dead membership (removed, paused, or an account it never held) falls back", async () => {
    const e = address("pd");
    const pid = await putPerson(e);
    const [older, removed, paused] = await Promise.all([putAccount(), putAccount(), putAccount()]);
    await Promise.all([join(older, pid, { acceptedAt: T1 }), join(removed, pid, { acceptedAt: T2 }), join(paused, pid, { acceptedAt: T2, disabled: "seats" })]);
    await db.del(accountKey.membership(removed, pid));
    const p = (await getPerson(pid))!;
    for (const dead of [removed, paused, await putAccount()]) {
      await db.set(personKey.lastOrg(pid), dead);
      expect(await pickAccount(p)).toBe(older);
    }
    expect(await pickAccount(p, { prefer: paused })).toBe(older);
    await db.set(personKey.lastOrg(pid), removed);
    expect((await login(e, "pw-person-1")).status).toBe(200);
    expect(await sessionNow()).toMatchObject({ pid, acct: older });
  });

  it("the person must hold the address: a row naming another address, or an index naming nobody, signs nobody in", async () => {
    const e = address("pa");
    const pid = await putPerson(e, "pw-person-1", { email: address("elsewhere") });
    await join(await putAccount(), pid);
    expect(await getLogin(e)).toBeNull();
    expect(await answer(await login(e, "pw-person-1"))).toEqual({ status: 401, body: { ok: false, error: "invalid" } });
  });

  it("an account's ownerPid naming another person is no owned account for this one", async () => {
    const e = address("pf");
    const pid = await putPerson(e);
    const forged = await putAccount({ ownerPid: storedPersonId(newPersonId()) } as Partial<User>);
    await db.sadd(personKey.orgs(pid), forged);
    expect(await getLogin(e)).toBeNull();
  });

  it("a suspended person is refused like a suspended account", async () => {
    const e = address("ps");
    const pid = await putPerson(e, "pw-person-1", { suspended: true });
    await join(await putAccount(), pid);
    expect(await answer(await login(e, "pw-person-1"))).toEqual({ status: 403, body: { ok: false, error: "suspended" } });
    expect(jar().get("thakeen_session")).toBeFalsy();
  });
});

describe("reconciliation 7: a person whose only membership is gone is nobody", () => {
  it("login answers as for an unknown address, and signup at the address succeeds", async () => {
    const e = address("pg");
    const pid = await putPerson(e, "abc12345");
    const aid = await putAccount();
    await join(aid, pid);
    expect((await login(e)).status).toBe(200);
    signOut();
    await Promise.all([db.del(accountKey.membership(aid, pid)), db.srem(accountKey.members(aid), pid)]);
    expect(await getLogin(e)).toBeNull();
    const unknown = await answer(await login(address("nobody")));
    expect(await answer(await login(e))).toEqual(unknown);
    const res = await signup(e);
    expect(res.status).toBe(200);
    expect(await getLogin(e)).toMatchObject({ kind: "owner", pid: e, acct: e });
  });
});

describe("reconciliation 5: verifyPassword reads the person, and a stale person: row loses", () => {
  it("a person: row older than the legacy owner's last password change keeps its old hash out", async () => {
    const o = await newUser("st");
    await markVerified(o.email);
    const cur = (await getUser(o.email))!;
    const later = new Date(Date.parse(cur.sessionsAfter!) + 60_000).toISOString();
    await saveUser({ ...cur, sessionsAfter: later });
    await db.set(personKey.person(storedPersonId(o.email)), { pid: o.email, email: o.email, name: "Old", lang: "ar", passHash: await bcrypt.hash("old-pass-1", 4), sessionsAfter: cur.sessionsAfter, createdAt: cur.createdAt });
    const l = (await getLogin(o.email))!;
    expect(l.person.source).toBe("owner");
    expect(await verifyPassword(l.person, "old-pass-1")).toBe(false);
    expect(await verifyPassword(l.person, "abc12345")).toBe(true);
    expect((await login(o.email, "old-pass-1")).status).toBe(401);
    expect((await login(o.email)).status).toBe(200);
  });

  it("an empty or missing hash never matches", async () => {
    expect(await verifyPassword({ passHash: "" }, "")).toBe(false);
    expect(await verifyPassword({}, "abc12345")).toBe(false);
  });
});
