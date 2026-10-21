import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { randomBytes } from "crypto";
import { newMember as helperNewMember, newUser as helperNewUser } from "./helpers/session";
import { acct, getLogin, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, personKey, storedAccountId, storedPersonId, type PersonId } from "@/lib/keys";
import { getMembership } from "@/lib/membership";
import { getPerson } from "@/lib/person";
import { BOOK_KEYS } from "@/lib/booking-token";
import { FEED_KEYS, hashFeedToken } from "@/lib/feed-token";
import { run } from "../scripts/multi-org-contract";

/**
 * Script S2 of multi-workspace membership (docs/specs/2026-10-18-multi-org.md, "Releases"; rule 2138 in
 * docs/system/tests/2110-multi-org.md, rules 2762-2764 in docs/system/tests/2760-multi-org-m4.md): after M4 it strips
 * the credentials left on account records and deletes the legacy `member:` records whose `mbr:` twin exists. Dry by
 * default, idempotent, checks every owner and member for a lock-out gap (rule 2765), never deletes a record with no
 * twin, counts the links made before M1, prints counts only and awaits no db call inside a loop. Its fixtures are legacy persons in both `TEST_PERSONS` modes (only a
 * login from before M2 has legacy copies), with the copies a build before M4 left planted by hand.
 */

afterEach(() => { vi.restoreAllMocks(); });

const newUser = (prefix: string) => helperNewUser(prefix, { legacy: true, shadow: false });
const newMember = (owner: User) => helperNewMember(owner, "member", "s2m", { legacy: true, shadow: false });
const read = (f: string) => readFileSync(f, "utf8");

/** The credentials a build before M4 kept on the account record too. */
async function plantCreds(u: User): Promise<void> {
  const raw = (await db.get<Record<string, unknown>>(accountKey.user(acct(u))))!;
  await db.set(accountKey.user(acct(u)), { ...raw, passHash: "legacy-hash", sessionsAfter: u.createdAt, devicesAfter: u.createdAt });
}
/** The legacy `member:` record a build before M4 mirrored from the membership row (its twin), with `extra` on top. */
async function plantMemberRecord(owner: User, m: { email: string; pid: PersonId }, extra: Record<string, unknown> = {}): Promise<void> {
  const ms = (await getMembership(storedAccountId(acct(owner)), m.pid))!;
  await db.set(accountKey.member(m.email), { email: m.email, name: "Legacy", lang: "ar", passHash: "legacy-hash", memberOf: acct(owner), role: ms.role, invitedBy: owner.email, acceptedAt: ms.acceptedAt, ...(ms.disabled ? { disabled: ms.disabled } : {}), ...extra });
}
/** An owner and a member with every legacy copy a build before M4 left. */
async function preM4(prefix = "s2o") {
  const u = await newUser(prefix);
  const m = await newMember(u);
  await Promise.all([plantCreds(u), plantMemberRecord(u, m)]);
  return { u, m, aid: storedAccountId(acct(u)), owner: storedPersonId(acct(u)) };
}
const userRaw = (u: User) => db.get<Record<string, unknown>>(accountKey.user(acct(u)));

describe("rule 2762: S2 is dry by default, strips credentials only where the person holds them, and is idempotent", () => {
  it("a dry run counts what it would strip and delete and writes nothing", async () => {
    await preM4();
    const set = vi.spyOn(db, "set");
    const del = vi.spyOn(db, "del");
    const dry = await run({ apply: false });
    expect(dry.apply).toBe(false);
    expect(dry.credsRemoved).toBeGreaterThanOrEqual(1);
    expect(dry.membersDeleted).toBeGreaterThanOrEqual(1);
    expect(set).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("--apply strips the three fields and nothing else, deletes the matching member record, and a second run does nothing", async () => {
    const a = await preM4();
    const before = (await userRaw(a.u))!;
    const r = await run({ apply: true });
    expect(r.credsRemoved).toBeGreaterThanOrEqual(1);
    expect(r.membersDeleted).toBeGreaterThanOrEqual(1);
    const after = (await userRaw(a.u))!;
    const { passHash: _h, sessionsAfter: _s, devicesAfter: _d, ...rest } = before;
    void _h; void _s; void _d;
    expect(after).toEqual(rest);
    expect(await db.get(accountKey.member(a.m.email))).toBeNull();
    // What M4 reads is untouched: the people, the membership and both logins.
    expect((await getPerson(a.owner))!.passHash).toBeTruthy();
    expect((await getPerson(a.m.pid))!.passHash).toBeTruthy();
    expect(await getMembership(a.aid, a.m.pid)).toMatchObject({ role: "member" });
    expect(await getLogin(a.u.email)).toMatchObject({ kind: "owner" });
    expect(await getLogin(a.m.email)).toMatchObject({ kind: "member", membership: { aid: a.aid } });
    const again = await run({ apply: true });
    expect([again.credsRemoved, again.membersDeleted]).toEqual([0, 0]);
  });

  it("an account whose owner has no person row keeps its credentials and is reported", async () => {
    const u = await newUser("s2np");
    await plantCreds(u);
    await db.del(personKey.person(storedPersonId(acct(u))));
    const r = await run({ apply: true });
    expect(r.personMissing).toBeGreaterThanOrEqual(1);
    expect((await userRaw(u))!.passHash).toBe("legacy-hash");
  });
});

describe("rule 2765: S2 checks every owner and member for a lock-out gap and touches nothing for one", () => {
  it("an owner whose account is missing from its orgs set is counted (with or without credentials) and keeps them", async () => {
    const base = await run({ apply: false });
    const [bare, withCreds] = await Promise.all([newUser("s2oa"), newUser("s2ob")]);
    await plantCreds(withCreds);
    await Promise.all([bare, withCreds].map((u) => db.srem(personKey.orgs(storedPersonId(acct(u))), storedAccountId(acct(u)))));
    const r = await run({ apply: true });
    expect(r.notInOrgs).toBe(base.notInOrgs + 2);
    expect((await userRaw(withCreds))!.passHash).toBe("legacy-hash");
  });

  it("an owner without person row is counted even with no credentials left", async () => {
    const base = await run({ apply: false });
    const u = await newUser("s2oc");
    await db.del(personKey.person(storedPersonId(acct(u))));
    const r = await run({ apply: false });
    expect(r.personMissing).toBe(base.personMissing + 1);
  });

  it("a member whose account is missing from its orgs set, or whose person row is gone, is counted and its record kept", async () => {
    const base = await run({ apply: false });
    const a = await preM4("s2mo");
    const b = await preM4("s2mq");
    await Promise.all([db.srem(personKey.orgs(a.m.pid), a.aid), db.del(personKey.person(b.m.pid))]);
    const r = await run({ apply: true });
    expect(r.notInOrgs).toBe(base.notInOrgs + 1);
    expect(r.personMissing).toBe(base.personMissing + 1);
    expect(await db.get(accountKey.member(a.m.email))).not.toBeNull();
    expect(await db.get(accountKey.member(b.m.email))).not.toBeNull();
  });

  it("a clean store reports 0 for both, and the second run is clean", async () => {
    await preM4("s2ok");
    await run({ apply: true });
    const again = await run({ apply: false });
    // Other files' fixtures share the store; this file's own subjects add no gap.
    expect([again.credsRemoved, again.membersDeleted]).toEqual([0, 0]);
  });
});

describe("rule 2763: S2 deletes a legacy member record when its twin exists; differences are information only", () => {
  it("a record whose twin row is missing is kept and counted; one no roster lists is never reached, so never deleted", async () => {
    const a = await preM4("s2tm");
    const b = await preM4("s2tr");
    await Promise.all([db.del(accountKey.membership(a.aid, a.m.pid)), db.srem(accountKey.members(b.aid), b.m.pid)]);
    const r = await run({ apply: true });
    // S2 finds legacy member records through the rosters (Redis keys are not listed): `b`'s record is off every roster,
    // so it is neither counted nor touched. A removal deletes the record (src/lib/team.ts `deleteMembership`).
    expect(r.twinMissing).toBeGreaterThanOrEqual(1);
    expect(await db.get(accountKey.member(a.m.email))).not.toBeNull();
    expect(await db.get(accountKey.member(b.m.email))).not.toBeNull();
  });

  it("a record that differs from its twin (role, acceptedAt or pause) is deleted and counted for information", async () => {
    const u = await newUser("s2td");
    const [m1, m2, m3] = await Promise.all([newMember(u), newMember(u), newMember(u)]);
    await Promise.all([
      plantMemberRecord(u, m1, { role: "admin" }),
      plantMemberRecord(u, m2, { acceptedAt: new Date(Date.now() - 86400000).toISOString() }),
      plantMemberRecord(u, m3, { disabled: "seats" }),
    ]);
    const dry = await run({ apply: false });
    expect(dry.twinDiffers).toBeGreaterThanOrEqual(3);
    const r = await run({ apply: true });
    expect(r.twinDiffers).toBeGreaterThanOrEqual(3);
    const left = await Promise.all([m1, m2, m3].map((m) => db.get(accountKey.member(m.email))));
    expect(left).toEqual([null, null, null]);
    // The row stays the truth: what M4 reads did not change.
    expect(await getMembership(storedAccountId(acct(u)), m1.pid)).toMatchObject({ role: "member" });
  });

  it("a record whose twin names other ids is kept and counted as missing", async () => {
    const u = await newUser("s2ti");
    const other = await newUser("s2tj");
    const m = await newMember(u);
    await plantMemberRecord(u, m);
    const row = (await db.get<Record<string, unknown>>(accountKey.membership(storedAccountId(acct(u)), m.pid)))!;
    await db.set(accountKey.membership(storedAccountId(acct(u)), m.pid), { ...row, aid: acct(other) });
    const r = await run({ apply: true });
    expect(r.twinMissing).toBeGreaterThanOrEqual(1);
    expect(await db.get(accountKey.member(m.email))).not.toBeNull();
  });
});

describe("rule 2764: S2 counts the links made before M1 (must be 0) and writes nothing for them", () => {
  it("a pointed-to record without pid and aid is counted; an M1 record is not; nothing is deleted", async () => {
    const u = await newUser("s2ln");
    const base = (await run({ apply: false })).preM1Links;
    const old = hashFeedToken(randomBytes(32).toString("base64url"));
    const m1 = hashFeedToken(randomBytes(32).toString("base64url"));
    const at = new Date().toISOString();
    await Promise.all([
      db.set(FEED_KEYS.of(u.email), old),
      db.set(FEED_KEYS.rec(old), { login: u.email, scope: acct(u), lang: "ar", createdAt: at }),
      db.set(BOOK_KEYS.of(u.email, "calcom"), m1),
      db.set(BOOK_KEYS.rec(m1), { login: u.email, scope: acct(u), provider: "calcom", lang: "ar", createdAt: at, pid: storedPersonId(acct(u)), aid: storedAccountId(acct(u)) }),
    ]);
    const r = await run({ apply: true });
    expect(r.preM1Links).toBe(base + 1);
    expect(await db.get(FEED_KEYS.rec(old))).not.toBeNull();
    expect(await db.get(FEED_KEYS.of(u.email))).toBe(old);
  });
});

describe("rule 2138: S2 prints counts only, awaits no db call inside a loop, and runs only when called as a script", () => {
  it("the source", () => {
    const src = read("scripts/multi-org-contract.ts");
    for (const m of src.matchAll(/\bfor \([^)]*\) \{([^}]*)\}/g)) expect(m[1]).not.toContain("await");
    for (const m of src.matchAll(/\bfor \([^)]*\)[^{\n]*\n/g)) expect(m[0]).not.toContain("await");
    expect(src).not.toMatch(/\bwhile \(/);
    expect(src).not.toMatch(/\.forEach\(async/);
    const logs = [...src.matchAll(/console\.(?:log|error)\((.*)\);/g)].map((m) => m[1]);
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).not.toMatch(/\.email\b|\.login\b|\.id\b|\bpid\b|\baid\b/);
    expect(src).toContain('process.argv.includes("--apply")');
    // Rules 2764, 2765: a lock-out gap or a link made before M1 fails the run (exit 1), as a kept record or busy lock does.
    expect(src).toContain("process.exitCode = r.personMissing || r.notInOrgs || r.twinMissing || r.preM1Links || r.busy ? 1 : 0;");
    expect(src).toContain("import.meta.url === pathToFileURL(process.argv[1]).href");
    expect(src).toContain("withAccountTeamLock(aid, async () => {\n    const r = await withMemberLock(login");
    expect(src).toContain("return withUserLock(id,");
  });
});
