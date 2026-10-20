import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { enrolPasskeys, passkeyResidue, passkeySignIn, PASSKEY_ORIGIN, reverseEntriesOf, type Enrolled } from "./helpers/passkeys";
import { acct, currentUser, currentUserUnverified, getLogin, sessionKey } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/cookie-names";
import { db } from "@/lib/db";
import { accountKey, globalKey, personKey, storedPersonId, type PersonId } from "@/lib/keys";
import { credHash, listPasskeys } from "@/lib/passkeys";
import { getPerson } from "@/lib/person";
import { createMember, forceRemoveMember, leaveTeam, removeMember } from "@/lib/team";
import { wipeAccount } from "@/lib/account";
import { moveUnverifiedAccount } from "@/lib/verify-email";
import type { PasskeySetValue } from "@/lib/stored";

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (...a: unknown[]) => {
    const m = (typeof a[0] === "string" ? { to: a[0], subject: a[1], text: a[2] } : a[0]) as Mail;
    mails.push({ to: m.to, subject: m.subject, text: m.text });
    return true;
  },
}));

import * as emailRoute from "@/app/api/account/email/route";
import * as verifyEmailRoute from "@/app/api/auth/verify/email/route";
import * as resetRoute from "@/app/api/auth/reset/route";

/**
 * Customer passkeys, Task 6 (docs/specs/2026-10-20-passkeys.md flow D, rules 2402, 2414, 2424, 2425): the set follows a
 * person through both address moves (a member's, and an owner's proved and unproved), stays put through a password
 * reset, and a new person at a reused legacy address never inherits one. End to end with real crypto: the soft
 * authenticator signs in through the public routes. The moves run for a legacy person only (a `p_` person's address
 * moves with release M2), so these fixtures are legacy in both `TEST_PERSONS` modes; the reset runs in either.
 */

let ipN = 0;
const ip = () => ({ "x-forwarded-for": `192.0.${100 + (Math.floor(++ipN / 250) % 100)}.${(ipN % 250) + 1}` });
const addr = (p: string) => `${p}-${randomBytes(4).toString("hex")}@test.example`;
const start = (to: string, password = "abc12345") => emailRoute.POST(json("/api/account/email", "POST", { action: "start", email: to, password }, ip()));
const confirm = (code: string) => emailRoute.POST(json("/api/account/email", "POST", { action: "confirm", code }, ip()));
const codeFor = (to: string) => mails.filter((m) => m.to === to).at(-1)!.text.match(/\d{6}/)![0];
const rawSet = (pid: PersonId) => db.get<PasskeySetValue>(personKey.passkeys(pid));
/** The pid a session record names. */
const sessionPid = async () => (await db.get<{ pid?: string }>(sessionKey(jar().get(SESSION_COOKIE)!)))?.pid;

beforeEach(() => {
  mails = [];
  vi.stubEnv("APP_ORIGIN", PASSKEY_ORIGIN);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("MAIL_FROM", "Thakeen <no-reply@test.example>");
});
afterEach(() => {
  signOut();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * What every move leaves (rule 2424): the set at `to`'s pid with the same `uid` and credentials, stamped with the
 * destination person's birth; every reverse entry names the new pid; nothing under the old pid (set, `pkreg:`, any
 * `pkcred:` entry naming it); the old address signs in nowhere.
 */
async function expectMoved(e: Enrolled, from: string, to: string): Promise<PersonId> {
  const toPid = (await getLogin(to))!.pid;
  expect(toPid).toBe(storedPersonId(to));
  const set = (await rawSet(toPid))!;
  expect(set.uid).toBe(e.uid);
  expect(set.creds.map((c) => c.id)).toEqual(e.softs.map((s) => s.credId));
  expect(set.born).toBe((await getPerson(toPid))!.createdAt);
  expect(await listPasskeys(toPid, set.born)).toHaveLength(e.softs.length);
  expect(reverseEntriesOf(toPid)).toEqual(e.softs.map((s) => globalKey.passkeyCred(credHash(s.credId))).sort());
  expect(passkeyResidue(e.pid)).toEqual([]);
  expect(await getLogin(from)).toBeNull();
  return toPid;
}

describe("rule 2424: an address move carries the set to the new pid", () => {
  it("a member move (settings, proved address): same uid, entries rewritten, nothing under the old pid; the passkey signs in at the new address", async () => {
    const owner = await newUser("pkmo");
    const m = await newMember(owner, "member", "m", { legacy: true, shadow: false });
    const e = await enrolPasskeys(m.email);
    expect(e.pid).toBe(storedPersonId(m.email));
    await signIn(m.email);
    const to = addr("pkmnew");
    expect((await start(to, m.password)).status).toBe(200);
    expect((await confirm(codeFor(to))).status).toBe(200);
    const toPid = await expectMoved(e, m.email, to);
    signOut();
    expect(await passkeySignIn(e.softs[0], e.uid, 1)).toEqual({ status: 200, body: { ok: true } });
    expect(await sessionPid()).toBe(toPid);
    expect((await currentUser())?.actor).toMatchObject({ kind: "member", email: to });
    signOut();
    expect(await passkeySignIn(e.softs[1], e.uid, 1)).toEqual({ status: 200, body: { ok: true } });
    expect(await sessionPid()).toBe(toPid);
  });

  it("an owner move with a proved address (settings): the same, and the sign-in needs no verify step", async () => {
    const u = await newUser("pkop", { legacy: true, shadow: false });
    const e = await enrolPasskeys(u.email);
    await signIn(u.email);
    const to = addr("pkonew");
    expect((await start(to)).status).toBe(200);
    expect((await confirm(codeFor(to))).status).toBe(200);
    const toPid = await expectMoved(e, u.email, to);
    signOut();
    expect(await passkeySignIn(e.softs[0], e.uid, 1)).toEqual({ status: 200, body: { ok: true, verify: false } });
    expect(await sessionPid()).toBe(toPid);
    expect((await currentUser())?.email).toBe(to);
  });

  it("an owner move with an unproved address (the signup typo fix): the same, and the sign-in still asks to verify", async () => {
    const u = await newUser("pkou", { legacy: true, shadow: false, verified: false });
    const e = await enrolPasskeys(u.email);
    await signIn(u.email);
    const to = addr("pkounew");
    const r = await verifyEmailRoute.POST(json("/api/auth/verify/email", "POST", { email: to }, ip()));
    expect(r.status).toBe(200);
    const toPid = await expectMoved(e, u.email, to);
    signOut();
    expect(await passkeySignIn(e.softs[1], e.uid, 1)).toEqual({ status: 200, body: { ok: true, verify: true } });
    expect(await sessionPid()).toBe(toPid);
    expect((await currentUserUnverified())?.email).toBe(to);
  });
});

/**
 * Spies on the lock calls and on every write of a passkey key, recording which person locks were held when it ran
 * (pre-flight ruling 13: `db.lock` is observable, `withNamedLock` is not).
 */
function watchLocks() {
  const held = new Set<string>();
  const order: string[] = [];
  const ttls = new Map<string, number | undefined>();
  const writes: { key: string; held: string[] }[] = [];
  const lock = db.lock.bind(db);
  const unlock = db.unlock.bind(db);
  vi.spyOn(db, "lock").mockImplementation(async (key, ttl) => {
    const got = await lock(key, ttl);
    if (got) { held.add(key); order.push(key); ttls.set(key, ttl); }
    return got;
  });
  vi.spyOn(db, "unlock").mockImplementation(async (key) => {
    held.delete(key);
    return unlock(key);
  });
  const passkeyKey = (k: string) => k.startsWith("passkeys:") || k.startsWith("pkcred:") || k.startsWith("pkreg:");
  for (const op of ["set", "setNx", "setXx", "del", "replaceIf"] as const) {
    const orig = (db[op] as (...a: unknown[]) => Promise<unknown>).bind(db);
    vi.spyOn(db, op).mockImplementation((async (...a: unknown[]) => {
      if (passkeyKey(String(a[0]))) writes.push({ key: String(a[0]), held: [...held].filter((k) => k.startsWith("lock:person:")).sort() });
      return orig(...a);
    }) as never);
  }
  return { order, ttls, writes };
}

describe("rule 2414: both moves write passkey keys only under both person locks, taken in rule 2139's order", () => {
  it("the member move: every passkey write holds lock:person of both pids", async () => {
    const owner = await newUser("pklm");
    const m = await newMember(owner, "member", "m", { legacy: true, shadow: false });
    const e = await enrolPasskeys(m.email);
    await signIn(m.email);
    const to = addr("pklmnew");
    expect((await start(to, m.password)).status).toBe(200);
    const w = watchLocks();
    expect((await confirm(codeFor(to))).status).toBe(200);
    const both = [personKey.lock(e.pid), personKey.lock(storedPersonId(to))].sort();
    expect(w.writes.length).toBeGreaterThan(0);
    for (const x of w.writes) expect(x.held, x.key).toEqual(both);
    // Fix round 1: the move's person locks expire after 60 s (`withMovePersonLock`), not the shared 10 s.
    expect(both.map((k) => w.ttls.get(k))).toEqual([60, 60]);
  });

  it("the owner move: both person locks after both login locks and before lock:user, and every passkey write holds them", async () => {
    const u = await newUser("pklo", { legacy: true, shadow: false, verified: false });
    const e = await enrolPasskeys(u.email);
    const to = addr("pklonew");
    const w = watchLocks();
    expect(await moveUnverifiedAccount((await currentUserOf(u.email))!, to)).toBe("ok");
    const persons = [personKey.lock(e.pid), personKey.lock(storedPersonId(to))].sort();
    const logins = [accountKey.loginLock(u.email), accountKey.loginLock(to)].sort();
    const at = (k: string) => w.order.indexOf(k);
    expect(w.order.slice(0, 5)).toEqual([...logins, ...persons, `lock:user:${acct(u)}`]);
    expect(at(accountKey.teamLock(acct(u)))).toBeGreaterThan(at(`lock:user:${acct(u)}`));
    expect(w.writes.length).toBeGreaterThan(0);
    for (const x of w.writes) expect(x.held, x.key).toEqual(persons);
    expect(persons.map((k) => w.ttls.get(k))).toEqual([60, 60]);
    expect(w.ttls.get(accountKey.teamLock(acct(u)))).toBe(60);
    expect(passkeyResidue(e.pid)).toEqual([]);
  });

  it("an add racing an owner move: the move waits for the add's person lock, and the added passkey moves too (nothing left under the old pid)", async () => {
    const u = await newUser("pkrace", { legacy: true, shadow: false, verified: false });
    const e = await enrolPasskeys(u.email, { count: 1, reg: false });
    const { addPasskey } = await import("@/lib/passkeys");
    const { softAuthenticator } = await import("./helpers/soft-authenticator");
    const late = softAuthenticator();
    // The add holds lock:person:{old} and is parked on its set write until the move has started.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let parked!: () => void;
    const isParked = new Promise<void>((r) => { parked = r; });
    const set = db.set.bind(db);
    vi.spyOn(db, "set").mockImplementation((async (key: string, ...rest: unknown[]) => {
      if (key === personKey.passkeys(e.pid)) { parked(); await gate; }
      return (set as (...a: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as never);
    // Fix round 1 (no sleep): the gate opens only once the move has tried lock:person:{old} and been refused, so the
    // test always runs the wait it claims to.
    let refusedOnce!: () => void;
    const refused = new Promise<void>((r) => { refusedOnce = r; });
    const lock = db.lock.bind(db);
    vi.spyOn(db, "lock").mockImplementation(async (key, ttl) => {
      const got = await lock(key, ttl);
      if (key === personKey.lock(e.pid) && !got) refusedOnce();
      return got;
    });
    const add = addPasskey(e.pid, e.born, { id: late.credId, pk: late.cosePublicKey, counter: 0, transports: ["internal"], aaguid: "00000000-0000-0000-0000-000000000000", backedUp: true }, "Late");
    await isParked;
    const to = addr("pkracenew");
    const move = moveUnverifiedAccount((await currentUserOf(u.email))!, to);
    await refused;
    // The move is waiting: nothing is written at the new address yet.
    expect(await getLogin(to)).toBeNull();
    expect(await rawSet(storedPersonId(to))).toBeNull();
    release();
    expect(await add).toMatchObject({ ok: true });
    expect(await move).toBe("ok");
    vi.restoreAllMocks();
    const toPid = storedPersonId(to);
    expect((await rawSet(toPid))!.creds.map((c) => c.id)).toEqual([e.softs[0].credId, late.credId]);
    expect(reverseEntriesOf(toPid)).toEqual([e.softs[0].credId, late.credId].map((id) => globalKey.passkeyCred(credHash(id))).sort());
    expect(passkeyResidue(e.pid)).toEqual([]);
  });
});

/** The stored owner record of `email`, as a session would resolve it (unverified owners included). */
async function currentUserOf(email: string) {
  await signIn(email);
  const u = await currentUserUnverified();
  signOut();
  return u;
}

describe("rule 2424: a password reset keeps passkeys", () => {
  const reset = async (email: string, kind: "owner" | "member") => {
    const token = randomBytes(32).toString("hex");
    await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, { email, kind }, 3600);
    return resetRoute.POST(json("/api/auth/reset", "POST", { token, password: "newpass123" }, ip()));
  };

  for (const kind of ["owner", "member"] as const) {
    it(`a ${kind}'s set is byte-identical after the reset, its entries and open registration stay, and the passkey still signs in`, async () => {
      const owner = await newUser("pkrs");
      const email = kind === "owner" ? owner.email : (await newMember(owner, "member", "m")).email;
      const e = await enrolPasskeys(email);
      const before = JSON.stringify(await rawSet(e.pid));
      const residue = passkeyResidue(e.pid);
      expect(residue).toHaveLength(4);
      const r = await reset(email, kind);
      expect(r.status).toBe(200);
      expect(JSON.stringify(await rawSet(e.pid))).toBe(before);
      expect(passkeyResidue(e.pid)).toEqual(residue);
      signOut();
      const signed = await passkeySignIn(e.softs[0], e.uid, 1);
      expect(signed.status).toBe(200);
      expect(await sessionPid()).toBe(e.pid);
    });
  }
});

describe("rule 2402 (route half): a new person at a reused legacy address never inherits a set", () => {
  it("a deleted member's set planted back (a rollback build's deletion) does not sign in the new member there; the same set with the new birth would", async () => {
    const owner = await newUser("pkre");
    const m = await newMember(owner, "member", "m", { legacy: true, shadow: false });
    const e = await enrolPasskeys(m.email, { reg: false });
    const oldSet = await rawSet(e.pid);
    const entries = reverseEntriesOf(e.pid);
    expect(entries).toHaveLength(2);
    expect(await forceRemoveMember(m.email)).toBe(true);
    // Task 6: the deletion took every passkey key of the person.
    expect(passkeyResidue(e.pid)).toEqual([]);
    expect(await passkeySignIn(e.softs[0], e.uid, 1)).toEqual({ status: 401, body: { ok: false, error: "passkey_failed" } });
    // A new member registers at the same address: the same legacy pid, another birth.
    await new Promise((r) => setTimeout(r, 5));
    await createMember(acct(owner), { email: m.email, name: "Again", password: "abc12345", lang: "ar", role: "member", invitedBy: owner.email });
    const born = (await getPerson(e.pid))!.createdAt;
    expect(born).not.toBe(e.born);
    // A rollback build that deleted the old member without knowing passkeys: the set and its reverse entries are back.
    await Promise.all([db.set(personKey.passkeys(e.pid), oldSet), ...entries.map((k) => db.set(k, e.pid))]);
    expect(await passkeySignIn(e.softs[0], e.uid, 2)).toEqual({ status: 401, body: { ok: false, error: "passkey_failed" } });
    expect(jar().get(SESSION_COOKIE)).toBeUndefined();
    expect(await listPasskeys(e.pid, born)).toEqual([]);
    // Contrast: the same set stamped with the new member's birth signs in, so the refusal above was the birth check.
    await db.set(personKey.passkeys(e.pid), { ...oldSet!, born });
    expect(await passkeySignIn(e.softs[0], e.uid, 3)).toEqual({ status: 200, body: { ok: true } });
    expect(await sessionPid()).toBe(e.pid);
  });
});

describe("rule 2425: a person's deletion takes its passkeys; a person still held elsewhere keeps them", () => {
  const failed = { status: 401, body: { ok: false, error: "passkey_failed" } };
  /** The owner's own session (the acting user and actor for `removeMember`). */
  const asOwner = async (email: string) => {
    await signIn(email);
    const u = (await currentUser())!;
    signOut();
    return u;
  };

  it("deleting an account alone takes the owner's and the member's sets, entries and open registrations; neither passkey signs in", async () => {
    const owner = await newUser("pkwo", { shadow: false });
    const m = await newMember(owner, "member", "m", { shadow: false });
    const [eo, em] = [await enrolPasskeys(owner.email), await enrolPasskeys(m.email)];
    expect(passkeyResidue(eo.pid)).toHaveLength(4);
    expect(passkeyResidue(em.pid)).toHaveLength(4);
    await wipeAccount(acct(owner));
    expect(passkeyResidue(eo.pid)).toEqual([]);
    expect(passkeyResidue(em.pid)).toEqual([]);
    expect(await passkeySignIn(eo.softs[0], eo.uid, 1)).toEqual(failed);
    expect(await passkeySignIn(em.softs[0], em.uid, 1)).toEqual(failed);
  });

  it("an owner whose person another membership still holds (the shadow) keeps the set byte for byte through the account's deletion", async () => {
    const owner = await newUser("pkwk");
    const e = await enrolPasskeys(owner.email);
    const before = passkeyResidue(e.pid);
    const set = JSON.stringify(await rawSet(e.pid));
    await wipeAccount(acct(owner));
    expect(await getPerson(e.pid)).not.toBeNull();
    expect(passkeyResidue(e.pid)).toEqual(before);
    expect(JSON.stringify(await rawSet(e.pid))).toBe(set);
  });

  it("removing a member alone (the forget step) takes its passkeys; the passkey no longer signs in", async () => {
    const owner = await newUser("pkwr", { shadow: false });
    const m = await newMember(owner, "member", "m", { shadow: false });
    const e = await enrolPasskeys(m.email);
    const o = await asOwner(owner.email);
    expect(await removeMember(o, o.actor!, m.email)).toEqual({ ok: true });
    expect(await getPerson(e.pid)).toBeNull();
    expect(passkeyResidue(e.pid)).toEqual([]);
    expect(await passkeySignIn(e.softs[0], e.uid, 1)).toEqual(failed);
  });

  it("a member leaving its last account takes its passkeys", async () => {
    const owner = await newUser("pkwl", { shadow: false });
    const m = await newMember(owner, "member", "m", { shadow: false });
    const e = await enrolPasskeys(m.email);
    await signIn(m.email);
    expect(await leaveTeam((await currentUser())!)).toEqual({ ok: true });
    signOut();
    expect(await getPerson(e.pid)).toBeNull();
    expect(passkeyResidue(e.pid)).toEqual([]);
    expect(await passkeySignIn(e.softs[1], e.uid, 1)).toEqual(failed);
  });

  it("a member removed from one account while another membership holds the person keeps the set byte for byte", async () => {
    const owner = await newUser("pkws");
    const m = await newMember(owner, "member", "m");
    const e = await enrolPasskeys(m.email);
    const before = passkeyResidue(e.pid);
    const set = JSON.stringify(await rawSet(e.pid));
    const o = await asOwner(owner.email);
    expect(await removeMember(o, o.actor!, m.email)).toEqual({ ok: true });
    expect(await getPerson(e.pid)).not.toBeNull();
    expect(passkeyResidue(e.pid)).toEqual(before);
    expect(JSON.stringify(await rawSet(e.pid))).toBe(set);
  });
});
