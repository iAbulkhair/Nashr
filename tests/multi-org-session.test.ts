import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { jar, json, newMember as helperNewMember, newUser as helperNewUser, signIn, signOut, withHeaders } from "./helpers/session";
import { trackRounds } from "./helpers/rounds";
import { acct, currentPerson, currentUser, getUser, saveUser, sc, sessionKey, type User } from "@/lib/auth";
import { loginIndexOf, newAccountId } from "@/lib/account-id";
import { activeBrandIn, saveBrands, scopeFor, setActiveBrandIn, type BrandMeta } from "@/lib/brands";
import { db } from "@/lib/db";
import { accountKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { createMcpToken, userFromBearer } from "@/lib/mcp";
import { ownerOf } from "@/lib/membership";
import { newPersonId } from "@/lib/multi-org";
import * as brandsRoute from "@/app/api/brands/route";

// Legacy persons (pid = its address) beside the `p_` ones written raw below: from M4 (rule 2138) both resolve on `person:`,
// the membership and the (pid, aid) active brand alone. Each still holds a shadow membership unless it says `shadow: false`.
const newUser = (prefix?: string, o: Parameters<typeof helperNewUser>[1] = {}) => helperNewUser(prefix, { legacy: true, ...o });
const newMember = (owner: Parameters<typeof helperNewMember>[0], role?: Parameters<typeof helperNewMember>[1], prefix?: string, o: Parameters<typeof helperNewMember>[3] = {}) => helperNewMember(owner, role, prefix, { legacy: true, ...o });

/**
 * Multi-workspace M1 expand (docs/specs/2026-10-18-multi-org.md sections 7, 8 and 15): `resolveSession` on the
 * person and the membership, `currentPerson`, the active brand per (person, account), and the MCP bearer's person.
 *
 * Rules 2111 (the membership is re-checked on every request), 2112 (partly: the account comes only from the session),
 * 2119 (partly: the active brand per (pid, aid)), 2120 (a token resolves to its own account), 2131 (account suspension
 * blocks that account, person suspension every account and every resolver), 2135 (every session in two rounds) and 2138
 * (M4 contract: a session without `pid` is refused; `user:`/`member:` credentials, `member:` memberships and the
 * per-login `activebrand:{login}` are never read; it replaced rule 2132's "a legacy session resolves as before"). The
 * `p_` persons, accounts and memberships are raw writes through the key builders, never the code under test.
 */

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); signOut(); });

let n = 0;
const address = (p: string) => `${p}${++n}-${Math.random().toString(36).slice(2, 8)}@test.example`;
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-05T00:00:00.000Z";
const T2 = "2026-10-10T00:00:00.000Z";
const T3 = "2030-01-01T00:00:00.000Z";
const later = () => new Date(Date.now() + 60_000).toISOString();

/** A verified account record at `user:{aid}`, with `over` applied. */
async function putAccount(over: Partial<User> = {}): Promise<AccountId> {
  const id = newAccountId();
  const u = { id, email: address("acct"), name: "Account", phone: "", passHash: "hash-account", plan: "trial", credits: 40, trialEnds: T3, createdAt: T0, lang: "en", emailVerifiedAt: T0, sessionsAfter: T0, ...over } as User;
  await db.set(accountKey.user(id), u);
  return storedAccountId(id);
}
/** A `p_` person at `email`: its row and the login index naming it. */
async function putPerson(email: string, over: Record<string, unknown> = {}): Promise<PersonId> {
  const pid = storedPersonId(newPersonId());
  await Promise.all([
    db.set(personKey.person(pid), { pid, email, name: "Person", lang: "ar", passHash: "hash-person", emailVerifiedAt: T0, sessionsAfter: T0, createdAt: T0, ...over }),
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
/** An account the person owns (`ownerPid`), listed in `orgs:{pid}`. */
async function own(pid: PersonId, over: Partial<User> = {}): Promise<AccountId> {
  const aid = await putAccount({ ownerPid: pid, ...over } as Partial<User>);
  await db.sadd(personKey.orgs(pid), aid);
  return aid;
}
/** Two active brands besides the default one. */
async function brands(aid: string, ...ids: string[]) {
  const rows: BrandMeta[] = ids.map((id) => ({ id, name: id, createdAt: T0, status: "active" }));
  await saveBrands(aid, rows);
}
/** A member of two accounts, A and B, both owned by other people. */
async function twoAccounts() {
  const email = address("p");
  const pid = await putPerson(email);
  const [A, B] = await Promise.all([putAccount(), putAccount()]);
  await Promise.all([join(A, pid), join(B, pid, { role: "admin" })]);
  return { email, pid, A, B };
}
const as = async (email: string, acctId?: string, opts: { legacyShape?: boolean } = {}) => {
  await signIn(email, { ...opts, ...(acctId ? { acct: acctId } : {}) });
  return currentUser();
};
const bearer = (t: string) => new Request("https://nashr.test/api/mcp", { headers: { authorization: `Bearer ${t}` } });
const sessionNow = () => db.get<Record<string, unknown>>(sessionKey(jar().get("thakeen_session")!));

describe("tests/helpers/rounds.ts counts real rounds", () => {
  it("a Promise.all is one round, sequential awaits are one round each, a late joiner rides the open round", async () => {
    const t = trackRounds();
    await Promise.all([db.get("r:a"), db.get("r:b"), db.sismember("r:c", "x")]);
    expect(t.rounds()).toBe(1);
    t.start();
    await db.get("r:a");
    await db.get("r:b");
    await db.get("r:c");
    expect(t.rounds()).toBe(3);
    t.start();
    await Promise.all([db.get("r:a"), db.get("r:b")]);
    await db.get("r:c");
    expect(t.rounds()).toBe(2);
    t.start();
    // A call started a few microtasks after the first (behind an already-resolved dynamic import) is still in flight
    // with it: the same parallel batch.
    await Promise.all([db.get("r:a"), (async () => { await import("@/lib/brands"); await Promise.resolve(); return db.get("r:b"); })()]);
    expect(t.rounds()).toBe(1);
    expect(t.calls.map((c) => c.round)).toEqual([1, 1]);
    t.stop();
  });
});

describe("rule 2135: every kind of session resolves in two rounds; rule 2138: a session from before R1 is refused", () => {
  const rounds = async (email: string, opts: { legacyShape?: boolean; acct?: string } = {}) => {
    await signIn(email, opts);
    const t = trackRounds();
    const u = await currentUser();
    t.stop();
    return { u, rounds: t.rounds(), keys: t.calls.map((c) => c.key) };
  };

  it("an owner, a legacy member and a p_ member: the session read, then ONE round", async () => {
    const owner = await newUser("r2o");
    const m = await newMember(owner, "member", "r2m");
    const p = await twoAccounts();
    for (const [email, acctId] of [[owner.email, undefined], [m.email, undefined], [p.email, p.B]] as const) {
      const r = await rounds(email, acctId ? { acct: acctId } : {});
      expect(r.u, email).not.toBeNull();
      expect(r.rounds, email).toBe(2);
    }
  });

  it("rule 2138: a session written before R1 (no pid) is refused for an owner and a member, after the session read alone", async () => {
    const owner = await newUser("r2lo");
    const m = await newMember(owner, "admin", "r2lm");
    for (const email of [owner.email, m.email]) {
      const r = await rounds(email, { legacyShape: true });
      expect(r.u, email).toBeNull();
      expect(r.rounds, email).toBe(1);
      expect(await currentPerson(), email).toBeNull();
      // Never rewritten on read: still no pid, no acct.
      const s = await sessionNow();
      expect(s).not.toHaveProperty("pid");
      expect(s).not.toHaveProperty("acct");
      // The same login signed in again (a session with pid and acct) resolves.
      expect((await as(email))?.actor?.kind, email).toBe(email === owner.email ? "owner" : "member");
    }
  });

  it("the round reads the person, the login index, the account, the membership, the roster, the brands and the (pid, aid) active brand; never a legacy key", async () => {
    const p = await twoAccounts();
    const r = await rounds(p.email, { acct: p.A });
    expect(r.keys).toEqual(expect.arrayContaining([
      personKey.person(p.pid), accountKey.login(p.email), accountKey.user(p.A),
      accountKey.membership(p.A, p.pid), accountKey.members(p.A), accountKey.brands(p.A), personKey.activeBrand(p.pid, p.A),
    ]));
    // M4 (rule 2138): no `user:{pid}` / `member:{pid}` credential read, no per-login active brand.
    for (const k of [accountKey.user(p.pid), accountKey.member(p.pid), accountKey.member(p.email), accountKey.activeBrand(p.email)]) expect(r.keys).not.toContain(k);
  });
});

describe("rule 2111: the membership is re-checked on every request", () => {
  it("a p_ member resolves into the session's account as a member, with that account's scope", async () => {
    const p = await twoAccounts();
    const u = (await as(p.email, p.A))!;
    expect(acct(u)).toBe(p.A);
    expect(sc(u)).toBe(scopeFor(p.A, "default"));
    expect(u.actor).toMatchObject({ kind: "member", pid: p.pid, email: p.email, role: "member" });
    expect(u.actor).not.toHaveProperty("home");
    const b = (await as(p.email, p.B))!;
    expect(acct(b)).toBe(p.B);
    expect(b.actor).toMatchObject({ kind: "member", pid: p.pid, role: "admin" });
  });

  it("removed (row deleted), off the roster, paused for seats or left: the next request is not in that account", async () => {
    const cases: [string, (p: Awaited<ReturnType<typeof twoAccounts>>) => Promise<unknown>][] = [
      ["row deleted", (p) => db.del(accountKey.membership(p.A, p.pid))],
      ["off the roster", (p) => db.srem(accountKey.members(p.A), p.pid)],
      ["paused for seats", (p) => db.set(accountKey.membership(p.A, p.pid), { aid: p.A, pid: p.pid, role: "member", acceptedAt: T1, invitedBy: "p_inviterinviterinviterinv", disabled: "seats" })],
      ["left (row, roster and orgs entry gone)", (p) => Promise.all([db.del(accountKey.membership(p.A, p.pid)), db.srem(accountKey.members(p.A), p.pid), db.srem(personKey.orgs(p.pid), p.A)])],
    ];
    for (const [label, change] of cases) {
      const p = await twoAccounts();
      expect(await as(p.email, p.A), label).not.toBeNull();
      await change(p);
      expect(await currentUser(), label).toBeNull();
      // The other account still resolves for the same person.
      expect(acct((await as(p.email, p.B))!), label).toBe(p.B);
    }
  });

  it("a legacy member: the membership row alone decides (rule 2138); a leftover `member:` record neither holds nor ends it", async () => {
    const owner = await newUser("r11o");
    const m1 = await newMember(owner, "member", "r11a");
    const m2 = await newMember(owner, "member", "r11b");
    const A = storedAccountId(acct(owner));
    expect((await as(m1.email))?.actor?.kind).toBe("member");
    // The membership row deleted (the roster entry kept): nothing, whatever `member:` says.
    await db.set(accountKey.member(m1.email), { email: m1.email, memberOf: owner.email, role: "member", acceptedAt: T1 });
    await db.del(accountKey.membership(A, storedPersonId(m1.email)));
    expect(await currentUser()).toBeNull();
    // A `member:` record deleted alone changes nothing; the row paused for seats ends it.
    expect((await as(m2.email))?.actor?.kind).toBe("member");
    await db.del(accountKey.member(m2.email));
    expect((await currentUser())?.actor?.kind).toBe("member");
    const k = accountKey.membership(A, storedPersonId(m2.email));
    await db.set(k, { ...(await db.get<Record<string, unknown>>(k))!, disabled: "seats" });
    expect(await currentUser()).toBeNull();
  });

  it("a membership accepted before the account was created grants nothing (roleIn alone would; membershipHolds refuses)", async () => {
    const email = address("old");
    const pid = await putPerson(email);
    const A = await putAccount({ createdAt: T2 });
    const row = (acceptedAt: string) => ({ aid: A, pid, role: "member", acceptedAt, invitedBy: "p_inviterinviterinviterinv" });
    await join(A, pid, { acceptedAt: T2 });
    expect(acct((await as(email, A))!)).toBe(A);
    expect((await sessionNow())).toMatchObject({ pid, acct: A });
    // The same row accepted before the account existed (a re-registered owner address): nothing.
    await db.set(accountKey.membership(A, pid), row(T1));
    expect(await currentUser()).toBeNull();
    await db.set(accountKey.membership(A, pid), row("not a date"));
    expect(await currentUser()).toBeNull();
    await db.set(accountKey.membership(A, pid), row(T2));
    expect(acct((await currentUser())!)).toBe(A);
  });

  it("the team's revocation stamp, an unverified owner (rule 767) and a moved login index end a member's session", async () => {
    const p = await twoAccounts();
    expect(await as(p.email, p.A)).not.toBeNull();
    const a = (await getUser(p.A))!;
    await saveUser({ ...a, teamSessionsAfter: later() });
    expect(await currentUser()).toBeNull();

    const q = await twoAccounts();
    expect(await as(q.email, q.A)).not.toBeNull();
    const qa = (await getUser(q.A))!;
    delete qa.emailVerifiedAt;
    await saveUser(qa);
    expect(await currentUser()).toBeNull();

    const r = await twoAccounts();
    expect(await as(r.email, r.A)).not.toBeNull();
    await db.set(accountKey.login(r.email), loginIndexOf(storedPersonId(newPersonId())));
    expect(await currentUser()).toBeNull();
  });

  it("a session record naming an account the person holds nothing in resolves to nothing (a forged acct)", async () => {
    const p = await twoAccounts();
    const stranger = await putAccount();
    expect(await as(p.email, stranger)).toBeNull();
    // A legacy owner's session naming another owner's account.
    const o1 = await newUser("r11f");
    const o2 = await newUser("r11g");
    expect(await as(o1.email, o2.email)).toBeNull();
  });
});

describe("rule 2131: account suspension blocks that account, person suspension every account and every resolver", () => {
  it("account A suspended: the session in A is refused, the same person in B still resolves", async () => {
    const p = await twoAccounts();
    const a = (await getUser(p.A))!;
    await saveUser({ ...a, suspended: true } as User);
    expect(await as(p.email, p.A)).toBeNull();
    expect(acct((await as(p.email, p.B))!)).toBe(p.B);
  });

  it("person suspended: two sessions in two accounts both refused, currentPerson too", async () => {
    const p = await twoAccounts();
    await signIn(p.email, { acct: p.A });
    const tokenA = jar().get("thakeen_session")!;
    await signIn(p.email, { acct: p.B });
    const tokenB = jar().get("thakeen_session")!;
    const row = (await db.get<Record<string, unknown>>(personKey.person(p.pid)))!;
    await db.set(personKey.person(p.pid), { ...row, suspended: true });
    for (const t of [tokenA, tokenB]) {
      jar().set("thakeen_session", t);
      expect(await currentUser()).toBeNull();
      expect(await currentPerson()).toBeNull();
    }
  });

  it("a legacy owner's person suspended: the session and the owner's MCP token are refused", async () => {
    const owner = await newUser("r31o");
    const t = await createMcpToken(owner.email);
    expect(await userFromBearer(bearer(t))).not.toBeNull();
    const pid = storedPersonId(owner.email);
    await db.set(personKey.person(pid), { pid, email: owner.email, name: owner.name, lang: owner.lang, passHash: owner.passHash, emailVerifiedAt: T0, sessionsAfter: owner.sessionsAfter, createdAt: owner.createdAt, suspended: true });
    expect(await userFromBearer(bearer(t))).toBeNull();
    expect(await as(owner.email)).toBeNull();
  });

  it("a p_ owner of two accounts suspended: both tokens refused; account A suspended alone leaves B's token working", async () => {
    const email = address("own");
    const pid = await putPerson(email);
    const [A, B] = [await own(pid), await own(pid)];
    const [tA, tB] = await Promise.all([createMcpToken(A), createMcpToken(B)]);
    expect(acct((await userFromBearer(bearer(tA)))!)).toBe(A);
    const a = (await getUser(A))!;
    await saveUser({ ...a, suspended: true } as User);
    expect(await userFromBearer(bearer(tA))).toBeNull();
    expect(acct((await userFromBearer(bearer(tB)))!)).toBe(B);
    const row = (await db.get<Record<string, unknown>>(personKey.person(pid)))!;
    await db.set(personKey.person(pid), { ...row, suspended: true });
    expect(await userFromBearer(bearer(tB))).toBeNull();
  });
});

describe("rule 2120: a token resolves to its own account and never follows a switch", () => {
  it("an owner of two accounts holds two independent tokens; a session in the other account does not move either", async () => {
    const email = address("tok");
    const pid = await putPerson(email);
    const [A, B] = [await own(pid), await own(pid)];
    await Promise.all([brands(A, "ba"), brands(B, "bb")]);
    const [tA, tB] = await Promise.all([createMcpToken(A), createMcpToken(B)]);
    // The browser session is in B and chooses a brand there.
    const s = (await as(email, B))!;
    expect(acct(s)).toBe(B);
    expect((await brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "bb" }))).status).toBe(200);
    const [uA, uB] = await Promise.all([userFromBearer(bearer(tA)), userFromBearer(bearer(tB))]);
    expect(acct(uA!)).toBe(A);
    expect(uA!.brandId).toBe("default");
    expect(acct(uB!)).toBe(B);
    expect(uB!.brandId).toBe("bb");
    for (const u of [uA!, uB!]) {
      expect(u.actor).toMatchObject({ kind: "token", pid, role: "owner" });
      expect(u.actor!.pid).toBe(ownerOf(u));
    }
  });

  it("a legacy owner's token: actor.pid is ownerOf(u); the per-login brand key is ignored, the (pid, aid) one applies (rule 2138)", async () => {
    const owner = await newUser("r20o");
    await brands(owner.email, "b1", "b2");
    await db.set(accountKey.activeBrand(owner.email), "b1"); // written by a build before M4
    const t = await createMcpToken(owner.email);
    const u = (await userFromBearer(bearer(t)))!;
    expect(u.actor).toMatchObject({ kind: "token", pid: ownerOf(u) });
    expect(u.brandId).toBe("default");
    await setActiveBrandIn(ownerOf(u), storedAccountId(owner.email), "b2");
    const v = (await userFromBearer(bearer(t)))!;
    expect(v.brandId).toBe("b2");
    expect(sc(v)).toBe(scopeFor(owner.email, "b2"));
  });
});

describe("rule 2119: the active brand is per (pid, aid); rule 2138: the per-login key is never read or written", () => {
  it("choosing a brand in B never moves A, and back", async () => {
    const p = await twoAccounts();
    await Promise.all([brands(p.A, "x", "y"), brands(p.B, "x", "z")]);
    await as(p.email, p.A);
    expect((await brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "x" }))).status).toBe(200);
    expect((await currentUser())!.brandId).toBe("x");
    await as(p.email, p.B);
    expect((await currentUser())!.brandId).toBe("default");
    expect((await brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "z" }))).status).toBe(200);
    expect((await as(p.email, p.A))!.brandId).toBe("x");
    expect((await as(p.email, p.B))!.brandId).toBe("z");
    expect(await db.get(personKey.activeBrand(p.pid, p.A))).toBe("x");
    expect(await db.get(personKey.activeBrand(p.pid, p.B))).toBe("z");
    // The per-login key is never written.
    expect(await db.get(accountKey.activeBrand(p.email))).toBeNull();
  });

  it("a legacy member: a per-login choice left by a build before M4 is read in no account, and a switch never writes it", async () => {
    const owner = await newUser("r19o");
    const m = await newMember(owner, "member", "r19m");
    const mpid = storedPersonId(m.email);
    const B = await putAccount();
    await join(B, mpid);
    await Promise.all([brands(owner.email, "h1", "shared"), brands(B, "shared")]);
    await db.set(accountKey.activeBrand(m.email), "shared");
    expect((await as(m.email, owner.email))!.brandId).toBe("default");
    expect((await as(m.email, B))!.brandId).toBe("default");
    // A switch in B writes only the (pid, aid) key.
    expect((await brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "shared" }))).status).toBe(200);
    expect(await db.get(personKey.activeBrand(mpid, B))).toBe("shared");
    await as(m.email, owner.email);
    expect((await brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "h1" }))).status).toBe(200);
    expect(await db.get(personKey.activeBrand(mpid, storedAccountId(owner.email)))).toBe("h1");
    expect(await db.get(accountKey.activeBrand(m.email))).toBe("shared"); // unchanged, from before M4
    expect((await as(m.email, B))!.brandId).toBe("shared");
    expect((await as(m.email, owner.email))!.brandId).toBe("h1");
  });

  it("activeBrandIn and setActiveBrandIn: the (pid, aid) key alone", async () => {
    const email = address("ab");
    const pid = storedPersonId(email);
    const aid = storedAccountId(email);
    await db.set(accountKey.activeBrand(email), "legacy");
    expect(await activeBrandIn(pid, aid)).toBe("default");
    await setActiveBrandIn(pid, aid, "fresh");
    expect(await db.get(personKey.activeBrand(pid, aid))).toBe("fresh");
    expect(await db.get(accountKey.activeBrand(email))).toBe("legacy");
    expect(await activeBrandIn(pid, aid)).toBe("fresh");
    // A later per-login write (a build before M4 after a rollback) is not read by M4.
    await db.set(accountKey.activeBrand(email), "rolled");
    expect(await activeBrandIn(pid, aid)).toBe("fresh");
  });

  it("a store error on the brand list does not end the request: the stored choice, unchecked, in the same account", async () => {
    const p = await twoAccounts();
    await brands(p.A, "x");
    await db.set(personKey.activeBrand(p.pid, p.A), "x");
    await signIn(p.email, { acct: p.A });
    const real = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation(((k: string) => (k === accountKey.brands(p.A) ? Promise.reject(new Error("down")) : real(k))) as typeof db.get);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const u = (await currentUser())!;
    expect(acct(u)).toBe(p.A);
    expect(u.brandId).toBe("x");
    expect(sc(u)).toBe(scopeFor(p.A, "x"));
    expect(err.mock.calls.flat().join(" ")).not.toContain(p.email);
  });

  it("an archived or unknown brand in the new key reads as the default brand (validated against the account)", async () => {
    const p = await twoAccounts();
    await brands(p.A, "x");
    await db.set(personKey.activeBrand(p.pid, p.A), "gone");
    expect((await as(p.email, p.A))!.brandId).toBe("default");
  });
});

describe("rule 2112 (partly): the active account comes only from the session", () => {
  it("a header, a query value or a body naming another account changes nothing", async () => {
    const p = await twoAccounts();
    await Promise.all([brands(p.A, "a1"), brands(p.B, "b1")]);
    await as(p.email, p.A);
    const forged = { "x-thakeen-ws": p.B, "x-thakeen-acct": p.B, "x-account": p.B };
    const u = await withHeaders(forged, () => currentUser());
    expect(acct(u!)).toBe(p.A);
    const res = await brandsRoute.GET();
    const body = await res.json();
    expect(body.brands.map((b: { id: string }) => b.id).sort()).toEqual(["a1", "default"]);
    // A switch whose body names B's brand and B itself: B's brand is not A's, so nothing is chosen anywhere.
    const r = await brandsRoute.POST(json(`/api/brands?acct=${encodeURIComponent(p.B)}`, "POST", { action: "switch", id: "b1", acct: p.B, aid: p.B }, forged));
    expect(r.status).toBe(404);
    expect(await db.get(personKey.activeBrand(p.pid, p.B))).toBeNull();
    expect(await db.get(personKey.activeBrand(p.pid, p.A))).toBeNull();
    expect((await sessionNow())!.acct).toBe(p.A);
  });
});

describe("currentPerson: the person behind a session, with or without a valid account", () => {
  it("a live session: the person and the active account; a membership gone: the person, no account", async () => {
    const p = await twoAccounts();
    await as(p.email, p.A);
    const live = (await currentPerson())!;
    expect(live.person.pid).toBe(p.pid);
    expect(live.acct).toBe(p.A);
    await db.del(accountKey.membership(p.A, p.pid));
    expect(await currentUser()).toBeNull();
    const none = (await currentPerson())!;
    expect(none.person.pid).toBe(p.pid);
    expect(none.acct).toBeNull();
  });

  it("a session from before R1 (rule 2138), an impersonation and a moved index find nobody", async () => {
    const owner = await newUser("cpo");
    await signIn(owner.email, { legacyShape: true });
    expect(await currentPerson()).toBeNull();
    await signIn(owner.email);
    expect((await currentPerson())).toMatchObject({ person: { pid: storedPersonId(owner.email) }, acct: storedAccountId(owner.email) });
    await signIn(owner.email, { imp: "founder-cp@test.example" });
    expect(await currentUser()).not.toBeNull();
    expect(await currentPerson()).toBeNull();
    const p = await twoAccounts();
    await as(p.email, p.A);
    await db.set(accountKey.login(p.email), loginIndexOf(storedPersonId(newPersonId())));
    expect(await currentPerson()).toBeNull();
  });

  // The callers the spec lists (section 7 "No workspace" state), built in M2: the app layout (it sends a person without a
  // workspace to the workspaces page), that page, its routes, the join page and the accept route.
  const PERSON_CALLERS = [
    "src/app/[lang]/app/layout.tsx",
    "src/app/[lang]/app/workspaces/page.tsx",
    "src/app/api/workspaces/route.ts",
    "src/app/api/workspaces/switch/route.ts",
    "src/app/[lang]/app/join/page.tsx",
    "src/app/api/team/accept/route.ts",
  ];
  it("only the listed pages and routes call currentPerson (spec section 7, pinned like rule 752)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const f = pathJoin(dir, name);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(ts|tsx)$/.test(name)) files.push(f);
      }
    };
    walk(pathJoin("src", "app"));
    expect(files.length).toBeGreaterThan(50);
    const callers = files.filter((f) => /\bcurrentPerson\(/.test(readFileSync(f, "utf8"))).map((f) => f.split("\\").join("/"));
    expect(callers.filter((f) => !PERSON_CALLERS.includes(f))).toEqual([]);
  });
});

describe("rule 2138: a legacy owner and a legacy member resolve on person:, the membership and the (pid, aid) brand", () => {
  it("each resolves into the owner's account with its own brand and actor; the session from before R1 resolves to nothing", async () => {
    const owner = await newUser("lgo");
    const m = await newMember(owner, "admin", "lgm");
    const A = storedAccountId(owner.email);
    await brands(owner.email, "b1", "b2");
    await Promise.all([setActiveBrandIn(storedPersonId(owner.email), A, "b1"), setActiveBrandIn(storedPersonId(m.email), A, "b2")]);
    for (const email of [owner.email, m.email]) {
      const u = (await as(email))!;
      expect(acct(u)).toBe(owner.email);
      expect(sc(u)).toBe(scopeFor(owner.email, email === owner.email ? "b1" : "b2"));
      expect(u.actor).toMatchObject({ email, pid: storedPersonId(email), kind: email === owner.email ? "owner" : "member" });
      expect(u.actor).not.toHaveProperty("home");
      // The account record carries no credentials (`saveUser` strips them, Script S2 removes the rest).
      expect(u).not.toHaveProperty("passHash");
      expect(await as(email, undefined, { legacyShape: true }), email).toBeNull();
    }
  });
});

describe("rule 2767: a store error while building a session is not swallowed into a session without pid", () => {
  it("sessionIds and createSession reject, and no session record or cookie is written", async () => {
    const u = await newUser("sid");
    const { sessionIds, createSession } = await import("@/lib/auth");
    const realGet = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation(((k: string) => (k === accountKey.login(u.email) ? Promise.reject(new Error("store_down")) : realGet(k))) as typeof db.get);
    await expect(sessionIds(u.email)).rejects.toThrow("store_down");
    signOut();
    const set = vi.spyOn(db, "set");
    await expect(createSession(u.email)).rejects.toThrow("store_down");
    expect(set).not.toHaveBeenCalled();
    expect(jar().get("thakeen_session")).toBeUndefined();
  });
});
