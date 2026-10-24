import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { jar, json, newMember as helperNewMember, newUser as helperNewUser, signIn, signOut, withHeaders } from "./helpers/session";
import { trackRounds } from "./helpers/rounds";
import { acct, currentPerson, currentUser, getUser, saveUser, sc, sessionKey, type User } from "@/lib/auth";
import { loginIndexOf, newAccountId } from "@/lib/account-id";
import { activeBrandIn, saveBrands, scopeFor, setActiveBrand, setActiveBrandIn, type BrandMeta } from "@/lib/brands";
import { db } from "@/lib/db";
import { accountKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { createMcpToken, userFromBearer } from "@/lib/mcp";
import { ownerOf } from "@/lib/membership";
import { newPersonId } from "@/lib/multi-org";
import { getMember, saveMember } from "@/lib/team";
import * as brandsRoute from "@/app/api/brands/route";

// Pins the legacy shape (multi-org M1): this file reads and writes R1's records by address (`user:`/`member:`, address-shaped
// person ids and actors), so its persons are legacy ones; each still holds a shadow membership unless it says `shadow: false`.
// Since the enable release (rule 3815) a legacy owner here is also an address-id account, as every account made before it.
const newUser = (prefix?: string, o: Parameters<typeof helperNewUser>[1] = {}) => helperNewUser(prefix, { legacy: true, addressId: true, ...o });
const newMember = (owner: Parameters<typeof helperNewMember>[0], role?: Parameters<typeof helperNewMember>[1], prefix?: string, o: Parameters<typeof helperNewMember>[3] = {}) => helperNewMember(owner, role, prefix, { legacy: true, ...o });

/**
 * Multi-workspace M1 expand (docs/specs/2026-10-18-multi-org.md sections 7, 8 and 15): `resolveSession` on the
 * person and the membership, `currentPerson`, the active brand per (person, account), and the MCP bearer's person.
 *
 * Rules 2111 (the membership is re-checked on every request), 2112 (partly: the account comes only from the session),
 * 2119 (partly: the active brand per (pid, aid)), 2120 (a token resolves to its own account), 2131 (account suspension
 * blocks that account, person suspension every account and every resolver), 2132 (a legacy session resolves to the same
 * user as before) and 2135 (every session in two rounds; a session from before R1 as today). The `p_` persons, accounts
 * and memberships are raw writes through the key builders, never the code under test.
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

describe("rule 2135: every kind of session resolves in two rounds; a session from before R1 as today", () => {
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

  it("a session written before R1: an owner in two rounds (as R1), a member in three (as before)", async () => {
    const owner = await newUser("r2lo");
    const m = await newMember(owner, "admin", "r2lm");
    const o = await rounds(owner.email, { legacyShape: true });
    expect(o.u?.actor?.kind).toBe("owner");
    expect(o.rounds).toBe(2);
    const mm = await rounds(m.email, { legacyShape: true });
    expect(mm.u?.actor?.kind).toBe("member");
    expect(mm.rounds).toBe(3);
    // Never rewritten on read: still no pid, no acct.
    const s = await sessionNow();
    expect(s).not.toHaveProperty("pid");
    expect(s).not.toHaveProperty("acct");
  });

  it("the R1 round reads the person, the login index, the account, the membership, the roster, the brands and both active-brand keys", async () => {
    const p = await twoAccounts();
    const r = await rounds(p.email, { acct: p.A });
    expect(r.keys).toEqual(expect.arrayContaining([
      personKey.person(p.pid), accountKey.user(p.pid), accountKey.member(p.pid), accountKey.login(p.email), accountKey.user(p.A),
      accountKey.membership(p.A, p.pid), accountKey.members(p.A), accountKey.brands(p.A), personKey.activeBrand(p.pid, p.A), accountKey.activeBrand(p.email),
    ]));
  });
});

describe("rule 2111: the membership is re-checked on every request", () => {
  it("a p_ member resolves into the session's account as a member, with that account's scope", async () => {
    const p = await twoAccounts();
    const u = (await as(p.email, p.A))!;
    expect(acct(u)).toBe(p.A);
    expect(sc(u)).toBe(scopeFor(p.A, "default"));
    expect(u.actor).toMatchObject({ kind: "member", pid: p.pid, email: p.email, role: "member", home: false });
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

  it("a legacy member removed (record deleted) or disabled resolves to nothing at the next request", async () => {
    const owner = await newUser("r11o");
    const m1 = await newMember(owner, "member", "r11a");
    const m2 = await newMember(owner, "member", "r11b");
    expect((await as(m1.email))?.actor?.kind).toBe("member");
    // A removal deletes the legacy record and, since multi-workspace M1, the membership row too (the roster entry
    // is kept here, to show neither record alone is enough).
    await Promise.all([db.del(accountKey.member(m1.email)), db.del(accountKey.membership(storedAccountId(acct(owner)), storedPersonId(m1.email)))]);
    expect(await currentUser()).toBeNull();
    expect((await as(m2.email))?.actor?.kind).toBe("member");
    const rec = (await getMember(m2.email))!;
    await saveMember({ ...rec, disabled: "seats" });
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
      expect(u.actor).toMatchObject({ kind: "token", pid, role: "owner", home: false });
      expect(u.actor!.pid).toBe(ownerOf(u));
    }
  });

  it("a legacy owner's token: actor.pid is ownerOf(u), the home account's legacy brand choice applies", async () => {
    const owner = await newUser("r20o");
    await brands(owner.email, "b1");
    await setActiveBrand(owner.email, "b1"); // written by a build before R1
    const u = (await userFromBearer(bearer(await createMcpToken(owner.email))))!;
    expect(u.actor).toMatchObject({ kind: "token", pid: ownerOf(u), home: true });
    expect(u.brandId).toBe("b1");
    expect(sc(u)).toBe(scopeFor(owner.email, "b1"));
  });
});

describe("rule 2119: the active brand is per (pid, aid); the legacy per-login key only for the home account", () => {
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
    // A p_ person has no home account: the legacy per-login key is never written.
    expect(await db.get(accountKey.activeBrand(p.email))).toBeNull();
  });

  it("a legacy member: the legacy key is read and written for the home account only", async () => {
    const owner = await newUser("r19o");
    const m = await newMember(owner, "member", "r19m");
    const mpid = storedPersonId(m.email);
    const B = await putAccount();
    await join(B, mpid);
    await Promise.all([brands(owner.email, "h1", "shared"), brands(B, "shared")]);
    // A choice written by a build before R1 (the legacy key only) is read in the home account...
    await setActiveBrand(m.email, "shared");
    expect((await as(m.email, owner.email))!.brandId).toBe("shared");
    // ...and never in another account, even where a brand of the same id exists.
    expect((await as(m.email, B))!.brandId).toBe("default");
    // A switch in B writes only the new key.
    expect((await brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "shared" }))).status).toBe(200);
    expect(await db.get(personKey.activeBrand(mpid, B))).toBe("shared");
    expect(await db.get(accountKey.activeBrand(m.email))).toBe("shared"); // unchanged, from before
    await as(m.email, owner.email);
    expect((await brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "h1" }))).status).toBe(200);
    // In the home account both keys move (a rollback to a build before R1 keeps the choice).
    expect(await db.get(personKey.activeBrand(mpid, storedAccountId(owner.email)))).toBe("h1");
    expect(await db.get(accountKey.activeBrand(m.email))).toBe("h1");
    expect((await as(m.email, B))!.brandId).toBe("shared");
  });

  it("activeBrandIn and setActiveBrandIn: the legacy key only with a home login, where a later legacy write wins", async () => {
    const email = address("ab");
    const pid = storedPersonId(email);
    const aid = storedAccountId(email);
    await db.set(accountKey.activeBrand(email), "legacy");
    expect(await activeBrandIn(pid, aid, email)).toBe("legacy");
    expect(await activeBrandIn(pid, aid, null)).toBe("default");
    // Not home: only the new key is written and read.
    await setActiveBrandIn(pid, aid, "fresh", null);
    expect(await db.get(accountKey.activeBrand(email))).toBe("legacy");
    expect(await activeBrandIn(pid, aid, null)).toBe("fresh");
    // Home: both keys, the same value.
    await setActiveBrandIn(pid, aid, "both", email);
    expect(await db.get(accountKey.activeBrand(email))).toBe("both");
    expect(await db.get(personKey.activeBrand(pid, aid))).toBe("both");
    expect(await activeBrandIn(pid, aid, email)).toBe("both");
    // A rolled-back build writes the legacy key alone; after the roll forward that later choice still wins.
    await setActiveBrand(email, "rolled");
    expect(await activeBrandIn(pid, aid, email)).toBe("rolled");
    // A home person without the legacy key reads the new one.
    await db.del(accountKey.activeBrand(email));
    expect(await activeBrandIn(pid, aid, email)).toBe("both");
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
    const forged = { "x-thakeen-acct": p.B, "x-account": p.B };
    const u = await withHeaders(forged, () => currentUser());
    expect(acct(u!)).toBe(p.A);
    // The workspace header takes a handle only (the switch is on, rule 3810): an account id there is no handle, so the
    // request answers 404 and opens nothing.
    await expect(withHeaders({ "x-thakeen-ws": p.B }, () => currentUser())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    const res = await brandsRoute.GET();
    const body = await res.json();
    expect(body.brands.map((b: { id: string }) => b.id).sort()).toEqual(["a1", "default"]);
    // A switch whose body names B's brand and B itself: B's brand is not A's, so nothing is chosen anywhere.
    const r = await brandsRoute.POST(json(`/api/brands?acct=${encodeURIComponent(p.B)}`, "POST", { action: "switch", id: "b1", acct: p.B, aid: p.B }, { ...forged, "x-thakeen-ws": p.B }));
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

  it("a session from before R1 finds its person through the login; an impersonation and a moved index find nobody", async () => {
    const owner = await newUser("cpo");
    await signIn(owner.email, { legacyShape: true });
    expect((await currentPerson())).toMatchObject({ person: { pid: owner.email }, acct: owner.email });
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
    // Release M3: the invitations inbox
    "src/app/api/workspaces/invites/route.ts",
    // Release M3: accepting an ownership offer, deleting one's own login
    "src/app/api/workspaces/transfer/route.ts",
    "src/app/api/workspaces/person/route.ts",
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

describe("rule 2132: a legacy owner and a legacy member resolve to the same user, scope, brand and actor as before", () => {
  it("the R1 session and the session from before R1 give equal users", async () => {
    const owner = await newUser("lgo");
    const m = await newMember(owner, "admin", "lgm");
    await brands(owner.email, "b1", "b2");
    await Promise.all([setActiveBrand(owner.email, "b1"), setActiveBrand(m.email, "b2")]);
    for (const email of [owner.email, m.email]) {
      const r1 = (await as(email))!;
      const old = (await as(email, undefined, { legacyShape: true }))!;
      expect(r1, email).toEqual(old);
      expect(acct(r1)).toBe(owner.email);
      expect(sc(r1)).toBe(scopeFor(owner.email, email === owner.email ? "b1" : "b2"));
      expect(r1.actor).toMatchObject({ email, pid: storedPersonId(email), home: true, kind: email === owner.email ? "owner" : "member" });
    }
  });
});
