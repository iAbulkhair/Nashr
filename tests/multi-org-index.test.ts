import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { newMember as helperNewMember, newUser as helperNewUser } from "./helpers/session";
import { acct, claimLogin, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId, type PersonId } from "@/lib/keys";
import { getMembership } from "@/lib/membership";
import { getPerson } from "@/lib/person";
import { getMember, type Member } from "@/lib/team";
import { run } from "../scripts/multi-org-index";

/**
 * Script S1 of multi-workspace membership (docs/specs/2026-10-18-multi-org.md, "Script S1"; rule 2133, listed in
 * docs/system/tests/2110-multi-org.md): it fills `person:`, `orgs:`, `mbr:` and the member's `login:` for logins from
 * before M1, is dry by default, writes only what is absent, reports conflicts and orphans without overwriting them, and
 * awaits no db call inside a loop. Its fixtures are legacy persons in both `TEST_PERSONS` modes (a login from before M1
 * IS a legacy person), stripped of the records M1 added; the "already complete" case uses the mode's own fixtures.
 */

afterEach(() => { vi.restoreAllMocks(); });

const newUser = (prefix: string) => helperNewUser(prefix, { legacy: true, shadow: false });
const newMember = (owner: User) => helperNewMember(owner, "member", "s1m", { legacy: true, shadow: false });
const P_GHOST = storedPersonId(`p_${"q".repeat(24)}`);

/** An owner and its member as a build from before M1 left them: `user:`, `member:` and the roster only. */
async function preM1(prefix = "s1o") {
  const u = await newUser(prefix);
  const m = await newMember(u);
  const aid = storedAccountId(acct(u));
  const owner = storedPersonId(acct(u));
  await Promise.all([
    db.del(personKey.person(owner)),
    db.del(personKey.person(m.pid)),
    db.del(personKey.orgs(owner)),
    db.del(personKey.orgs(m.pid)),
    db.del(accountKey.membership(aid, m.pid)),
    db.del(accountKey.login(u.email)),
    db.del(accountKey.login(m.email)),
  ]);
  return { u, m, aid, owner };
}
const record = (email: string) => db.get<Member>(accountKey.member(email));
const inOrgs = (pid: PersonId, aid: string) => db.sismember(personKey.orgs(pid), aid);
/** What M1's reader answers for a person, without the field naming which record it came from. */
const seen = async (pid: PersonId) => {
  const p = await getPerson(pid);
  if (!p) return null;
  const { source: _s, ...rest } = p;
  void _s;
  return rest;
};

describe("rule 2133: S1 is idempotent, dry by default, reports conflicts without overwriting, and awaits no db call in a loop", () => {
  it("a dry run counts what it would write and writes nothing", async () => {
    const a = await preM1();
    const set = vi.spyOn(db, "set");
    const sadd = vi.spyOn(db, "sadd");
    const del = vi.spyOn(db, "del");
    const dry = await run({ apply: false });
    expect(dry.apply).toBe(false);
    expect(dry.personsSet).toBeGreaterThanOrEqual(2);
    expect(dry.membershipsSet).toBeGreaterThanOrEqual(1);
    expect(dry.orgsSet).toBeGreaterThanOrEqual(2);
    expect(dry.loginsSet).toBeGreaterThanOrEqual(2);
    expect(set).not.toHaveBeenCalled();
    expect(sadd).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(await db.get(personKey.person(a.owner))).toBeNull();
    expect(await db.get(accountKey.membership(a.aid, a.m.pid))).toBeNull();
    expect(await db.get(accountKey.login(a.m.email))).toBeNull();
  });

  it("--apply fills the owner's person and orgs, the member's person, membership row and login; a second run writes nothing", async () => {
    const a = await preM1();
    const ownerBefore = await seen(a.owner);
    const memberBefore = await seen(a.m.pid);
    const recBefore = await record(a.m.email);
    const userBefore = await db.get<User>(accountKey.user(a.aid));
    const r = await run({ apply: true });
    expect(r.apply).toBe(true);
    expect(r.personsSet).toBeGreaterThanOrEqual(2);
    expect(r.membershipsSet).toBeGreaterThanOrEqual(1);
    expect(r.loginsSet).toBeGreaterThanOrEqual(2);
    // The owner: its person row copies the legacy record (same hash), and `orgs:` names the account.
    expect(await db.get(personKey.person(a.owner))).toMatchObject({ pid: a.owner, email: a.u.email, passHash: userBefore!.passHash });
    expect(await inOrgs(a.owner, a.aid)).toBeTruthy();
    expect(await db.get(accountKey.login(a.u.email))).toEqual({ kind: "person", pid: a.owner });
    // The member: person, row, `orgs:` and login index.
    expect(await db.get(personKey.person(a.m.pid))).toMatchObject({ pid: a.m.pid, email: a.m.email, passHash: recBefore!.passHash });
    expect(await db.get(accountKey.membership(a.aid, a.m.pid))).toMatchObject({ aid: a.aid, pid: a.m.pid, role: "member", acceptedAt: recBefore!.acceptedAt });
    expect(await inOrgs(a.m.pid, a.aid)).toBeTruthy();
    expect(await db.get(accountKey.login(a.m.email))).toEqual({ kind: "person", pid: a.m.pid });
    // M1's readers answer exactly what they answered from the legacy records; the legacy records are untouched.
    expect(await seen(a.owner)).toEqual(ownerBefore);
    expect(await seen(a.m.pid)).toEqual(memberBefore);
    expect(await record(a.m.email)).toEqual(recBefore);
    expect(await db.get(accountKey.user(a.aid))).toEqual(userBefore);
    expect((await getMembership(a.aid, a.m.pid))?.source).toBe("mbr");

    const set = vi.spyOn(db, "set");
    const sadd = vi.spyOn(db, "sadd");
    const again = await run({ apply: true });
    expect([again.personsSet, again.membershipsSet, again.orgsSet, again.loginsSet]).toEqual([0, 0, 0, 0]);
    expect(set).not.toHaveBeenCalled();
    expect(sadd).not.toHaveBeenCalled();
  });

  it("a member paused for seats keeps the pause on its new row and on its record", async () => {
    const a = await preM1();
    const rec = (await getMember(a.m.email))!;
    await db.set(accountKey.member(a.m.email), { ...rec, disabled: "seats" });
    const r = await run({ apply: true });
    expect(r.paused).toBeGreaterThanOrEqual(1);
    expect(await db.get(accountKey.membership(a.aid, a.m.pid))).toMatchObject({ disabled: "seats" });
    expect(await record(a.m.email)).toMatchObject({ disabled: "seats" });
    expect((await getMembership(a.aid, a.m.pid))?.disabled).toBe("seats");
  });

  it("a person row whose hash differs from the legacy record is counted and left as it is", async () => {
    const a = await preM1();
    const other = { pid: a.owner, email: a.u.email, name: "Other", lang: "en", passHash: "$2b$10$other", createdAt: "2026-01-01T00:00:00.000Z" };
    await db.set(personKey.person(a.owner), other);
    const r = await run({ apply: true });
    expect(r.personConflicts).toBeGreaterThanOrEqual(1);
    expect(await db.get(personKey.person(a.owner))).toEqual(other);
    expect(await inOrgs(a.owner, a.aid)).toBeFalsy();
    expect(await db.get(accountKey.login(a.u.email))).toBeNull();
  });

  it("a login index that names someone else is counted and never overwritten", async () => {
    const a = await preM1();
    await claimLogin(a.m.email, P_GHOST);
    const r = await run({ apply: true });
    expect(r.loginConflicts).toBeGreaterThanOrEqual(1);
    expect(await db.get(accountKey.login(a.m.email))).toEqual({ kind: "person", pid: P_GHOST });
    expect(await db.get(personKey.person(a.m.pid))).toBeNull();
    expect(await db.get(accountKey.membership(a.aid, a.m.pid))).toBeNull();
  });

  it("a member record whose memberOf account is missing is an orphan record, left as it is", async () => {
    const a = await preM1();
    const rec = (await getMember(a.m.email))!;
    const orphan = { ...rec, memberOf: "s1-gone@test.example" };
    await db.set(accountKey.member(a.m.email), orphan);
    const r = await run({ apply: true });
    expect(r.orphanRecords).toBeGreaterThanOrEqual(1);
    expect(await record(a.m.email)).toEqual(orphan);
    expect(await db.get(accountKey.membership(a.aid, a.m.pid))).toBeNull();
    expect(await db.get(personKey.person(a.m.pid))).toBeNull();
  });

  it("a roster entry without a record is an orphan entry: nothing is written for it", async () => {
    const a = await preM1();
    const ghost = storedPersonId("s1-ghost@test.example");
    await db.sadd(accountKey.members(a.aid), ghost);
    const r = await run({ apply: true });
    expect(r.orphanEntries).toBeGreaterThanOrEqual(1);
    expect(await db.get(personKey.person(ghost))).toBeNull();
    expect(await db.get(accountKey.membership(a.aid, ghost))).toBeNull();
    expect(await inOrgs(ghost, a.aid)).toBeFalsy();
    expect(await db.sismember(accountKey.members(a.aid), ghost)).toBeTruthy();
  });

  it("an account whose ownerPid names no person is an owner conflict: nothing is written for it", async () => {
    const u = await newUser("s1p");
    await saveUser({ ...u, ownerPid: P_GHOST });
    const r = await run({ apply: true });
    expect(r.ownerConflicts).toBeGreaterThanOrEqual(1);
    expect(await db.get(personKey.person(P_GHOST))).toBeNull();
    expect(await inOrgs(P_GHOST, acct(u))).toBeFalsy();
    expect(await db.sismember(globalKey.usersAll(), acct(u))).toBeTruthy();
  });

  it("logins M1 already wrote (this mode's own fixtures) get nothing", async () => {
    const u = await helperNewUser("s1f", { shadow: false });
    await helperNewMember(u, "admin", "s1fm", { shadow: false });
    await run({ apply: true }); // the earlier tests' leftovers, if any
    const set = vi.spyOn(db, "set");
    const sadd = vi.spyOn(db, "sadd");
    const r = await run({ apply: true });
    expect([r.personsSet, r.membershipsSet, r.orgsSet, r.loginsSet]).toEqual([0, 0, 0, 0]);
    expect(set).not.toHaveBeenCalled();
    expect(sadd).not.toHaveBeenCalled();
  });

  it("the script awaits no db call inside a loop, builds every key through keys.ts and prints counts only", () => {
    const src = readFileSync("scripts/multi-org-index.ts", "utf8") + readFileSync("src/lib/conversions/multi-org-index.ts", "utf8"); // rule 4100: the work moved
    for (const m of src.matchAll(/\bfor \([^)]*\) \{([^}]*)\}/g)) expect(m[1]).not.toContain("await");
    expect(src).not.toMatch(/\bwhile \(/);
    expect(src).not.toMatch(/\bfor \(/);
    // The bodies of every forEach/map callback, brace-matched: none awaits.
    for (const m of src.matchAll(/\.(?:forEach|map)\(/g)) {
      let depth = 0;
      let end = m.index! + m[0].length - 1;
      for (; end < src.length; end++) {
        if (src[end] === "(") depth++;
        if (src[end] === ")" && --depth === 0) break;
      }
      expect(src.slice(m.index, end)).not.toMatch(/\bawait\b/);
    }
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/[`"'](?:person|orgs|mbr|login|member|members|user|users|lock):/);
    const logs = [...src.matchAll(/console\.(?:log|error)\((.*)\);/g)].map((m) => m[1]);
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).not.toMatch(/\.email\b|\.login\b|\.id\b|\bpid\b/);
  });
});
