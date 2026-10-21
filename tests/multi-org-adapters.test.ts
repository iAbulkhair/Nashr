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
 * Multi-workspace membership (docs/specs/2026-10-18-multi-org.md sections 2-4): the read adapters `getPerson`,
 * `getMembership`, `ownerOf`, `roleIn`, `listOrgs`, `homeAccountOf` and `isPersonSuspended`. Every fixture is written
 * with raw `db.set` / `db.sadd` through the key builders, never through the helpers under test. Rules 2115 (partly),
 * 2136 and 2138 (M4 contract: `person:` and `mbr:` alone; it replaced rule 2134's legacy fallbacks, whose fixtures
 * below stay only to show they are ignored).
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

describe("rule 2138: getPerson reads person: alone (M4 contract; the legacy owner and member fallbacks of rule 2134 are gone)", () => {
  it("a person: row is the person, whatever user: and member: hold under the same id", async () => {
    const e = address("prec");
    const pid = storedPersonId(e);
    await putAccount(account(e, { passHash: "hash-owner", sessionsAfter: T3 }));
    await db.set(accountKey.member(e), legacyMember(e, address("other"), { passHash: "hash-member", sessionsAfter: T3 }));
    await db.set(personKey.person(pid), personRow(e, e, { passHash: "hash-person", sessionsAfter: T0 }));
    const p = await getPerson(pid);
    expect(p).toEqual({ pid, source: "person", email: e, name: "Person Name", lang: "ar", passHash: "hash-person", sessionsAfter: T0, createdAt: T0 });
  });

  it("a legacy owner or member record without a person: row is no person (Script S1 wrote every row before M4)", async () => {
    const o = address("own");
    await putAccount(account(o, { devicesAfter: T2 }));
    expect(await getPerson(storedPersonId(o))).toBeNull();
    const m = address("mem");
    await db.set(accountKey.member(m), legacyMember(m, address("team")));
    expect(await getPerson(storedPersonId(m))).toBeNull();
  });

  it("a newer legacy record (a password changed by a rolled-back build) no longer wins: the row is read as it is", async () => {
    const e = address("stale");
    const pid = storedPersonId(e);
    await putAccount(account(e, { passHash: "hash-new", sessionsAfter: T3, createdAt: T3 }));
    await db.set(personKey.person(pid), personRow(e, e, { passHash: "hash-old", sessionsAfter: T1 }));
    const w = vi.spyOn(log, "warn");
    expect(await getPerson(pid)).toMatchObject({ source: "person", passHash: "hash-old", sessionsAfter: T1 });
    expect(w).not.toHaveBeenCalled();
  });

  it("nothing stored, or a row that does not parse, is no person (no fallback), logged without values", async () => {
    const w = vi.spyOn(log, "warn");
    expect(await getPerson(storedPersonId(address("none")))).toBeNull();
    const e = address("bad");
    const pid = storedPersonId(e);
    await putAccount(account(e));
    await db.set(personKey.person(pid), { pid: e, passHash: "hash-broken" }); // no email
    expect(await getPerson(pid)).toBeNull();
    expect(JSON.stringify(w.mock.calls)).not.toContain("hash-broken");
  });

  it("a row whose stored pid differs is read under its key (the key wins, as for an account), logged without values", async () => {
    const e = address("mpid");
    const other = storedPersonId(newPersonId());
    await db.set(personKey.person(storedPersonId(e)), personRow(other, e));
    const w = vi.spyOn(log, "warn");
    expect((await getPerson(storedPersonId(e)))?.pid).toBe(storedPersonId(e));
    expect(w).toHaveBeenCalledWith("person id differs from its key", { shape: "person.pid" });
    expect(JSON.stringify(w.mock.calls)).not.toContain(e);
  });

  it("makes exactly one read, and personFromRaw gives the same answer from the raw value", async () => {
    const e = address("round");
    const pid = storedPersonId(e);
    await putAccount(account(e));
    await db.set(accountKey.member(e), legacyMember(e, address("team")));
    await db.set(personKey.person(pid), personRow(e, e, { sessionsAfter: T3 }));
    const raw = await db.get(personKey.person(pid));
    const t = trackRounds(["get", "sismember", "smembers"]);
    const p = await getPerson(pid);
    expect(t.rounds()).toBe(1);
    expect(t.calls.map((c) => c.key)).toEqual([personKey.person(pid)]);
    const before = t.calls.length;
    expect(personFromRaw(pid, raw)).toEqual(p);
    expect(t.calls.length).toBe(before); // pure: no read
  });
});

describe("rule 2138: getMembership reads mbr: and the roster alone (the legacy member fallback of rule 2134 is gone)", () => {
  it("a legacy member record grants nothing, with or without its roster entry; the mbr: row decides", async () => {
    const aid = await putAccount(account(address("acc")));
    const e = address("lm");
    const pid = storedPersonId(e);
    await db.set(accountKey.member(e), legacyMember(e, aid, { role: "admin" }));
    await db.sadd(accountKey.members(aid), pid);
    expect(await getMembership(aid, pid)).toBeNull();
    await db.set(accountKey.membership(aid, pid), mbrRow(aid, e, { role: "member", invitedBy: "p_inviterinviterinviterinv" }));
    expect(await getMembership(aid, pid)).toEqual({ aid, pid, role: "member", acceptedAt: T1, invitedBy: "p_inviterinviterinviterinv", source: "mbr" });
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

  it("a resume or promotion made only on a legacy record (by a rolled-back build) grants nothing: the row is read as it is", async () => {
    const aid = await putAccount(account(address("acc")));
    const e = address("resumed");
    const pid = storedPersonId(e);
    await db.set(accountKey.membership(aid, pid), mbrRow(aid, e, { role: "member", disabled: "seats", acceptedAt: T1 }));
    await db.set(accountKey.member(e), legacyMember(e, aid, { role: "admin", acceptedAt: T1 }));
    await db.sadd(accountKey.members(aid), pid);
    const w = vi.spyOn(log, "warn");
    expect(await getMembership(aid, pid)).toMatchObject({ role: "member", disabled: "seats", source: "mbr" });
    expect(w).not.toHaveBeenCalled();
  });

  it("makes exactly one round (one read and one SISMEMBER), and membershipFromRaw gives the same answer", async () => {
    const aid = await putAccount(account(address("acc")));
    const pid = storedPersonId(newPersonId());
    await db.set(accountKey.membership(aid, pid), mbrRow(aid, pid));
    await db.sadd(accountKey.members(aid), pid);
    const t = trackRounds(["get", "sismember", "smembers"]);
    const m = await getMembership(aid, pid);
    expect(t.rounds()).toBe(1);
    expect(t.calls.map((c) => `${c.op} ${c.key}`).sort()).toEqual([`get ${accountKey.membership(aid, pid)}`, `sismember ${accountKey.members(aid)}`].sort());
    expect(membershipFromRaw(aid, pid, mbrRow(aid, pid), true)).toEqual(m);
    expect(membershipFromRaw(aid, pid, mbrRow(aid, pid), false)).toBeNull();
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
    // A legacy member record claiming owner grants nothing either (it is not read from M4).
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
    expect(t.calls.filter((c) => c.round === 1)).toHaveLength(7 * 3); // per entry: account, mbr:, roster (no member: from M4)
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

describe("homeAccountOf: the first of listOrgs (rule 2138: no legacy home)", () => {
  const person = (pid: PersonId): Person => ({ pid, source: "person", email: "x@test.example", name: "", lang: "ar", createdAt: T0 });

  it("a legacy owner or member without orgs: entries has no home: the legacy records are not read", async () => {
    const e = address("hpo");
    await putAccount(account(e));
    expect(await homeAccountOf(person(storedPersonId(e)))).toBeNull();
    const m = address("hpm");
    const team = await putAccount(account(address("team")));
    await db.set(accountKey.member(m), legacyMember(m, team));
    await db.sadd(accountKey.members(team), storedPersonId(m));
    expect(await homeAccountOf(person(storedPersonId(m)))).toBeNull();
    // With the entries Script S1 wrote, the forward records answer.
    await db.sadd(personKey.orgs(storedPersonId(e)), e);
    expect(await homeAccountOf(person(storedPersonId(e)))).toBe(e);
  });

  it("a p_ person: the owned account, else the oldest live membership, else none", async () => {
    const pid = storedPersonId(newPersonId());
    expect(await homeAccountOf(person(pid))).toBeNull();
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
    expect(await homeAccountOf(person(pid))).toBe(older);
    const owned = await putAccount(account(address("o3"), { ownerPid: pid }));
    await db.sadd(personKey.orgs(pid), owned);
    expect(await homeAccountOf(person(pid))).toBe(owned);
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
