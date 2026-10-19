import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { adminSignIn, json, newMember as helperNewMember, newUser as helperNewUser, params, signIn, signOut } from "./helpers/session";
import { acct, currentUser, getLogin, getUser, saveUser, type Actor, type Plan, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { getMembership } from "@/lib/membership";
import { getPerson } from "@/lib/person";
import {
  acceptInvite,
  cancelInvite,
  createInvite,
  discardInvite,
  enforceSeats,
  forceRemoveMember,
  leaveTeam,
  listMembers,
  removeMember,
  seatsUsed,
  setRole,
  writeMembership,
} from "@/lib/team";
import { logTeam, readTeamLog } from "@/lib/teamlog";
import * as memberRoute from "@/app/api/team/member/route";
import * as leaveRoute from "@/app/api/team/leave/route";
import * as acceptRoute from "@/app/api/team/accept/route";
import * as accountRoute from "@/app/api/account/route";
import * as adminUserRoute from "@/app/api/admin/users/[email]/route";
import { moveUnverifiedAccount } from "@/lib/verify-email";
import { confirmEmailChange, startEmailChange } from "@/lib/email-change";

// Pins the legacy shape (multi-org M1): this file reads and writes R1's records by address (`user:`/`member:`, address-shaped
// person ids and actors), so its persons are legacy ones; each still holds a shadow membership unless it says `shadow: false`.
const newUser = (prefix?: string, o: Parameters<typeof helperNewUser>[1] = {}) => helperNewUser(prefix, { legacy: true, ...o });
const newMember = (owner: Parameters<typeof helperNewMember>[0], role?: Parameters<typeof helperNewMember>[1], prefix?: string, o: Parameters<typeof helperNewMember>[3] = {}) => helperNewMember(owner, role, prefix, { legacy: true, ...o });

/**
 * Multi-workspace M1 expand, Task 6 (docs/specs/2026-10-18-multi-org.md sections 9, 13 and 15): team membership writes on
 * the new shapes. Rules 2118 (seats per account), 2124 (M1 half: leave and removal), 2125 (an admin of one account is
 * nobody in another), 2129 (write half: one team log row per event, never a token, an invite id or a password), 2132
 * (a legacy reader still sees R1's bytes) and 2139 (the lock order, and no half-written membership under races).
 *
 * The second membership of a legacy person (in an account that is not its home) is written with `writeMembership`, as
 * release M2's accept will: M1's own accept refuses an address that already signs in.
 */

afterEach(() => { vi.restoreAllMocks(); signOut(); });

const freshEmail = (p = "inv") => `${p}-${randomBytes(4).toString("hex")}@test.example`;
const ownerActor = (u: User): Actor => ({ kind: "owner", pid: storedPersonId(u.email), home: true, email: u.email, name: u.name, lang: u.lang, role: "owner" });
const withPlan = async (u: User, plan: Plan, seats?: number) => { const x = { ...(await getUser(u.email))!, plan, seats }; await saveUser(x); return x; };
const aidOf = (u: User): AccountId => storedAccountId(acct(u));
const resolveAs = async (email: string, account?: User) => { await signIn(email, account ? { acct: acct(account) } : {}); return currentUser(); };
/** Join a legacy person (`pid` = its address) to a second account, as M2's accept will: the row, the roster and `orgs:`. */
const joinElsewhere = (to: User, pid: PersonId, role: "admin" | "member" = "member") =>
  writeMembership(aidOf(to), pid, { aid: aidOf(to), pid, role, acceptedAt: new Date().toISOString(), invitedBy: storedPersonId(to.email) }, { home: false, teamLocked: true });
/** Every key a membership of `pid` in `aid` lives in, read in one round. */
const traces = async (aid: AccountId, pid: PersonId) => {
  const [row, listed, org, brandIn] = await Promise.all([db.get(accountKey.membership(aid, pid)), db.sismember(accountKey.members(aid), pid), db.sismember(personKey.orgs(pid), aid), db.get(personKey.activeBrand(pid, aid))]);
  return { row: row !== null, listed: !!listed, org: !!org, brandIn: brandIn !== null };
};
const kinds = async (u: User) => (await readTeamLog(aidOf(u))).map((r) => r.kind);
const invite = async (owner: User, role: "admin" | "member" = "member", actor = ownerActor(owner)) => {
  const r = await createInvite(owner, actor, freshEmail(), role, "ar");
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("rule 2118: seats are per account", () => {
  it("a person who is a member of A and B uses one seat in each; A's enforceSeats pauses only the A membership", async () => {
    const [A, B] = [await withPlan(await newUser("sa"), "pro"), await withPlan(await newUser("sb"), "pro")];
    const p = await newMember(A);
    const pid = storedPersonId(p.email);
    await joinElsewhere(B, pid);
    expect(await seatsUsed(A.email)).toBe(2);
    expect(await seatsUsed(B.email)).toBe(2);
    expect((await listMembers(acct(B))).map((m) => m.email)).toEqual([p.email]);

    await withPlan(A, "starter"); // one seat: the owner's
    expect((await enforceSeats(A.email)).disabled).toEqual([p.email]);
    expect((await getMembership(aidOf(A), pid))!.disabled).toBe("seats");
    expect((await getMembership(aidOf(B), pid))!.disabled).toBeUndefined();
    expect(await seatsUsed(A.email)).toBe(1);
    expect(await seatsUsed(B.email)).toBe(2);
    expect(await resolveAs(p.email, A)).toBeNull();
    expect(acct((await resolveAs(p.email, B))!)).toBe(acct(B));
    // B's own refit leaves A's pause alone.
    expect(await enforceSeats(B.email)).toEqual({ limit: 3, disabled: [], enabled: [], cancelled: [] });
    expect((await getMembership(aidOf(A), pid))!.disabled).toBe("seats");
  });
});

describe("rule 2124 (M1 half): leave and removal", () => {
  it("a removal deletes the row, the roster and orgs: entries, both active brands and the legacy record; the person keeps signing in to B", async () => {
    const [A, B] = [await newUser("ra"), await newUser("rb")];
    const p = await newMember(A);
    const pid = storedPersonId(p.email);
    await joinElsewhere(B, pid);
    await Promise.all([db.set(personKey.activeBrand(pid, aidOf(A)), "brandA00"), db.set(accountKey.activeBrand(p.email), "brandA00"), db.set(personKey.activeBrand(pid, aidOf(B)), "brandB00")]);

    expect(await removeMember(A, ownerActor(A), p.email)).toEqual({ ok: true });
    expect(await traces(aidOf(A), pid)).toEqual({ row: false, listed: false, org: false, brandIn: false });
    expect(await db.get(accountKey.member(p.email))).toBeNull();
    expect(await db.get(accountKey.activeBrand(p.email))).toBeNull();
    // B is untouched, and the person and its login stay: it still holds a membership.
    expect(await traces(aidOf(B), pid)).toEqual({ row: true, listed: true, org: true, brandIn: true });
    expect(await getPerson(pid)).not.toBeNull();
    expect(await getLogin(p.email)).not.toBeNull();
    expect(acct((await resolveAs(p.email, B))!)).toBe(acct(B));
    expect(await resolveAs(p.email, A)).toBeNull();
  });

  it("a member leaving its last account takes the person and the login with it; the owner cannot leave", async () => {
    // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
    const [A, B] = [await newUser("la", { shadow: false }), await newUser("lb", { shadow: false })];
    const p = await newMember(A, "member", "m", { shadow: false });
    const pid = storedPersonId(p.email);
    await joinElsewhere(B, pid);
    await db.set(accountKey.googleSub(p.email), "sub-123");

    const inA = (await resolveAs(p.email, A))!;
    expect(await leaveTeam(inA)).toEqual({ ok: true });
    expect(await traces(aidOf(A), pid)).toEqual({ row: false, listed: false, org: false, brandIn: false });
    expect(await db.get(accountKey.member(p.email))).toBeNull();
    expect(await getPerson(pid)).not.toBeNull(); // B is still held
    expect(await db.get(accountKey.googleSub(p.email))).toBe("sub-123");

    const inB = (await resolveAs(p.email, B))!;
    expect(inB.actor).toMatchObject({ kind: "member", pid });
    expect(await leaveTeam(inB)).toEqual({ ok: true });
    expect(await traces(aidOf(B), pid)).toEqual({ row: false, listed: false, org: false, brandIn: false });
    expect(await db.get(personKey.person(pid))).toBeNull();
    expect(await db.smembers(personKey.orgs(pid))).toEqual([]);
    expect(await getLogin(p.email)).toBeNull();
    expect(await db.get(accountKey.login(p.email))).toBeNull();
    expect(await db.get(accountKey.googleSub(p.email))).toBeNull(); // the login's security pack goes with it

    const owner = (await resolveAs(A.email))!;
    expect(await leaveTeam(owner)).toEqual({ ok: false, error: "forbidden" });
    expect(await getUser(A.email)).not.toBeNull();
  });

  it("a removal of a member with no other membership leaves no person, no login and no orgs: entry", async () => {
    // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
    const A = await newUser("rx", { shadow: false });
    const p = await newMember(A, "admin", "m", { shadow: false });
    const pid = storedPersonId(p.email);
    expect(await removeMember(A, ownerActor(A), p.email)).toEqual({ ok: true });
    expect(await getLogin(p.email)).toBeNull();
    expect(await db.get(personKey.person(pid))).toBeNull();
    expect(await db.smembers(personKey.orgs(pid))).toEqual([]);
    expect(await listMembers(acct(A))).toEqual([]);
  });
});

describe("rule 2125: an admin acts in its own account only", () => {
  it("an admin of A removes plain members of A only, cannot invite an admin, and is nobody in B", async () => {
    const [A, B] = [await withPlan(await newUser("aa"), "agency"), await withPlan(await newUser("ab"), "agency")];
    const [admin, plain, other] = [await newMember(A, "admin"), await newMember(A), await newMember(A, "admin")];
    const inB = await newMember(B);
    const u = (await resolveAs(admin.email))!;
    expect(u.actor).toMatchObject({ kind: "member", role: "admin" });

    expect(await removeMember(u, u.actor!, other.email)).toEqual({ ok: false, error: "forbidden" });
    expect(await createInvite(u, u.actor!, freshEmail(), "admin", "ar")).toEqual({ ok: false, error: "forbidden" });
    expect(await removeMember(u, u.actor!, plain.email)).toEqual({ ok: true });
    expect((await listMembers(acct(A))).map((m) => m.email).sort()).toEqual([admin.email, other.email].sort());

    // In B the admin of A holds nothing: no session there, and its actor carried onto B's account is refused.
    expect(await resolveAs(admin.email, B)).toBeNull();
    const ownerB = (await getUser(B.email))!;
    expect(await removeMember(ownerB, u.actor!, inB.email)).toEqual({ ok: false, error: "forbidden" });
    expect(await createInvite(ownerB, u.actor!, freshEmail(), "member", "ar")).toEqual({ ok: false, error: "forbidden" });
    expect((await listMembers(acct(B))).map((m) => m.email)).toEqual([inB.email]);
  });
});

describe("rule 2129 (write half): the team log", () => {
  it("each membership event writes exactly one row, newest first, with the actor, the target and via", async () => {
    const A = await withPlan(await newUser("ta"), "agency");
    const oa = ownerActor(A);
    const log = () => kinds(A);

    const inv = await invite(A);
    expect(await log()).toEqual(["invited"]);
    expect((await readTeamLog(aidOf(A)))[0]).toMatchObject({ kind: "invited", actor: { pid: oa.pid, email: A.email }, target: { email: inv.invite.email }, role: "member", via: "web" });

    expect(await cancelInvite(A, oa, inv.id)).toEqual({ ok: true });
    expect(await log()).toEqual(["invite_cancelled", "invited"]);

    const inv2 = await invite(A);
    const joined = await acceptInvite(inv2.token, { name: "Joiner", password: "abc12345" });
    if (!joined.ok) throw new Error(joined.error);
    const jpid = storedPersonId(joined.member.email);
    expect(await log()).toEqual(["joined", "invited", "invite_cancelled", "invited"]);
    expect((await readTeamLog(aidOf(A)))[0]).toMatchObject({ kind: "joined", actor: { pid: jpid }, target: { pid: jpid, email: joined.member.email }, role: "member", via: "web" });

    expect(await setRole(A, oa, joined.member.email, "admin")).toEqual({ ok: true });
    expect(await setRole(A, oa, joined.member.email, "admin")).toEqual({ ok: true }); // no change, no row
    expect((await log())[0]).toBe("role_changed");
    expect((await log()).length).toBe(5);

    await withPlan(A, "starter");
    expect((await enforceSeats(A.email)).disabled).toEqual([joined.member.email]);
    await withPlan(A, "agency");
    expect((await enforceSeats(A.email)).enabled).toEqual([joined.member.email]);
    expect((await log()).slice(0, 2)).toEqual(["resumed", "paused_for_seats"]);
    expect((await readTeamLog(aidOf(A)))[0]).toMatchObject({ via: "system", actor: { pid: oa.pid } });

    expect(await removeMember(A, oa, joined.member.email)).toEqual({ ok: true });
    expect((await log())[0]).toBe("removed");

    const m = await newMember(A);
    const u = (await resolveAs(m.email))!;
    expect(await leaveTeam(u)).toEqual({ ok: true });
    expect((await readTeamLog(aidOf(A)))[0]).toMatchObject({ kind: "left", actor: { pid: storedPersonId(m.email), email: m.email }, target: { pid: storedPersonId(m.email) }, via: "web" });

    // The founder console and the invite route's own rollback: one row each, staff never named.
    const f = await newMember(A);
    expect(await forceRemoveMember(f.email)).toBe(true);
    expect((await readTeamLog(aidOf(A)))[0]).toMatchObject({ kind: "removed", actor: { pid: oa.pid, email: A.email }, target: { email: f.email }, via: "console" });
    const inv3 = await invite(A);
    await discardInvite(acct(A), inv3.id);
    expect((await readTeamLog(aidOf(A)))[0]).toMatchObject({ kind: "invite_cancelled", target: { email: inv3.invite.email }, via: "system" });
    expect(await log()).toEqual(["invite_cancelled", "invited", "removed", "left", "removed", "resumed", "paused_for_seats", "role_changed", "joined", "invited", "invite_cancelled", "invited"]);
  });

  it("no row holds a token, an invite id or a password hash", async () => {
    const A = await withPlan(await newUser("tt"), "agency");
    const [i1, i2] = [await invite(A), await invite(A)];
    await cancelInvite(A, ownerActor(A), i1.id);
    const j = await acceptInvite(i2.token, { name: "Joiner", password: "abc12345" });
    if (!j.ok) throw new Error(j.error);
    await removeMember(A, ownerActor(A), j.member.email);
    const raw = (await db.lrange(accountKey.teamLog(aidOf(A)), 0, -1)).join("\n");
    expect(raw.split("\n")).toHaveLength(5); // invited twice, invite_cancelled, joined, removed
    expect(raw).not.toMatch(/[a-f0-9]{64}/);
    for (const s of [i1.token, i1.id, i2.token, i2.id]) expect(raw).not.toContain(s);
    expect(raw).not.toMatch(/passHash|\$2[aby]\$/);
    // The writer takes named fields only: an extra field never reaches the store.
    await logTeam(aidOf(A), { kind: "invited", actor: { pid: "x", email: "x@test.example" }, target: { email: "y@test.example" }, via: "web", token: i1.token } as never, { teamLocked: true });
    expect(await db.lrange(accountKey.teamLog(aidOf(A)), 0, 0)).not.toContain(i1.token);
    expect((await db.lrange(accountKey.teamLog(aidOf(A)), 0, 0))[0]).not.toContain("token");
  });

  it("the list is capped at 500, newest kept", async () => {
    const A = await newUser("tc");
    const aid = aidOf(A);
    await Promise.all(Array.from({ length: 505 }, (_, i) => logTeam(aid, { kind: "invited", actor: { pid: "p", email: A.email }, target: { email: `t${i}@test.example` }, via: "web" }, { teamLocked: true })));
    expect(await db.lrange(accountKey.teamLog(aid), 0, -1)).toHaveLength(500);
    expect(await readTeamLog(aid)).toHaveLength(500);
  });

  it("a refused action writes no row", async () => {
    const A = await withPlan(await newUser("tr"), "pro");
    const oa = ownerActor(A);
    const admin = await newMember(A, "admin");
    const au = (await resolveAs(admin.email))!;
    const inv = await invite(A); // the one row this test expects; 3 seats are now in use
    const before = await kinds(A);
    expect(before).toEqual(["invited"]);
    const refused = [
      await createInvite(A, oa, freshEmail(), "owner", "ar"),
      await createInvite(A, oa, A.email, "member", "ar"),
      await createInvite(A, oa, freshEmail(), "member", "ar"), // seats
      await createInvite(au, au.actor!, freshEmail(), "admin", "ar"),
      await cancelInvite(au, au.actor!, "0".repeat(64)),
      await removeMember(A, oa, freshEmail()),
      await removeMember(au, au.actor!, admin.email),
      await setRole(A, oa, freshEmail(), "admin"),
      await setRole(A, oa, admin.email, "owner"),
      await leaveTeam((await resolveAs(A.email))!),
      await acceptInvite(inv.token, { name: "J", password: "short" }),
      await acceptInvite("f".repeat(64), { name: "J", password: "abc12345" }),
    ];
    expect(refused.every((r) => !r.ok)).toBe(true);
    expect(await forceRemoveMember(freshEmail())).toBe(false);
    expect(await kinds(A)).toEqual(before);
  });
});

describe("rule 2139: the lock order, and no half-written membership under races", () => {
  const RANK: [RegExp, number][] = [[/^inviteuse:/, 0], [/^lock:team:/, 1], [/^lock:login:/, 2], [/^lock:person:/, 3], [/^lock:member:/, 4], [/^lock:user:/, 5]];
  const rank = (k: string) => RANK.find(([re]) => re.test(k))?.[1];
  /** Spy on db.lock / db.unlock: the kinds of lock in the order taken, and every lock taken while an inner one (or a larger key of its own kind) is held. */
  function lockSpy() {
    const taken: string[] = [];
    const held = new Set<string>();
    const nesting: string[] = [];
    const realLock = db.lock.bind(db);
    const realUnlock = db.unlock.bind(db);
    vi.spyOn(db, "lock").mockImplementation(async (key: string, ttl: number) => {
      const got = await realLock(key, ttl);
      const r = rank(key);
      if (got && r !== undefined) {
        // Two locks of one kind (an address move holds both logins and both persons) are taken smaller key first.
        for (const h of held) if (rank(h)! > r || (rank(h) === r && h >= key)) nesting.push(`${key} taken while holding ${h}`);
        held.add(key);
        taken.push(key.replace(/^(inviteuse|lock:[a-z]+):.*$/, "$1"));
      }
      return got;
    });
    vi.spyOn(db, "unlock").mockImplementation(async (key: string) => {
      held.delete(key);
      return realUnlock(key);
    });
    return { taken, nesting };
  }

  it("accept takes inviteuse → lock:team → lock:login → lock:person → lock:member, and never an outer lock under an inner one", async () => {
    const A = await newUser("lo");
    const inv = await invite(A);
    const spy = lockSpy();
    const r = await acceptInvite(inv.token, { name: "Locker", password: "abc12345" });
    expect(r.ok).toBe(true);
    expect(spy.taken).toEqual(["inviteuse", "lock:team", "lock:login", "lock:person", "lock:member"]);
    expect(spy.nesting).toEqual([]);
  });

  it("removal, leave, a role change, a seat refit and an address move nest their locks in the same order", async () => {
    const A = await withPlan(await newUser("ln"), "agency");
    const [a, b, c] = [await newMember(A), await newMember(A), await newMember(A)];
    const spy = lockSpy();
    expect(await removeMember(A, ownerActor(A), a.email)).toEqual({ ok: true });
    expect(spy.taken).toEqual(["lock:team", "lock:login", "lock:person", "lock:member"]);
    const u = (await resolveAs(b.email))!;
    expect(await leaveTeam(u)).toEqual({ ok: true });
    expect(await setRole(A, ownerActor(A), c.email, "admin")).toEqual({ ok: true });
    await withPlan(A, "starter");
    await enforceSeats(A.email);
    const { moveMemberLogin } = await import("@/lib/team");
    expect(await moveMemberLogin(acct(A), c.email, freshEmail("moved"))).toBe("ok");
    expect(spy.nesting).toEqual([]);
  });

  it("a person lock that cannot be had answers busy with nothing deleted and no row; the retry removes the member", async () => {
    // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
    const A = await newUser("lb", { shadow: false });
    const m = await newMember(A, "member", "m", { shadow: false });
    const pid = storedPersonId(m.email);
    await signIn(A.email);
    const del = () => memberRoute.DELETE(json("/api/team/member", "DELETE", { email: m.email }));
    await db.lock(personKey.lock(pid), 10);
    try {
      const r = await del();
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "busy" });
    } finally {
      await db.unlock(personKey.lock(pid));
    }
    expect(await traces(aidOf(A), pid)).toMatchObject({ row: true, listed: true, org: true });
    expect(await db.get(accountKey.member(m.email))).not.toBeNull();
    expect(await kinds(A)).toEqual([]);
    expect((await del()).status).toBe(200);
    expect(await traces(aidOf(A), pid)).toMatchObject({ row: false, listed: false, org: false });
    expect(await getLogin(m.email)).toBeNull();
    expect(await kinds(A)).toEqual(["removed"]);
  }, 20_000);

  it("accept, removal and leave racing never leave a row without its roster entry, the reverse, or orgs: naming a missing membership", async () => {
    // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
    for (let i = 0; i < 20; i++) {
      const A = await withPlan(await newUser("race", { shadow: false }), "agency");
      const aid = aidOf(A);
      const [p, q] = [await newMember(A, "member", "m", { shadow: false }), await newMember(A, "member", "m", { shadow: false })];
      const inv = await invite(A);
      const qu = (await resolveAs(q.email))!;
      const pu = (await resolveAs(p.email))!;
      await Promise.all([
        acceptInvite(inv.token, { name: "Racer", password: "abc12345" }),
        removeMember(A, ownerActor(A), inv.invite.email),
        removeMember(A, ownerActor(A), p.email),
        leaveTeam(pu),
        leaveTeam(qu),
        removeMember(A, ownerActor(A), q.email),
      ]);
      for (const email of [p.email, q.email, inv.invite.email]) {
        const pid = storedPersonId(email);
        const t = await traces(aid, pid);
        expect(t.row, `${i} ${email}`).toBe(t.listed);
        expect(t.org, `${i} ${email}`).toBe(t.row);
        const orgs = await db.smembers(personKey.orgs(pid));
        const rows = await Promise.all(orgs.map((o) => db.get(accountKey.membership(storedAccountId(o), pid))));
        expect(rows.every((r) => r !== null), `${i} ${email}`).toBe(true);
        // A person with no membership left has no login either; one with a membership signs in.
        expect(!!(await getLogin(email)), `${i} ${email}`).toBe(t.row);
      }
      expect(await traces(aid, storedPersonId(p.email))).toMatchObject({ row: false });
      expect(await traces(aid, storedPersonId(q.email))).toMatchObject({ row: false });
    }
  }, 120_000);
});

describe("rule 2139: a lock that cannot be had writes nothing, and the retry finishes (Task 6 fix round 1)", () => {
  /** Run `fn` while `key` is held by someone else, then release it. */
  const holding = async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    expect(await db.lock(key, 10)).toBe(true);
    try { return await fn(); } finally { await db.unlock(key); }
  };
  /** Whether the owner's account is still whole: the record, its login index and its `users:all` entry. */
  const ownerWhole = async (o: User) => {
    const [rec, login, listed] = await Promise.all([db.get(accountKey.user(acct(o))), getLogin(o.email), db.sismember(globalKey.usersAll(), acct(o))]);
    return { rec: rec !== null, login: login !== null, listed: !!listed };
  };

  it("accept with the new person's lock held answers busy and writes no member:, roster entry, mbr:, person or login; the retry joins", async () => {
    const A = await newUser("ap");
    const inv = await invite(A);
    const e = inv.invite.email;
    const pid = storedPersonId(e);
    const accept = () => acceptRoute.POST(json("/api/team/accept", "POST", { token: inv.token, name: "Late", password: "abc12345" }));
    const r = await holding(personKey.lock(pid), accept);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "busy" });
    expect(await db.get(accountKey.member(e))).toBeNull();
    expect(await traces(aidOf(A), pid)).toMatchObject({ row: false, listed: false, org: false });
    expect(await db.get(personKey.person(pid))).toBeNull();
    expect(await getLogin(e)).toBeNull();
    expect(await kinds(A)).toEqual(["invited"]);
    expect((await accept()).status).toBe(200);
    expect(await db.get(accountKey.member(e))).not.toBeNull();
    expect(await traces(aidOf(A), pid)).toMatchObject({ row: true, listed: true, org: true });
    expect(await getLogin(e)).not.toBeNull();
    expect(await kinds(A)).toEqual(["joined", "invited"]);
  }, 20_000);

  it("an owner's account DELETE with a member's person lock held answers busy with the owner's record, login and users:all intact; the retry wipes", async () => {
    // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
    const A = await newUser("dw", { shadow: false });
    const m = await newMember(A, "member", "m", { shadow: false });
    const pid = storedPersonId(m.email);
    await signIn(A.email);
    const del = () => accountRoute.DELETE(json("/api/account", "DELETE", { password: "abc12345" }));
    const r = await holding(personKey.lock(pid), del);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, error: "busy" });
    expect(await ownerWhole(A)).toEqual({ rec: true, login: true, listed: true });
    expect(await traces(aidOf(A), pid)).toMatchObject({ row: true, listed: true });
    expect(await getLogin(m.email)).not.toBeNull();
    // The owner still signs in, so the "try again" is true.
    expect(acct((await currentUser())!)).toBe(acct(A));
    expect((await del()).status).toBe(200);
    expect(await ownerWhole(A)).toEqual({ rec: false, login: false, listed: false });
    expect(await traces(aidOf(A), pid)).toMatchObject({ row: false, listed: false, org: false });
    expect(await getLogin(m.email)).toBeNull();
    expect(await db.get(accountKey.member(m.email))).toBeNull();
  }, 20_000);

  it("the console's delete with a member's person lock held answers busy with the owner's account whole; the retry wipes", async () => {
    // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
    vi.stubEnv("WAITLIST_ADMIN_KEY", "mo-team-admin-key-0123456789");
    try {
      const A = await newUser("cw", { shadow: false });
      const m = await newMember(A, "member", "m", { shadow: false });
      const pid = storedPersonId(m.email);
      signOut();
      await adminSignIn();
      const del = () => adminUserRoute.POST(json(`/api/admin/users/${encodeURIComponent(A.email)}`, "POST", { action: "delete" }), params({ email: encodeURIComponent(A.email) }));
      const r = await holding(personKey.lock(pid), del);
      expect(r.status).toBe(409);
      expect(await ownerWhole(A)).toEqual({ rec: true, login: true, listed: true });
      expect(await traces(aidOf(A), pid)).toMatchObject({ row: true, listed: true });
      expect((await del()).status).toBe(200);
      expect(await ownerWhole(A)).toEqual({ rec: false, login: false, listed: false });
      expect(await getLogin(m.email)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 20_000);

  it("a login lock held during a removal, a leave or the console's removal answers 409 with the membership whole", async () => {
    // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
    vi.stubEnv("WAITLIST_ADMIN_KEY", "mo-team-admin-key-0123456789");
    try {
      const A = await newUser("ll", { shadow: false });
      const m = await newMember(A, "member", "m", { shadow: false });
      const pid = storedPersonId(m.email);
      const lock = accountKey.loginLock(m.email);
      await signIn(A.email);
      expect((await holding(lock, () => memberRoute.DELETE(json("/api/team/member", "DELETE", { email: m.email })))).status).toBe(409);
      await signIn(m.email);
      expect((await holding(lock, () => leaveRoute.POST())).status).toBe(409);
      signOut();
      await adminSignIn();
      const force = () => adminUserRoute.POST(json(`/api/admin/users/${encodeURIComponent(m.email)}`, "POST", { action: "removeMember" }), params({ email: encodeURIComponent(m.email) }));
      expect((await holding(lock, force)).status).toBe(409);
      expect(await traces(aidOf(A), pid)).toMatchObject({ row: true, listed: true, org: true });
      expect(await db.get(accountKey.member(m.email))).not.toBeNull();
      expect(await getLogin(m.email)).not.toBeNull();
      expect(await kinds(A)).toEqual([]);
      expect((await force()).status).toBe(200);
      expect(await getLogin(m.email)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it("a stale member lock stops a removal before its first delete; the retry removes the member", async () => {
    const A = await newUser("sm");
    const m = await newMember(A);
    const pid = storedPersonId(m.email);
    await signIn(A.email);
    const del = () => memberRoute.DELETE(json("/api/team/member", "DELETE", { email: m.email }));
    expect((await holding(accountKey.memberLock(m.email), del)).status).toBe(409);
    expect(await traces(aidOf(A), pid)).toMatchObject({ row: true, listed: true, org: true });
    expect(await db.get(accountKey.member(m.email))).not.toBeNull();
    expect(await getLogin(m.email)).not.toBeNull();
    expect(await kinds(A)).toEqual([]);
    expect((await del()).status).toBe(200);
    expect(await traces(aidOf(A), pid)).toMatchObject({ row: false, listed: false, org: false });
    expect(await db.get(accountKey.member(m.email))).toBeNull();
  }, 20_000);

  it("an owner move never wipes an account with a team: refused before the first write; once the team is gone it moves", async () => {
    const A = await newUser("mt", { verified: false });
    const m = await newMember(A);
    const to = freshEmail("mtto");
    expect(await moveUnverifiedAccount((await getUser(A.email))!, to)).toBe("not_allowed");
    expect(await db.get(accountKey.user(to))).toBeNull();
    expect(await getLogin(to)).toBeNull();
    expect(await ownerWhole(A)).toEqual({ rec: true, login: true, listed: true });
    expect(await removeMember(A, ownerActor(A), m.email)).toEqual({ ok: true });
    expect(await moveUnverifiedAccount((await getUser(A.email))!, to)).toBe("ok");
    expect(await db.get(accountKey.user(acct(A)))).toBeNull();
    expect(await db.get(accountKey.user(to))).not.toBeNull();
  }, 20_000);
});

describe("rule 2139: the owner's records go last and first (Task 6 fix round 2)", () => {
  const ownerWhole = async (o: User) => {
    const [rec, login, listed] = await Promise.all([db.get(accountKey.user(acct(o))), getLogin(o.email), db.sismember(globalKey.usersAll(), acct(o))]);
    return { rec: rec !== null, login: login !== null, listed: !!listed };
  };

  it("an owner's DELETE with the owner's own login lock held answers busy with the account whole; the retry wipes", async () => {
    // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
    const A = await newUser("ol", { shadow: false });
    await signIn(A.email);
    const del = () => accountRoute.DELETE(json("/api/account", "DELETE", { password: "abc12345" }));
    const lock = accountKey.loginLock(A.email);
    expect(await db.lock(lock, 10)).toBe(true);
    let r: Response;
    try { r = await del(); } finally { await db.unlock(lock); }
    expect(r.status).toBe(409);
    expect(await ownerWhole(A)).toEqual({ rec: true, login: true, listed: true });
    expect(acct((await currentUser())!)).toBe(acct(A));
    expect((await del()).status).toBe(200);
    expect(await ownerWhole(A)).toEqual({ rec: false, login: false, listed: false });
  }, 20_000);

  it("the wipe deletes user:{owner} before the owner's login index and before any other key of the account", async () => {
    // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
    const A = await newUser("od", { shadow: false });
    const order: string[] = [];
    const real = db.del.bind(db);
    vi.spyOn(db, "del").mockImplementation(async (k: string) => { order.push(k); return real(k); });
    const { wipeAccount } = await import("@/lib/account");
    await wipeAccount(acct(A));
    const at = (k: string) => order.indexOf(k);
    expect(at(accountKey.user(acct(A)))).toBeGreaterThanOrEqual(0);
    expect(at(accountKey.user(acct(A)))).toBeLessThan(at(accountKey.login(A.email)));
    expect(at(accountKey.user(acct(A)))).toBeLessThan(at(accountKey.brands(acct(A))));
    expect(at(accountKey.user(acct(A)))).toBeLessThan(at(`profile:${acct(A)}`));
  });

  describe("the proved address change", () => {
    /** A fresh code for `to` (no mail on this machine: the test deploy hands the code back). */
    const startFor = async (u: User, to: string) => startEmailChange(u, { kind: "owner", email: u.email }, to, "ar");
    const confirmAs = async (u: User, code: string) => confirmEmailChange((await getUser(u.email))!, { kind: "owner", email: u.email }, code, "ar");
    /** Run `inject` once, without waiting for it, when the move claims `login:{to}` (mid-move, under its locks). */
    const duringMove = (to: string, inject: () => void) => {
      let done = false;
      const real = db.set.bind(db) as (...a: unknown[]) => Promise<unknown>;
      vi.spyOn(db, "set").mockImplementation((async (...a: unknown[]) => {
        if (!done && a[0] === accountKey.login(to)) { done = true; inject(); }
        return real(...a);
      }) as typeof db.set);
    };
    const envs = () => { vi.stubEnv("APP_ENV", "test"); vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("MAIL_FROM", ""); };
    /** Nothing at the new address: no account record, `users:all` entry, person, account list or login index. */
    const nothingAt = async (to: string) => {
      const toPid = storedPersonId(to);
      expect(await db.get(accountKey.user(to))).toBeNull();
      expect(await db.sismember(globalKey.usersAll(), to)).toBeFalsy();
      expect(await db.get(personKey.person(toPid))).toBeNull();
      expect(await db.smembers(personKey.orgs(toPid))).toEqual([]);
      expect(await db.get(accountKey.login(to))).toBeNull();
    };

    it("an invite that exists refuses the move before any write", async () => {
      envs();
      try {
        const A = await newUser("pi");
        const to = freshEmail("pito");
        const s1 = await startFor(A, to);
        if (!s1.ok || !s1.devCode) throw new Error("no code");
        await invite(A);
        expect(await confirmAs(A, s1.devCode)).toEqual({ ok: false, error: "owner_has_data" });
        await nothingAt(to);
        expect(await ownerWhole(A)).toEqual({ rec: true, login: true, listed: true });
      } finally {
        vi.unstubAllEnvs();
      }
    }, 20_000);

    it("an accept attempted while the move holds lock:team waits and never joins; one account is left, at the new address, with the credits once", async () => {
      envs();
      try {
        const A = await newUser("pa");
        const to = freshEmail("pato");
        const credits = (await getUser(A.email))!.credits;
        // An invite the move's team check does not see (out of the index), put back while the move runs: the only way
        // an accept can be attempted mid-move now that no invite can be created during it.
        const inv = await invite(A);
        await db.srem(accountKey.invites(acct(A)), inv.id);
        const s1 = await startFor((await getUser(A.email))!, to);
        if (!s1.ok || !s1.devCode) throw new Error("no code");
        let held: boolean | null = null;
        let accept: Promise<unknown> = Promise.resolve();
        duringMove(to, () => {
          accept = (async () => {
            held = !(await db.lock(accountKey.teamLock(acct(A)), 1));
            await db.sadd(accountKey.invites(acct(A)), inv.id);
            return acceptInvite(inv.token, { name: "Late", password: "abc12345" });
          })().catch((e: unknown) => e);
        });
        expect(await confirmAs(A, s1.devCode)).toEqual({ ok: true, to });
        const r = await accept;
        vi.restoreAllMocks();
        expect(held).toBe(true);
        // Either the wait ran out, or the accept got the lock after the move and found no owner and no invite.
        expect(r instanceof Error ? r.message : r).toSatisfy((x: unknown) => x === "team_lock_timeout" || (typeof x === "object" && x !== null && (x as { ok?: boolean }).ok === false));
        expect(await getLogin(inv.invite.email)).toBeNull();
        expect(await db.get(accountKey.member(inv.invite.email))).toBeNull();
        expect(await db.get(accountKey.user(acct(A)))).toBeNull();
        expect(await db.sismember(globalKey.usersAll(), acct(A))).toBeFalsy();
        expect((await getUser(to))!.credits).toBe(credits);
        expect(await db.smembers(accountKey.members(acct(A)))).toEqual([]);
        expect(await db.smembers(accountKey.members(to))).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    }, 20_000);

    it("a lock:team that cannot be had at the move's start answers busy with nothing at the new address; a new code is not refused as taken", async () => {
      envs();
      try {
        const A = await newUser("pb");
        const to = freshEmail("pbto");
        const s1 = await startFor(A, to);
        if (!s1.ok || !s1.devCode) throw new Error("no code");
        await signIn(A.email);
        const { POST } = await import("@/app/api/account/email/route");
        const lock = accountKey.teamLock(acct(A));
        expect(await db.lock(lock, 10)).toBe(true);
        let r: Response;
        try { r = await POST(json("/api/account/email", "POST", { action: "confirm", code: s1.devCode })); } finally { await db.unlock(lock); }
        expect(r.status).toBe(409);
        expect(await r.json()).toEqual({ ok: false, error: "busy" });
        await nothingAt(to);
        expect(await ownerWhole(A)).toEqual({ rec: true, login: true, listed: true });
        const again = await startFor((await getUser(A.email))!, to);
        expect(again).toMatchObject({ ok: true, to });
        if (!again.ok || !again.devCode) throw new Error("no code");
        expect(await confirmAs(A, again.devCode)).toEqual({ ok: true, to });
      } finally {
        vi.unstubAllEnvs();
      }
    }, 30_000);
  });
});

describe("rule 2132: a reader of R1's shapes sees R1's bytes", () => {
  it("after accept the legacy member record has exactly R1's fields in R1's order, and the roster names the address", async () => {
    const A = await newUser("r1");
    const inv = await invite(A);
    const j = await acceptInvite(inv.token, { name: "Legacy", password: "abc12345", lang: "en" });
    if (!j.ok) throw new Error(j.error);
    const e = inv.invite.email;
    const rec = await db.get<Record<string, unknown>>(accountKey.member(e));
    expect(Object.keys(rec!)).toEqual(["id", "email", "name", "lang", "passHash", "memberOf", "role", "invitedBy", "acceptedAt", "sessionsAfter"]);
    expect(rec).toMatchObject({ id: e, email: e, name: "Legacy", lang: "en", memberOf: acct(A), role: "member", invitedBy: A.email });
    expect(rec!.sessionsAfter).toBe(rec!.acceptedAt);
    expect(await db.sismember(accountKey.members(acct(A)), e)).toBeTruthy();

    // A role change and a seat pause write the same fields in place, in the same order; a resume deletes `disabled`.
    expect(await setRole(A, ownerActor(A), e, "admin")).toEqual({ ok: true });
    const after = await db.get<Record<string, unknown>>(accountKey.member(e));
    expect(Object.keys(after!)).toEqual(Object.keys(rec!));
    expect({ ...after, role: "member" }).toEqual(rec);
    await withPlan(A, "starter");
    await enforceSeats(A.email);
    expect(await db.get(accountKey.member(e))).toEqual({ ...after, disabled: "seats" });
    await withPlan(A, "agency");
    await enforceSeats(A.email);
    expect(await db.get(accountKey.member(e))).toEqual(after);
  });

  it("createInvite for an address that already signs in anywhere answers unavailable", async () => {
    const [A, B] = [await newUser("ua"), await newUser("ub")];
    const inB = await newMember(B);
    for (const e of [B.email, inB.email]) expect(await createInvite(A, ownerActor(A), e, "member", "ar")).toEqual({ ok: false, error: "unavailable" });
    expect(await kinds(A)).toEqual([]);
  });
});
