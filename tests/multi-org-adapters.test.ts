import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { getAccount, type User } from "@/lib/auth";
import { accountKey, personKey, storedAccountId, storedPersonId, type PersonId } from "@/lib/keys";
import { getPerson, personFromRaw, withPersonLock, type Person } from "@/lib/person";
import { getMembership, homeAccountOf, listOrgs, membershipFromRaw, membershipHolds, ownerOf, roleIn, type Membership } from "@/lib/membership";
import { isPersonSuspended, isSuspended } from "@/lib/suspension";
import { newPersonId } from "@/lib/multi-org";

/**
 * Multi-workspace membership, release M1 expand (docs/specs/2026-10-18-multi-org.md sections 2-4): the read adapters
 * `getPerson`, `getMembership`, `ownerOf`, `roleIn`, `listOrgs`, `homeAccountOf` and `isPersonSuspended`. Every fixture
 * is written with raw `db.set` / `db.sadd` through the key builders, never through the helpers under test.
 * Rules 2115 (partly), 2134, 2136.
 */

afterEach(() => vi.restoreAllMocks());

let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const address = (p: string) => `${p}-${uniq()}@test.example`;

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-05T00:00:00.000Z";
const T2 = "2026-10-10T00:00:00.000Z";
const T3 = "2026-10-15T00:00:00.000Z";

/** A legacy owner account record at `user:{id}`, R1-shaped. */
function account(id: string, over: Partial<User> = {}): User {
  return { id, email: id, name: "Owner Name", phone: "", passHash: "hash-owner", plan: "trial", credits: 40, trialEnds: T3, createdAt: T0, lang: "en", emailVerifiedAt: T0, sessionsAfter: T0, ...over } as User;
}
/** A legacy member record at `member:{email}`, R1-shaped. */
const legacyMember = (email: string, memberOf: string, over: Record<string, unknown> = {}) => ({
  id: email, email, name: "Member Name", lang: "en", passHash: "hash-member", memberOf, role: "member", invitedBy: memberOf, acceptedAt: T1, sessionsAfter: T1, ...over,
});
const personRow = (pid: string, email: string, over: Record<string, unknown> = {}) => ({ pid, email, name: "Person Name", lang: "ar", passHash: "hash-person", sessionsAfter: T1, createdAt: T0, ...over });
const mbrRow = (aid: string, pid: string, over: Record<string, unknown> = {}) => ({ aid, pid, role: "admin", acceptedAt: T1, invitedBy: "p_inviterinviterinviterinv", ...over });

async function putAccount(u: User) {
  await db.set(accountKey.user(u.id!), u);
  return storedAccountId(u.id!);
}

/**
 * Counts Redis rounds: a call is in round r when it is issued before any result of round r is delivered. Results are
 * delivered on a later macrotask, so every call a function issues in one `Promise.all` lands in the same round.
 */
function trackRounds(methods: readonly ("get" | "sismember" | "smembers")[]) {
  let round = 0;
  const calls: { round: number; op: string; key: string }[] = [];
  for (const name of methods) {
    const real = (db[name] as (...a: unknown[]) => Promise<unknown>).bind(db);
    vi.spyOn(db, name).mockImplementation(((key: string, ...rest: unknown[]) => {
      const r = round;
      calls.push({ round: r, op: name, key });
      return (async () => {
        const v = await real(key, ...rest);
        await new Promise((res) => setTimeout(res, 0));
        round = Math.max(round, r + 1);
        return v;
      })();
    }) as never);
  }
  return { calls, rounds: () => new Set(calls.map((c) => c.round)).size };
}

describe("rule 2134: getPerson reads person:, then the legacy owner, then the legacy member", () => {
  it("person: wins over user: and member: holding the same id", async () => {
    const e = address("prec");
    const pid = storedPersonId(e);
    await putAccount(account(e, { passHash: "hash-owner" }));
    await db.set(accountKey.member(e), legacyMember(e, address("other")));
    await db.set(personKey.person(pid), personRow(e, e, { passHash: "hash-person", sessionsAfter: T0 }));
    const p = await getPerson(pid);
    expect(p).toMatchObject({ pid, source: "person", passHash: "hash-person", email: e, name: "Person Name", lang: "ar" });
  });

  it("a legacy owner maps only the credential fields (suspension, plan and credits stay on the account)", async () => {
    const e = address("own");
    const pid = storedPersonId(e);
    await putAccount(account(e, { suspended: true, devicesAfter: T2, name: "Ann" }));
    const p = await getPerson(pid);
    expect(p).toEqual({ pid, source: "owner", email: e, name: "Ann", lang: "en", passHash: "hash-owner", emailVerifiedAt: T0, sessionsAfter: T0, devicesAfter: T2, createdAt: T0 });
    expect(isPersonSuspended(p!)).toBe(false);
    expect(p).not.toHaveProperty("plan");
    expect(p).not.toHaveProperty("credits");
  });

  it("a legacy member maps its credentials, with createdAt = acceptedAt and no role or account", async () => {
    const e = address("mem");
    const pid = storedPersonId(e);
    await db.set(accountKey.member(e), legacyMember(e, address("team"), { devicesAfter: T2 }));
    const p = await getPerson(pid);
    expect(p).toEqual({ pid, source: "member", email: e, name: "Member Name", lang: "en", passHash: "hash-member", sessionsAfter: T1, devicesAfter: T2, createdAt: T1 });
  });

  it("a legacy owner record whose ownerPid names someone else is no person; ownerPid equal to the id is", async () => {
    const e = address("ownpid");
    const pid = storedPersonId(e);
    await putAccount(account(e, { ownerPid: newPersonId() }));
    expect(await getPerson(pid)).toBeNull();
    await putAccount(account(e, { ownerPid: e }));
    expect((await getPerson(pid))?.source).toBe("owner");
  });

  it("an account owned by a p_ person lends its passHash to nobody: the p_ id reads its own person: record", async () => {
    const e = address("pown");
    const pp = newPersonId();
    await putAccount(account(e, { ownerPid: pp, passHash: "hash-account" }));
    expect(await getPerson(storedPersonId(e))).toBeNull();
    expect(await getPerson(storedPersonId(pp))).toBeNull();
    await db.set(personKey.person(storedPersonId(pp)), personRow(pp, e));
    expect(await getPerson(storedPersonId(pp))).toMatchObject({ source: "person", passHash: "hash-person" });
  });

  it("a member record whose person id is not the key it was asked under is no person", async () => {
    const e = address("mpid");
    const other = address("mpid-other");
    // A record at member:{e} that holds another address (a rolled-back move copied it): its person id is `other`.
    await db.set(accountKey.member(e), legacyMember(other, address("team")));
    expect(await getPerson(storedPersonId(e))).toBeNull();
  });

  it("nothing stored, or nothing that parses, is no person; a person: row that does not parse falls back to the legacy record", async () => {
    const w = vi.spyOn(log, "warn");
    expect(await getPerson(storedPersonId(address("none")))).toBeNull();
    const e = address("bad");
    const pid = storedPersonId(e);
    await db.set(personKey.person(pid), { pid: e, passHash: "hash-broken" }); // no email
    expect(await getPerson(pid)).toBeNull();
    await putAccount(account(e));
    expect(await getPerson(pid)).toMatchObject({ source: "owner", passHash: "hash-owner" });
    expect(JSON.stringify(w.mock.calls)).not.toContain("hash-broken");
  });

  it("a stale person: (the legacy sessionsAfter is later: a password changed by a rolled-back build) loses, and is logged without values", async () => {
    const e = address("stale");
    const pid = storedPersonId(e);
    await putAccount(account(e, { passHash: "hash-new", sessionsAfter: T2, devicesAfter: T0 }));
    await db.set(personKey.person(pid), personRow(e, e, { passHash: "hash-old", sessionsAfter: T1, devicesAfter: T3, trialUsedAt: T1, suspended: true }));
    const w = vi.spyOn(log, "warn");
    const p = await getPerson(pid);
    expect(p).toMatchObject({ source: "owner", passHash: "hash-new", sessionsAfter: T2, name: "Owner Name", lang: "en", emailVerifiedAt: T0 });
    // Every field the owner record carries comes from it, except the revocation stamps: the later of both records
    // (the row's devicesAfter T3 beats the owner's older T0). Person-only fields stay from the row.
    expect(p?.devicesAfter).toBe(T3);
    expect(p?.trialUsedAt).toBe(T1);
    expect(isPersonSuspended(p!)).toBe(true);
    expect(w).toHaveBeenCalledWith("person stale", { shape: "person", source: "owner" });
    const logged = JSON.stringify(w.mock.calls);
    for (const v of ["hash-new", "hash-old", e]) expect(logged).not.toContain(v);
  });

  it("a stale person: by birth (the legacy record was created after it) loses; an equal or older legacy record does not", async () => {
    const e = address("born");
    const pid = storedPersonId(e);
    await db.set(personKey.person(pid), personRow(e, e, { passHash: "hash-leftover", sessionsAfter: T2, createdAt: T0 }));
    await db.set(accountKey.member(e), legacyMember(e, address("team"), { acceptedAt: T0, sessionsAfter: T0 }));
    expect(await getPerson(pid)).toMatchObject({ source: "person", passHash: "hash-leftover" });
    // A member re-created at the address after the person was written (by an older build).
    await db.set(accountKey.member(e), legacyMember(e, address("team"), { acceptedAt: T3, sessionsAfter: T0, passHash: "hash-fresh" }));
    // The leftover lends nothing: not even its later session stamp.
    expect(await getPerson(pid)).toEqual({ pid, source: "member", email: e, name: "Member Name", lang: "en", passHash: "hash-fresh", createdAt: T3, sessionsAfter: T0 });
    // An owner signed up at the address after the person was written.
    await putAccount(account(e, { createdAt: T3, sessionsAfter: T0, passHash: "hash-signup" }));
    expect(await getPerson(pid)).toMatchObject({ source: "owner", passHash: "hash-signup", sessionsAfter: T0 });
  });

  it("a verified leftover person lends no verification, trial or stamps to an unverified owner born later; a set suspension is kept", async () => {
    const e = address("leftover");
    const pid = storedPersonId(e);
    await db.set(personKey.person(pid), personRow(e, e, { passHash: "hash-leftover", emailVerifiedAt: T0, trialUsedAt: T0, sessionsAfter: T2, devicesAfter: T2, createdAt: T0 }));
    await putAccount(account(e, { createdAt: T3, emailVerifiedAt: undefined, sessionsAfter: undefined, passHash: "hash-signup", name: "New Human" }));
    const p = await getPerson(pid);
    expect(p).toEqual({ pid, source: "owner", email: e, name: "New Human", lang: "en", passHash: "hash-signup", createdAt: T3 });
    expect(p).not.toHaveProperty("emailVerifiedAt");
    expect(isPersonSuspended(p!)).toBe(false);
    // Fail closed: a suspension on the leftover row stays (it can never be lifted by a rebuild).
    await db.set(personKey.person(pid), personRow(e, e, { emailVerifiedAt: T0, suspended: true, createdAt: T0 }));
    const q = await getPerson(pid);
    expect(q).toMatchObject({ source: "owner", passHash: "hash-signup" });
    expect(q).not.toHaveProperty("emailVerifiedAt");
    expect(isPersonSuspended(q!)).toBe(true);
  });

  it("the same human, address changed by a rolled-back build (verification cleared): the new address reads unverified", async () => {
    const e = address("moved");
    const moved = address("NewAddr");
    const pid = storedPersonId(e);
    await db.set(personKey.person(pid), personRow(e, e, { emailVerifiedAt: T0, trialUsedAt: T0, sessionsAfter: T1, createdAt: T0 }));
    // The old build kept the account id and wrote the new address, cleared the verification and ended sessions.
    await putAccount(account(e, { email: moved, emailVerifiedAt: undefined, sessionsAfter: T2, devicesAfter: undefined }));
    const p = await getPerson(pid);
    expect(p).toMatchObject({ source: "owner", email: moved.toLowerCase(), sessionsAfter: T2, trialUsedAt: T0, passHash: "hash-owner" });
    expect(p).not.toHaveProperty("emailVerifiedAt");
    expect(p).not.toHaveProperty("devicesAfter");
  });

  it("the same-human merge keeps the later revocation stamp: a newer legacy record without devicesAfter never un-revokes a device", async () => {
    const e = address("devices");
    const pid = storedPersonId(e);
    await db.set(personKey.person(pid), personRow(e, e, { sessionsAfter: T1, devicesAfter: T3, createdAt: T0 }));
    await putAccount(account(e, { sessionsAfter: T2, devicesAfter: undefined, passHash: "hash-new" }));
    expect(await getPerson(pid)).toMatchObject({ source: "owner", passHash: "hash-new", sessionsAfter: T2, devicesAfter: T3 });
    // An older legacy devicesAfter loses to the row's later one too.
    await putAccount(account(e, { sessionsAfter: T2, devicesAfter: T1, passHash: "hash-new" }));
    expect(await getPerson(pid)).toMatchObject({ source: "owner", sessionsAfter: T2, devicesAfter: T3 });
  });

  it("the same-human merge never lets a PersonRow default (name, lang, createdAt) replace the row's real value", async () => {
    const e = address("defaults");
    const pid = storedPersonId(e);
    await db.set(personKey.person(pid), personRow(e, e, { name: "Person Name", lang: "en", sessionsAfter: T1, createdAt: T1 }));
    await putAccount(account(e, { name: undefined, lang: "xx" as never, createdAt: undefined, sessionsAfter: T2, passHash: "hash-new" }));
    const p = await getPerson(pid);
    expect(p).toMatchObject({ source: "owner", name: "Person Name", lang: "en", createdAt: T1, passHash: "hash-new", sessionsAfter: T2 });
  });

  it("makes exactly one round of three reads, and personFromRaw gives the same answer from the raw values", async () => {
    const e = address("round");
    const pid = storedPersonId(e);
    await putAccount(account(e));
    await db.set(accountKey.member(e), legacyMember(e, address("team")));
    await db.set(personKey.person(pid), personRow(e, e, { sessionsAfter: T3 }));
    const raws = await Promise.all([db.get(personKey.person(pid)), db.get(accountKey.user(pid)), db.get(accountKey.member(pid))]);
    const t = trackRounds(["get", "sismember", "smembers"]);
    const p = await getPerson(pid);
    expect(t.rounds()).toBe(1);
    expect(t.calls.map((c) => c.key).sort()).toEqual([accountKey.member(e), accountKey.user(e), personKey.person(pid)].sort());
    const before = t.calls.length;
    expect(personFromRaw(pid, ...raws)).toEqual(p);
    expect(t.calls.length).toBe(before); // pure: no read
  });
});

describe("rule 2134: getMembership reads mbr: and the roster, then the legacy member with memberOf and the roster", () => {
  it("mbr: wins over a legacy member record for the same account", async () => {
    const aid = await putAccount(account(address("acc")));
    const e = address("m");
    const pid = storedPersonId(e);
    await db.set(accountKey.membership(aid, pid), mbrRow(aid, e, { role: "member", invitedBy: "p_inviterinviterinviterinv" }));
    await db.set(accountKey.member(e), legacyMember(e, aid, { invitedBy: "someone@test.example" }));
    await db.sadd(accountKey.members(aid), pid);
    expect(await getMembership(aid, pid)).toEqual({ aid, pid, role: "member", acceptedAt: T1, invitedBy: "p_inviterinviterinviterinv", source: "mbr" });
  });

  it("a legacy member counts only with memberOf equal to the account AND the roster entry, read as {role, acceptedAt, invitedBy, disabled}", async () => {
    const aid = await putAccount(account(address("acc")));
    const otherAid = await putAccount(account(address("acc2")));
    const e = address("lm");
    const pid = storedPersonId(e);
    await db.set(accountKey.member(e), legacyMember(e, aid, { role: "admin", disabled: "seats" }));
    expect(await getMembership(aid, pid)).toBeNull(); // no roster entry
    await db.sadd(accountKey.members(aid), pid);
    expect(await getMembership(aid, pid)).toEqual({ aid, pid, role: "admin", acceptedAt: T1, invitedBy: aid, disabled: "seats", source: "member" });
    await db.sadd(accountKey.members(otherAid), pid);
    expect(await getMembership(otherAid, pid)).toBeNull(); // listed there, but memberOf is the other account
  });

  it("a row without its roster entry, and a roster entry without a row, both give null", async () => {
    const aid = await putAccount(account(address("acc")));
    const a = storedPersonId(newPersonId());
    const b = storedPersonId(newPersonId());
    await db.set(accountKey.membership(aid, a), mbrRow(aid, a));
    await db.sadd(accountKey.members(aid), b);
    expect(await getMembership(aid, a)).toBeNull();
    expect(await getMembership(aid, b)).toBeNull();
  });

  it("a row stored under another account or person grants nothing", async () => {
    const aid = await putAccount(account(address("acc")));
    const other = await putAccount(account(address("acc2")));
    const pid = storedPersonId(newPersonId());
    await db.set(accountKey.membership(aid, pid), mbrRow(other, pid));
    await db.sadd(accountKey.members(aid), pid);
    expect(await getMembership(aid, pid)).toBeNull();
  });

  it("a home membership whose two records disagree (a rolled-back demotion or pause) reads the stricter value, logged without values", async () => {
    const aid = await putAccount(account(address("acc")));
    const e = address("strict");
    const pid = storedPersonId(e);
    await db.set(accountKey.membership(aid, pid), mbrRow(aid, e, { role: "admin", acceptedAt: T1 }));
    await db.set(accountKey.member(e), legacyMember(e, aid, { role: "member", disabled: "seats", acceptedAt: T2 }));
    await db.sadd(accountKey.members(aid), pid);
    const w = vi.spyOn(log, "warn");
    expect(await getMembership(aid, pid)).toMatchObject({ role: "member", disabled: "seats", acceptedAt: T2, source: "mbr" });
    expect(w).toHaveBeenCalledWith("membership stale", { shape: "membership" });
    expect(JSON.stringify(w.mock.calls)).not.toContain(e);
    // In steady state the two agree, and nothing is logged.
    await db.set(accountKey.member(e), legacyMember(e, aid, { role: "admin", acceptedAt: T1 }));
    w.mockClear();
    expect(await getMembership(aid, pid)).toEqual({ aid, pid, role: "admin", acceptedAt: T1, invitedBy: "p_inviterinviterinviterinv", source: "mbr" });
    expect(w).not.toHaveBeenCalled();
  });

  it("fails closed: a resume or promotion made only on the legacy record (by a rolled-back build) grants nothing after roll-forward", async () => {
    const aid = await putAccount(account(address("acc")));
    const e = address("resumed");
    const pid = storedPersonId(e);
    // M1 paused and demoted the member (both records); the rolled-back build then resumed and promoted it, legacy only.
    await db.set(accountKey.membership(aid, pid), mbrRow(aid, e, { role: "member", disabled: "seats", acceptedAt: T1 }));
    await db.set(accountKey.member(e), legacyMember(e, aid, { role: "admin", acceptedAt: T1 }));
    await db.sadd(accountKey.members(aid), pid);
    const m = await getMembership(aid, pid);
    expect(m).toMatchObject({ role: "member", disabled: "seats", source: "mbr" });
    // The owner repeats the resume and the promotion (both records), and only then does it hold.
    await db.set(accountKey.membership(aid, pid), mbrRow(aid, e, { role: "admin", acceptedAt: T1 }));
    expect(await getMembership(aid, pid)).toMatchObject({ role: "admin", source: "mbr" });
    expect(await getMembership(aid, pid)).not.toHaveProperty("disabled");
  });

  it("makes exactly one round (two reads and one SISMEMBER), and membershipFromRaw gives the same answer", async () => {
    const aid = await putAccount(account(address("acc")));
    const pid = storedPersonId(newPersonId());
    await db.set(accountKey.membership(aid, pid), mbrRow(aid, pid));
    await db.sadd(accountKey.members(aid), pid);
    const t = trackRounds(["get", "sismember", "smembers"]);
    const m = await getMembership(aid, pid);
    expect(t.rounds()).toBe(1);
    expect(t.calls.map((c) => `${c.op} ${c.key}`).sort()).toEqual([`get ${accountKey.member(pid)}`, `get ${accountKey.membership(aid, pid)}`, `sismember ${accountKey.members(aid)}`].sort());
    expect(membershipFromRaw(aid, pid, mbrRow(aid, pid), null, true)).toEqual(m);
    expect(membershipFromRaw(aid, pid, mbrRow(aid, pid), null, false)).toBeNull();
  });
});

describe("rule 2115: a role belongs to a membership, and owner comes only from ownerOf", () => {
  it("admin in A is nothing in B", async () => {
    const A = account(address("a"));
    const B = account(address("b"));
    const [aid, bid] = [await putAccount(A), await putAccount(B)];
    const pid = storedPersonId(newPersonId());
    await db.set(accountKey.membership(aid, pid), mbrRow(aid, pid, { role: "admin" }));
    await db.sadd(accountKey.members(aid), pid);
    const inA = await getMembership(aid, pid);
    const inB = await getMembership(bid, pid);
    expect(roleIn(A, pid, inA)).toBe("admin");
    expect(inB).toBeNull();
    expect(roleIn(B, pid, inB)).toBeNull();
    expect(roleIn(B, pid, inA)).toBeNull(); // A's membership never counts in B
    expect(roleIn(A, storedPersonId(newPersonId()), inA)).toBeNull(); // nor for another person
  });

  it("owner only from ownerOf: the legacy owner is acct(u), an ownerPid replaces it", async () => {
    const e = address("o");
    const legacy = account(e);
    expect(ownerOf(legacy)).toBe(e);
    expect(roleIn(legacy, storedPersonId(e), null)).toBe("owner");
    const pp = storedPersonId(newPersonId());
    const owned = account(e, { ownerPid: pp });
    expect(ownerOf(owned)).toBe(pp);
    expect(roleIn(owned, pp, null)).toBe("owner");
    expect(roleIn(owned, storedPersonId(e), null)).toBeNull();
    expect(ownerOf({ email: "pre-r1@test.example" })).toBe("pre-r1@test.example");
  });

  it("a mbr: row claiming owner does not parse, reads as no membership and gives no role", async () => {
    const A = account(address("a"));
    const aid = await putAccount(A);
    const pid = storedPersonId(newPersonId());
    await db.set(accountKey.membership(aid, pid), mbrRow(aid, pid, { role: "owner" }));
    await db.sadd(accountKey.members(aid), pid);
    const m = await getMembership(aid, pid);
    expect(m).toBeNull();
    expect(roleIn(A, pid, m)).toBeNull();
    // A legacy member record claiming owner is refused the same way.
    const e = address("lo");
    await db.set(accountKey.member(e), legacyMember(e, aid, { role: "owner" }));
    await db.sadd(accountKey.members(aid), storedPersonId(e));
    expect(await getMembership(aid, storedPersonId(e))).toBeNull();
  });

  it("a paused membership gives no role; membershipHolds keeps today's member guards", () => {
    const A = account(address("a"), { createdAt: T1 });
    const pid = storedPersonId(newPersonId());
    const m = (over: Partial<Membership> = {}): Membership => ({ aid: storedAccountId(A.id!), pid, role: "member", acceptedAt: T2, invitedBy: "", source: "mbr", ...over });
    expect(roleIn(A, pid, m({ disabled: "seats" }))).toBeNull();
    expect(membershipHolds(A, m())).toBe(true);
    expect(membershipHolds(A, m({ acceptedAt: T1 }))).toBe(true);
    expect(membershipHolds(A, m({ acceptedAt: T0 }))).toBe(false); // accepted before the account existed
    expect(membershipHolds(A, m({ acceptedAt: "not a date" }))).toBe(false);
    expect(membershipHolds({ ...A, createdAt: "garbage" }, m())).toBe(false);
    expect(membershipHolds(A, m({ disabled: "seats" }))).toBe(false);
    expect(membershipHolds(A, m({ aid: storedAccountId("other@test.example") }))).toBe(false);
    expect(membershipHolds(A, m({ role: "owner" as never }))).toBe(false);
  });
});

describe("rule 2136: orgs:{pid} is a hint, re-checked on the forward records", () => {
  async function graph() {
    const pid = storedPersonId(newPersonId());
    const owned = await putAccount(account(address("own"), { ownerPid: pid }));
    const older = await putAccount(account(address("old")));
    const newer = await putAccount(account(address("new")));
    const paused = await putAccount(account(address("paused")));
    const unlisted = await putAccount(account(address("unlisted")));
    const forged = await putAccount(account(address("forged")));
    const gone = storedAccountId(address("gone"));
    await Promise.all([
      db.set(accountKey.membership(newer, pid), mbrRow(newer, pid, { role: "member", acceptedAt: T2 })),
      db.set(accountKey.membership(older, pid), mbrRow(older, pid, { role: "admin", acceptedAt: T1 })),
      db.set(accountKey.membership(paused, pid), mbrRow(paused, pid, { disabled: "seats" })),
      db.set(accountKey.membership(unlisted, pid), mbrRow(unlisted, pid)),
      db.set(accountKey.membership(gone, pid), mbrRow(gone, pid)),
      db.sadd(accountKey.members(newer), pid),
      db.sadd(accountKey.members(older), pid),
      db.sadd(accountKey.members(paused), pid),
      db.sadd(accountKey.members(gone), pid),
    ]);
    await Promise.all([owned, older, newer, paused, unlisted, forged, gone].map((a) => db.sadd(personKey.orgs(pid), a)));
    return { pid, owned, older, newer, forged };
  }

  it("a forged, unlisted, paused or gone entry is skipped; owned first, then the oldest membership", async () => {
    const g = await graph();
    expect(await listOrgs(g.pid)).toEqual([
      { aid: g.owned, role: "owner" },
      { aid: g.older, role: "admin" },
      { aid: g.newer, role: "member" },
    ]);
  });

  it("a forged entry grants nothing: no membership, no role", async () => {
    const g = await graph();
    const u = await getAccount(g.forged);
    const m = await getMembership(g.forged, g.pid);
    expect(m).toBeNull();
    expect(roleIn(u!, g.pid, m)).toBeNull();
  });

  it("an entry whose membership was accepted before the account was created is skipped (a re-registered address)", async () => {
    const pid = storedPersonId(newPersonId());
    const aid = await putAccount(account(address("rereg"), { createdAt: T3 }));
    await Promise.all([db.set(accountKey.membership(aid, pid), mbrRow(aid, pid, { acceptedAt: T1 })), db.sadd(accountKey.members(aid), pid), db.sadd(personKey.orgs(pid), aid)]);
    expect(await listOrgs(pid)).toEqual([]);
  });

  it("reads the index, then every entry in ONE more round", async () => {
    const g = await graph();
    const t = trackRounds(["get", "sismember", "smembers"]);
    await listOrgs(g.pid);
    expect(t.rounds()).toBe(2);
    expect(t.calls.filter((c) => c.round === 0).map((c) => c.key)).toEqual([personKey.orgs(g.pid)]);
    expect(t.calls.filter((c) => c.round === 1)).toHaveLength(7 * 4); // per entry: account, mbr:, member:, roster
  });

  it("src/lib/membership.ts and src/lib/person.ts hold no loop at all: lists go through pmap (no await db.* in a loop)", () => {
    for (const f of ["src/lib/membership.ts", "src/lib/person.ts"]) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code.match(/\b(for|while|do)\s*[({]/g), f).toBeNull();
      expect(code.match(/\.forEach\(/g), f).toBeNull();
    }
    expect(readFileSync("src/lib/membership.ts", "utf8")).toMatch(/await pmap\(entries,/);
  });
});

describe("homeAccountOf: the account the legacy per-login keys belong to", () => {
  const person = (pid: PersonId, source: Person["source"]): Person => ({ pid, source, email: "x@test.example", name: "", lang: "ar", createdAt: T0 });

  it("a legacy owner: their own account; a legacy member: memberOf", async () => {
    const e = address("ho");
    expect(await homeAccountOf(person(storedPersonId(e), "owner"))).toBe(e);
    const m = address("hm");
    const team = address("team");
    await db.set(accountKey.member(m), legacyMember(m, team));
    expect(await homeAccountOf(person(storedPersonId(m), "member"))).toBe(team);
    expect(await homeAccountOf(person(storedPersonId(address("nomember")), "member"))).toBeNull();
  });

  it("a person: record of a legacy owner or member keeps the legacy home (no orgs: entry exists for them in M1)", async () => {
    const e = address("hpo");
    await putAccount(account(e));
    expect(await homeAccountOf(person(storedPersonId(e), "person"))).toBe(e);
    const m = address("hpm");
    const team = address("team");
    await db.set(accountKey.member(m), legacyMember(m, team));
    expect(await homeAccountOf(person(storedPersonId(m), "person"))).toBe(team);
  });

  it("a p_ person: the owned account, else the oldest live membership, else none", async () => {
    const pid = storedPersonId(newPersonId());
    expect(await homeAccountOf(person(pid, "person"))).toBeNull();
    const older = await putAccount(account(address("o1")));
    const newer = await putAccount(account(address("o2")));
    await Promise.all([
      db.set(accountKey.membership(older, pid), mbrRow(older, pid, { acceptedAt: T1 })),
      db.set(accountKey.membership(newer, pid), mbrRow(newer, pid, { acceptedAt: T2 })),
      db.sadd(accountKey.members(older), pid),
      db.sadd(accountKey.members(newer), pid),
      db.sadd(personKey.orgs(pid), older),
      db.sadd(personKey.orgs(pid), newer),
    ]);
    expect(await homeAccountOf(person(pid, "person"))).toBe(older);
    const owned = await putAccount(account(address("o3"), { ownerPid: pid }));
    await db.sadd(personKey.orgs(pid), owned);
    expect(await homeAccountOf(person(pid, "person"))).toBe(owned);
  });
});

describe("isPersonSuspended mirrors isSuspended", () => {
  it("true, a future until and a past until", () => {
    const now = Date.parse(T2);
    const cases: { suspended?: true | { until: string } }[] = [{ suspended: true }, { suspended: { until: T3 } }, { suspended: { until: T1 } }, {}];
    expect(cases.map((c) => isPersonSuspended(c, now))).toEqual([true, true, false, false]);
    expect(cases.map((c) => isPersonSuspended(c, now))).toEqual(cases.map((c) => isSuspended(c, now)));
  });
});

describe("withPersonLock", () => {
  it("takes lock:person:{pid} and serializes two writers of one person", async () => {
    const pid = storedPersonId(newPersonId());
    const lock = vi.spyOn(db, "lock");
    const order: string[] = [];
    const run = (name: string) => withPersonLock(pid, async () => { order.push(`${name}+`); await new Promise((r) => setTimeout(r, 30)); order.push(`${name}-`); return name; });
    expect(await Promise.all([run("a"), run("b")])).toEqual(["a", "b"]);
    expect(order).toEqual(["a+", "a-", "b+", "b-"]);
    expect(new Set(lock.mock.calls.map((c) => c[0]))).toEqual(new Set([personKey.lock(pid)]));
    expect(await db.lock(personKey.lock(pid), 1)).toBe(true); // released
    await db.unlock(personKey.lock(pid));
  });
});
