import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { json, jar, markVerified, newMember as helperNewMember, newUser as helperNewUser, signIn, signOut } from "./helpers/session";
import { acct, createUser, currentUser, getLogin, getUser, saveUser, type Actor, type Plan, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { getMembership, listOrgs, ownerOf } from "@/lib/membership";
import { getPerson } from "@/lib/person";
import { createInvite, writeMembership } from "@/lib/team";
import { readTeamLog } from "@/lib/teamlog";
import { lastSignIn, recordDevice } from "@/lib/devices";
import { wipeAccount } from "@/lib/account";
import { workspaceView } from "@/lib/admin-workspace";
import { applyTransaction, refundPaymobPayment } from "@/lib/billing";
import { paymentProvider } from "@/lib/payments";
import type { Payment } from "@/lib/partners";
import * as acceptRoute from "@/app/api/team/accept/route";
import * as checkout from "@/app/api/billing/checkout/route";
import * as webhook from "@/app/api/billing/paymob/webhook/route";
import * as planRoute from "@/app/api/admin/plan/route";
import * as sessionsRoute from "@/app/api/account/sessions/route";
import { TXN_HMAC_FIELDS, hmacString, signHmac } from "@/lib/paymob";

// Both switches are on since the enable release (rule 3810). The one test that pins R1's deletion of a legacy team (the
// member's person and login go with its last membership) runs with both off again (`offPath`), the rollback floor
// (rule 3814); everything else runs as production does now.
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/multi-org", async (orig) => {
  const real = await orig<typeof import("@/lib/multi-org")>();
  return { ...real, get MULTI_ORG() { return flag.on; } };
});
vi.mock("@/lib/account-id", async (orig) => {
  const real = await orig<typeof import("@/lib/account-id")>();
  return { ...real, get OPAQUE_IDS() { return flag.on; } };
});
/** Inside a describe: its tests run with `MULTI_ORG` and `OPAQUE_IDS` off, as an M1 build (the rollback floor) does. */
const offPath = () => beforeEach(() => { flag.on = false; });

// Pins the legacy shape (multi-org M1): this file reads and writes R1's records by address (`user:`/`member:`, address-shaped
// person ids and actors), so its persons are legacy ones; each still holds a shadow membership unless it says `shadow: false`.
const newUser = (prefix?: string, o: Parameters<typeof helperNewUser>[1] = {}) => helperNewUser(prefix, { legacy: true, ...o });
const newMember = (owner: Parameters<typeof helperNewMember>[0], role?: Parameters<typeof helperNewMember>[1], prefix?: string, o: Parameters<typeof helperNewMember>[3] = {}) => helperNewMember(owner, role, prefix, { legacy: true, ...o });

/**
 * Multi-workspace M1 expand (docs/specs/2026-10-18-multi-org.md sections 9 and 15, plan reconciliation 7):
 * deleting an account removes its memberships through `wipeMemberships` and keeps every member's other accounts (rule
 * 2126, M1 half); the founder console's workspace view finds the account as a sign-in does and shows a member's other
 * workspaces as a count only (rule 2130's read-only part, rule 2079); a team lock timeout is "busy" wherever a caller
 * reaches `enforceSeats` or an accept (rule 2139): 409 for the accept, the console refund and the console plan route (which
 * then writes nothing), 503 for the Paymob callback (its retry contract). The single-membership member wipe is pinned by
 * tests/account-security-wipe.test.ts, which runs unchanged.
 */

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); signOut(); flag.on = true; });

const address = (p: string) => `${p}-${randomBytes(4).toString("hex")}@test.example`;
const aidOf = (u: User): AccountId => storedAccountId(acct(u));
const withPlan = async (u: User, plan: Plan) => { const x = { ...(await getUser(acct(u)))!, plan }; await saveUser(x); return x; };
const ownerActor = (u: User): Actor => ({ kind: "owner", pid: ownerOf(u), home: true, email: u.email, name: u.name, lang: u.lang, role: "owner" });
/** A membership of `pid` in `to` that is not the person's home, as release M2's accept will write it. */
const join = (to: User, pid: PersonId) =>
  writeMembership(aidOf(to), pid, { aid: aidOf(to), pid, role: "member", acceptedAt: new Date().toISOString(), invitedBy: ownerOf(to) }, { home: false, teamLocked: true });
/** A `p_` person (the M2 shape) who owns one account and has signed in once on a device. */
const pPerson = async (p: string) => {
  const e = address(p);
  const owned = await createUser({ email: e, name: "P", phone: "", password: "abc12345", lang: "en" }, { person: "p" });
  await recordDevice(e, `session:h:${randomBytes(4).toString("hex")}`);
  return { e, owned, pid: ownerOf(owned) };
};

/** Every stored key whose name contains one of `needles`, with its value, from the in-memory store. */
const snapshot = (needles: string[]) => {
  const mem = (globalThis as unknown as { __nashrMem: Record<string, unknown> }).__nashrMem;
  const out: Record<string, unknown> = {};
  for (const [family, table] of Object.entries(mem)) {
    if (!(table instanceof Map) || family === "owners") continue;
    for (const [k, v] of table as Map<string, unknown>) {
      if (k.startsWith("lock:") || !needles.some((n) => k.includes(n))) continue;
      out[`${family} ${k}`] = v instanceof Set ? [...v].sort() : v instanceof Map ? Object.fromEntries([...v].sort(([a], [b]) => String(a).localeCompare(String(b)))) : v;
    }
  }
  return out;
};

/** A person in three accounts: owner of A, member of B and C (B joined first), each with an active brand there. */
async function threeAccounts() {
  const P = await pPerson("three");
  const [B, C] = [await withPlan(await newUser("tb"), "pro"), await withPlan(await newUser("tc"), "pro")];
  await join(B, P.pid);
  // A later millisecond: two joins in one tie on the date, and the order then falls to the account ids, random `a_` ones
  // since the enable release (rule 3810).
  await new Promise((r) => setTimeout(r, 5));
  await join(C, P.pid);
  await Promise.all([db.set(personKey.activeBrand(P.pid, aidOf(B)), "default"), db.set(personKey.activeBrand(P.pid, aidOf(C)), "default")]);
  // Someone else on each roster, so the other accounts have a team of their own to keep. No shadow memberships: they
  // hold nothing else, so `alsoIn` counts 0 for them (multi-org M1).
  const [mB, mC] = [await newMember(B, "member", "m", { shadow: false }), await newMember(C, "member", "m", { shadow: false })];
  return { P, A: P.owned, B, C, mB, mC };
}
const resolveAs = async (email: string, account: User) => { await signIn(email, { acct: acct(account) }); return currentUser(); };
/** The other members' own records (`person:`, `member:`, `mbr:`, `orgs:`, the login index): by address and person id. */
const memberNeedles = (...ms: { email: string }[]) => ms.flatMap((m) => [m.email, storedPersonId(m.email) as string]);

describe("rule 2126 (M1 half): deleting an account keeps its members' other accounts", () => {
  it("deleting a member-account (B) leaves A and C working and every key of A and C unchanged", async () => {
    const { P, A, B, C, mC } = await threeAccounts();
    const needles = [acct(A), acct(C), ...memberNeedles(mC)];
    const before = snapshot(needles);
    expect(Object.keys(before).some((k) => k.includes(`mbr:${acct(C)}:${P.pid}`))).toBe(true);
    expect(Object.keys(before).some((k) => k.includes(`login:${mC.email}`))).toBe(true);
    await wipeAccount(acct(B));
    expect(await db.get(accountKey.user(acct(B)))).toBeNull();
    expect(snapshot(needles)).toEqual(before);
    expect(await getMembership(aidOf(B), P.pid)).toBeNull();
    expect(await db.sismember(personKey.orgs(P.pid), acct(B))).toBeFalsy();
    expect(await db.get(personKey.activeBrand(P.pid, aidOf(B)))).toBeNull();
    // Still an owner of A, still a member of C, the person and its credentials whole.
    expect((await listOrgs(P.pid)).map((o) => o.aid).sort()).toEqual([acct(A), acct(C)].sort());
    expect(await getLogin(P.e)).toMatchObject({ kind: "owner", pid: P.pid, acct: acct(A) });
    expect(acct((await resolveAs(P.e, C))!)).toBe(acct(C));
    expect(await getMembership(aidOf(C), P.pid)).not.toBeNull();
    expect(await db.get(personKey.activeBrand(P.pid, aidOf(C)))).toBe("default");
    expect(await lastSignIn(P.e)).not.toBeNull();
  }, 30_000);

  it("deleting the owned account (A) leaves the person's two memberships, its login, devices and every key of B and C", async () => {
    const { P, A, B, C, mB, mC } = await threeAccounts();
    const needles = [acct(B), acct(C), ...memberNeedles(mB, mC)];
    const before = snapshot(needles);
    expect(Object.keys(before).some((k) => k.includes(`login:${mB.email}`))).toBe(true);
    await wipeAccount(acct(A));
    expect(await db.get(accountKey.user(acct(A)))).toBeNull();
    expect(snapshot(needles)).toEqual(before);
    // The person outlives the account it owned: its row, its login index, its device sessions.
    expect((await getPerson(P.pid))?.email).toBe(P.e);
    expect(await db.get(accountKey.login(P.e))).not.toBeNull();
    expect(await lastSignIn(P.e)).not.toBeNull();
    expect((await listOrgs(P.pid)).map((o) => o.aid).sort()).toEqual([acct(B), acct(C)].sort());
    expect(await db.sismember(personKey.orgs(P.pid), acct(A))).toBeFalsy();
    // It now signs in as a member of its oldest membership, and may still open C.
    expect(await getLogin(P.e)).toMatchObject({ kind: "member", pid: P.pid, acct: acct(B) });
    expect(acct((await resolveAs(P.e, C))!)).toBe(acct(C));
  }, 30_000);

  it("a p_ owner's session naming the deleted account resolves to nothing (401) and never falls through to its next account", async () => {
    const { P, A, B } = await threeAccounts();
    await markVerified(acct(A));
    await signIn(P.e, { acct: acct(A) });
    expect(acct((await currentUser())!)).toBe(acct(A));
    await wipeAccount(acct(A));
    // The person still signs in to B (its oldest membership), but this session named A: reconciliation 3, no `pickAccount`.
    expect(await getLogin(P.e)).toMatchObject({ kind: "member", acct: acct(B) });
    expect(await currentUser()).toBeNull();
    expect((await sessionsRoute.GET()).status).toBe(401);
  }, 30_000);

  it("a p_ owner with nothing else goes with its account: person, account list, last pick, login, devices (reconciliation 7)", async () => {
    const P = await pPerson("alone");
    await db.set(personKey.lastOrg(P.pid), acct(P.owned));
    await wipeAccount(acct(P.owned));
    expect(await db.get(personKey.person(P.pid))).toBeNull();
    expect(await db.smembers(personKey.orgs(P.pid))).toEqual([]);
    expect(await db.get(personKey.lastOrg(P.pid))).toBeNull();
    expect(await db.get(accountKey.login(P.e))).toBeNull();
    expect(await getLogin(P.e)).toBeNull();
    expect(await lastSignIn(P.e)).toBeNull();
  }, 20_000);

  // R1's answer (switches off); with `MULTI_ORG` on the member's person and login outlive its last membership (rule
  // 2124, M3 half: tests/multi-org-m3-legacy.test.ts).
  describe("with the switches off (rollback floor, rule 3814)", () => {
    offPath();
    it("a legacy owner's deletion with one plain member is R1's: the owner and the member login both go", async () => {
      // No shadow memberships: the persons here hold nothing else, so the person and the login go with the last membership (multi-org M1).
      const O = await newUser("leg", { shadow: false });
      const m = await newMember(O, "member", "m", { shadow: false });
      await recordDevice(m.email, "session:h:legacy-member");
      await wipeAccount(acct(O));
      for (const e of [O.email, m.email]) {
        expect(await getLogin(e), e).toBeNull();
        expect(await db.get(accountKey.login(e)), e).toBeNull();
        expect(await db.get(personKey.person(storedPersonId(e))), e).toBeNull();
        expect(await lastSignIn(e), e).toBeNull();
      }
    }, 20_000);
  });

  it("the account's team log goes with it (its rows hold member addresses); another account's log is unchanged", async () => {
    const [O, other] = [await withPlan(await newUser("tlog", { shadow: false }), "pro"), await withPlan(await newUser("tlo", { shadow: false }), "pro")];
    // A member joins through an invite (`invited`, then `joined`), and one invite stays pending (`invited`).
    const inv = await createInvite(O, ownerActor(O), address("join"), "member", "en");
    if (!inv.ok) throw new Error(inv.error);
    const joined = await acceptRoute.POST(json("/api/team/accept", "POST", { token: inv.token, name: "Joiner", password: "abc12345", lang: "en" }, { "x-forwarded-for": `203.0.113.${1 + (Date.now() % 200)}` }));
    expect(joined.status).toBe(200);
    expect((await createInvite(O, ownerActor(O), address("wait"), "member", "en")).ok).toBe(true);
    expect((await createInvite(other, ownerActor(other), address("keep"), "member", "en")).ok).toBe(true);
    expect((await readTeamLog(aidOf(O))).map((r) => r.kind).sort()).toEqual(["invited", "invited", "joined"]);
    const kept = await db.lrange(accountKey.teamLog(aidOf(other)), 0, -1);
    expect(kept).toHaveLength(1);
    const needles = [`teamlog:${acct(other)}`];
    const before = snapshot(needles);
    await wipeAccount(acct(O));
    expect(await db.get(accountKey.user(acct(O)))).toBeNull();
    expect(await db.lrange(accountKey.teamLog(aidOf(O)), 0, -1)).toEqual([]);
    expect(await db.lrange(accountKey.teamLog(aidOf(other)), 0, -1)).toEqual(kept);
    expect(snapshot(needles)).toEqual(before);
  }, 30_000);
});

describe("rule 2130 (read-only part): the workspace view finds the account as a sign-in does and counts other workspaces", () => {
  const READS = new Set(["get", "lrange", "hgetall", "smembers", "sismember", "scardMany", "mget", "zcard", "zscore", "zrangeWithScores", "zrangeByScore", "ttl", "lockOwned"]);
  /** Every db method that is not a read, spied: the view must call none of them. */
  const writeSpies = () => {
    const writes: string[] = [];
    const store = db as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of Object.keys(store).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(store)))) {
      if (READS.has(name) || name === "constructor" || typeof store[name] !== "function") continue;
      const real = store[name].bind(store);
      vi.spyOn(store, name as never).mockImplementation(((...a: unknown[]) => { writes.push(`${name} ${String(a[0])}`); return real(...a); }) as never);
    }
    return writes;
  };

  it("a p_ member's address opens its account with openedFrom; alsoIn counts other workspaces and never names them; nothing is written", async () => {
    const { P, A, B, C, mB } = await threeAccounts();
    // While P owns A, its address opens A.
    const own = (await workspaceView(P.e))!;
    expect(own.owner.email).toBe(A.email);
    expect(own.openedFrom).toBeNull();
    // Without A, P is a member only (no legacy record): its address opens its oldest membership, B.
    await wipeAccount(acct(A));
    const writes = writeSpies();
    const v = (await workspaceView(P.e))!;
    expect(writes).toEqual([]);
    expect(v.owner.email).toBe(B.email);
    expect(v.openedFrom).toBe(P.e);
    const byEmail = Object.fromEntries(v.members.map((m) => [m.email, m]));
    expect(byEmail[P.e].alsoIn).toBe(1);
    expect(byEmail[mB.email].alsoIn).toBe(0);
    expect(typeof byEmail[P.e].alsoIn).toBe("number");
    const text = JSON.stringify(v);
    expect(text).not.toContain(acct(C));
    expect(text).not.toContain(C.email);
  }, 30_000);

  it("an address that signs in nowhere opens nothing", async () => {
    expect(await workspaceView(address("nobody"))).toBeNull();
  });
});

describe("rule 2126: createInvite refuses an account deleted while it waited for lock:team", () => {
  it("the account re-read under the lock is gone: forbidden, no invite, no index entry, no team log row", async () => {
    const A = await withPlan(await newUser("gone"), "pro");
    const team = accountKey.teamLock(acct(A));
    const real = db.lock.bind(db);
    // The deletion lands while the request waits for the team lock: here, right before it takes it.
    vi.spyOn(db, "lock").mockImplementation(async (k: string, ttl: number) => {
      if (k === team) await db.del(accountKey.user(acct(A)));
      return real(k, ttl);
    });
    const r = await createInvite(A, ownerActor(A), address("inv"), "member", "en");
    expect(r).toEqual({ ok: false, error: "forbidden" });
    vi.restoreAllMocks();
    expect(await db.smembers(accountKey.invites(acct(A)))).toEqual([]);
    expect(await readTeamLog(aidOf(A))).toEqual([]);
  });
});

describe("rule 2139: a team lock that cannot be had is a 409, not a 500", () => {
  it("an accept with lock:team held answers 409 busy with nothing joined; the retry joins", async () => {
    const A = await withPlan(await newUser("acc"), "pro");
    const inv = await createInvite(A, ownerActor(A), address("join"), "member", "en");
    if (!inv.ok) throw new Error(inv.error);
    const accept = () => acceptRoute.POST(json("/api/team/accept", "POST", { token: inv.token, name: "Joiner", password: "abc12345", lang: "en" }, { "x-forwarded-for": `203.0.113.${1 + (Date.now() % 200)}` }));
    const lock = accountKey.teamLock(acct(A));
    expect(await db.lock(lock, 10)).toBe(true);
    let r: Response;
    try { r = await accept(); } finally { await db.unlock(lock); }
    expect(r.status).toBe(409);
    expect(await getLogin(inv.invite.email)).toBeNull();
    expect(await db.smembers(accountKey.members(acct(A)))).toEqual([]);
    expect((await accept()).status).toBe(200);
    expect(await getLogin(inv.invite.email)).toMatchObject({ kind: "member", acct: acct(A) });
  }, 30_000);

  describe("billing callers of enforceSeats", () => {
    const ENV = {
      PAYMOB_SECRET_KEY: "sk_test_wipe_secret_for_unit_tests",
      PAYMOB_PUBLIC_KEY: "pk_test_wipe_public_for_unit_tests",
      PAYMOB_HMAC_SECRET: "wipe-hmac-secret-for-unit-tests",
      PAYMOB_INTEGRATION_ID_CARD: "111111",
      PAYMOB_INTEGRATION_ID_MOTO: "222222",
    };
    let intents: { orderId: number; ref: string; amount: number }[] = [];
    let nextOrder = 900000 + Math.floor(Math.random() * 90000);
    let txnSeq = 80000000 + Math.floor(Math.random() * 1000000);
    beforeEach(() => {
      for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
      vi.stubEnv("PAYMOB_LIVE", "");
      intents = [];
      vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
        const u = new URL(String(url));
        if (u.origin !== "https://ksa.paymob.com") throw new Error(`unexpected fetch ${u.origin}`);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (u.pathname === "/v1/intention/") {
          const orderId = ++nextOrder;
          intents.push({ orderId, ref: String(body.special_reference), amount: Number(body.amount) });
          return Response.json({ id: `pi_${orderId}`, client_secret: `csk_${orderId}`, intention_order_id: orderId, payment_keys: [{ key: `paykey_${orderId}` }] }, { status: 201 });
        }
        if (u.pathname === "/api/acceptance/void_refund/refund") return Response.json({}, { status: 200 });
        return Response.json({}, { status: 404 });
      });
      jar().clear();
    });
    const txnObj = (it: { orderId: number; ref: string; amount: number }) => ({
      id: ++txnSeq, pending: false, amount_cents: it.amount, success: true, is_auth: false, is_capture: false, is_standalone_payment: true,
      is_voided: false, is_refunded: false, is_3d_secure: true, integration_id: 111111, has_parent_transaction: false, owner: 1053928,
      created_at: "2026-10-19T10:00:00.000000", currency: "SAR", error_occured: false, is_live: false,
      source_data: { pan: "2346", type: "card", sub_type: "MasterCard" }, order: { id: it.orderId, merchant_order_id: it.ref },
    });
    const hook = (obj: Record<string, unknown>) =>
      webhook.POST(json(`/api/billing/paymob/webhook?hmac=${signHmac(hmacString(obj, TXN_HMAC_FIELDS), ENV.PAYMOB_HMAC_SECRET)}`, "POST", { type: "TRANSACTION", obj }, { "x-forwarded-for": `10.30.${txnSeq % 250}.${nextOrder % 250}` }));
    /** An owner with a member, a checkout for `plan`, and the intention Paymob saw. */
    const started = async (plan: Plan) => {
      const u = await newUser("pay");
      await saveUser({ ...(await getUser(acct(u)))!, phone: "+966500000123" });
      const m = await newMember(u);
      await signIn(u.email);
      expect((await checkout.POST(json("/api/billing/checkout", "POST", { kind: "plan", plan }))).status).toBe(200);
      return { u, m, it: intents.at(-1)! };
    };
    const disabled = async (owner: User, email: string) => (await getMembership(aidOf(owner), storedPersonId(email)))?.disabled;
    const held = async <T,>(owner: User, fn: () => Promise<T>) => {
      const lock = accountKey.teamLock(acct(owner));
      expect(await db.lock(lock, 10)).toBe(true);
      try { return await fn(); } finally { await db.unlock(lock); }
    };

    /** The founder console's audit rows (`admin:log`), `extra` flattened beside the row's own fields. */
    const auditRows = async () => (await db.lrange("admin:log", 0, 500)).map((x) => (typeof x === "string" ? JSON.parse(x) : x) as { action?: string; target?: string; actor?: string; what?: string; team?: unknown });

    it("a Paymob callback whose seat refit cannot take lock:team answers 503 busy with nothing paid; the retry pays once and fits the seats", async () => {
      const inv = await import("@/lib/invoice");
      const invoices = vi.spyOn(inv, "invoiceForPayment");
      const { u, m, it } = await started("starter");
      const obj = txnObj(it);
      const paidLines = async () => (await auditRows()).filter((x) => x.actor === "paymob" && x.what?.startsWith(`paymob_paid txn:${obj.id} `));
      const first = await held(u, () => hook(obj));
      expect(first.status).toBe(503);
      expect(await first.json()).toMatchObject({ result: "busy" });
      // The plan and its transaction id were saved before the refit; the seats were not fitted, and nothing of the
      // payment itself was written: no payment record, no invoice, no paid status, no done marker, no paid line.
      expect((await getUser(acct(u)))!.plan).toBe("starter");
      expect(await disabled(u, m.email)).toBeUndefined();
      expect(await db.hgetall<Payment>(`payments:${acct(u)}`)).toEqual({});
      expect(invoices).not.toHaveBeenCalled();
      expect((await db.get<{ status: string }>(`paymob:intent:${it.ref}`))?.status).not.toBe("paid");
      expect(await db.get(`paymob:done:${obj.id}`)).toBeNull();
      expect(await paidLines()).toEqual([]);
      const second = await hook(obj);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ result: "paid" });
      expect(await disabled(u, m.email)).toBe("seats");
      const p = paymentProvider()!;
      expect((await applyTransaction(p, p.parseTransaction(obj)!)).result).toBe("already");
      // Exactly one of each, and the plan applied once: its transaction id once, one month paid.
      expect(Object.keys(await db.hgetall<Payment>(`payments:${acct(u)}`))).toHaveLength(1);
      expect(invoices).toHaveBeenCalledTimes(1);
      expect((await db.get<{ status: string }>(`paymob:intent:${it.ref}`))?.status).toBe("paid");
      expect(await db.get(`paymob:done:${obj.id}`)).toBe("paid");
      expect(await paidLines()).toHaveLength(1);
      const billing = (await getUser(acct(u)))!.billing!;
      expect(billing.txns.filter((x) => x === String(obj.id))).toHaveLength(1);
      expect(billing.plan).toBe("starter");
    }, 30_000);

    it("a console refund whose seat refit cannot take lock:team answers busy; the retry fits the seats and still says the plan ended", async () => {
      const { u, m, it } = await started("pro");
      expect((await hook(txnObj(it))).status).toBe(200);
      expect(await disabled(u, m.email)).toBeUndefined();
      const [pay] = Object.values(await db.hgetall<Payment>(`payments:${acct(u)}`));
      const first = await held(u, () => refundPaymobPayment(acct(u), pay.id, "founder@test.example", "test refund"));
      expect(first).toEqual({ ok: false, error: "busy" });
      expect((await getUser(acct(u)))!.plan).toBe("trial");
      expect(await disabled(u, m.email)).toBeUndefined();
      // The trial seats three like Pro, so a one-seat limit set now shows whether the retry fits the seats at all (the
      // plan already ended: before multi-workspace M1 the retry returned without refitting).
      await saveUser({ ...(await getUser(acct(u)))!, seats: 1 });
      const second = await refundPaymobPayment(acct(u), pay.id, "founder@test.example", "test refund");
      // This refund ended the plan, on its first try: the retry says so.
      expect(second).toMatchObject({ ok: true, alreadyRefunded: true, planEnded: true });
      expect(await disabled(u, m.email)).toBe("seats");
      expect((await auditRows()).filter((x) => x.action === "refund_plan_ended" && x.target === acct(u))).toHaveLength(1);
    }, 30_000);

    const admin = () => vi.stubEnv("WAITLIST_ADMIN_KEY", "wipe-test-admin-key-0123456789");
    const planPost = (body: Record<string, unknown>) => planRoute.POST(json("/api/admin/plan", "POST", body, { "x-admin-key": "wipe-test-admin-key-0123456789" }));

    it("the console plan route takes lock:team first: held, it answers 409 busy with nothing written; the retry applies the change once", async () => {
      admin();
      const u = await withPlan(await newUser("cpl"), "pro");
      const m = await newMember(u);
      const credits = (await getUser(acct(u)))!.credits;
      const planRows = async () => (await auditRows()).filter((x) => x.action === "plan" && x.target === u.email);
      const r = await held(u, () => planPost({ email: u.email, plan: "starter", addCredits: 7 }));
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ ok: false, error: "busy" });
      // Nothing written: the plan, the credits and the audit log are as they were, and the team is untouched.
      expect((await getUser(acct(u)))!.plan).toBe("pro");
      expect((await getUser(acct(u)))!.credits).toBe(credits);
      expect(await planRows()).toEqual([]);
      expect(await disabled(u, m.email)).toBeUndefined();
      const retry = await planPost({ email: u.email, plan: "starter", addCredits: 7 });
      expect(retry.status).toBe(200);
      const body = (await retry.json()) as { ok: boolean; team?: { disabled: string[] } };
      expect(body.ok).toBe(true);
      expect(body.team?.disabled).toEqual([m.email]);
      expect((await getUser(acct(u)))!.plan).toBe("starter");
      expect(await disabled(u, m.email)).toBe("seats");
      const rows = await planRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].team).toMatchObject({ disabled: [m.email] });
    }, 30_000);

    it("a refit that cannot take a home member's lock:member after the change is saved answers 200 team busy, audited once, with neither the row nor the mirror paused; a seats-only POST refits both", async () => {
      admin();
      const u = await withPlan(await newUser("cpm"), "pro");
      const m = await newMember(u);
      const planRows = async () => (await auditRows()).filter((x) => x.action === "plan" && x.target === u.email);
      // The two records `writeMembership` keeps together: the forward row (what M1 reads) and the legacy mirror (what R1 reads).
      const row = async () => ((await db.get(accountKey.membership(aidOf(u), storedPersonId(m.email)))) as { disabled?: string } | null)?.disabled;
      const mirror = async () => ((await db.get(accountKey.member(m.email))) as { disabled?: string } | null)?.disabled;
      // No plan change: a plan change resets the month's credits, which would hide a doubled `addCredits`.
      const before = (await getUser(acct(u)))!.credits;
      const lock = accountKey.memberLock(m.email);
      expect(await db.lock(lock, 10)).toBe(true);
      let r: Response;
      try { r = await planPost({ email: u.email, seats: 1, addCredits: 7 }); } finally { await db.unlock(lock); }
      expect(r.status).toBe(200);
      const res = (await r.json()) as { ok: boolean; team?: unknown; user?: { plan: string } };
      expect(res).toMatchObject({ ok: true, team: "busy", user: { plan: "pro" } });
      // The change stands, once: the credits added exactly once, one audit row saying the team is busy.
      expect((await getUser(acct(u)))!.credits).toBe(before + 7);
      expect(await planRows()).toHaveLength(1);
      expect((await planRows())[0]).toMatchObject({ team: "busy" });
      // `writeMembership` writes the row and the mirror in one round under `lock:member`: the held lock wrote neither.
      expect(await row()).toBeUndefined();
      expect(await mirror()).toBeUndefined();
      expect(await disabled(u, m.email)).toBeUndefined();
      // The route has no request idempotency (a repeat of the whole POST would add the credits again), so the documented
      // follow-up is a seats-only POST: it refits the team (idempotent) and leaves the credits alone.
      const refit = await planPost({ email: u.email, seats: 1 });
      expect(refit.status).toBe(200);
      expect(await refit.json()).toMatchObject({ ok: true, team: { limit: 1 } });
      expect(await row()).toBe("seats");
      expect(await mirror()).toBe("seats");
      expect((await getUser(acct(u)))!.credits).toBe(before + 7);
      expect(await planRows()).toHaveLength(2);
    }, 30_000);

    it("the normal path is unchanged: a plan change fits the team; a credits-only change does not wait for lock:team", async () => {
      admin();
      const u = await withPlan(await newUser("cpn"), "pro");
      const m = await newMember(u);
      const credits = (await getUser(acct(u)))!.credits;
      // Credits alone move no seat: the request takes no team lock, so a held one does not refuse it.
      const add = await held(u, () => planPost({ email: u.email, addCredits: 5 }));
      expect(add.status).toBe(200);
      expect((await getUser(acct(u)))!.credits).toBe(credits + 5);
      expect(await disabled(u, m.email)).toBeUndefined();
      const down = await planPost({ email: u.email, plan: "starter" });
      expect(down.status).toBe(200);
      expect(await disabled(u, m.email)).toBe("seats");
      const up = await planPost({ email: u.email, plan: "pro" });
      expect(up.status).toBe(200);
      expect(((await up.json()) as { team?: { enabled: string[] } }).team?.enabled).toEqual([m.email]);
      expect(await disabled(u, m.email)).toBeUndefined();
    }, 30_000);
  });
});

describe("rule 2126: no await db.* inside a loop in the membership deletes", () => {
  /** The source of one top-level function of src/lib/team.ts, braces matched. */
  const fn = (name: string) => {
    const src = readFileSync("src/lib/team.ts", "utf8");
    const at = src.indexOf(`export async function ${name}(`);
    expect(at, name).toBeGreaterThan(-1);
    // Past the parameter list and its options type: the body starts at the first "{" after "): Promise".
    const i = src.indexOf("{", src.indexOf("): Promise", at));
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };
  /** Each `for (...)` / `while (...)` loop body (a block, or one statement). */
  const loops = (body: string) => {
    const out: string[] = [];
    for (const m of body.matchAll(/\b(for|while)\s*\(/g)) {
      let j = m.index! + m[0].length;
      for (let d = 1; d > 0 && j < body.length; j++) d += body[j] === "(" ? 1 : body[j] === ")" ? -1 : 0;
      while (/\s/.test(body[j])) j++;
      if (body[j] === "{") {
        let d = 0;
        let k = j;
        for (; k < body.length; k++) { if (body[k] === "{") d++; else if (body[k] === "}" && --d === 0) break; }
        out.push(body.slice(j, k + 1));
      } else out.push(body.slice(j, body.indexOf(";", j) + 1));
    }
    return out;
  };

  it("wipeMemberships and deleteMembership use pmap / Promise.all, never await db.* in a for or while loop", () => {
    for (const name of ["wipeMemberships", "deleteMembership"]) {
      const body = fn(name);
      expect(body, name).toMatch(/pmap\(|Promise\.all\(/);
      for (const loop of loops(body)) expect(loop, name).not.toMatch(/await\s+db\./);
    }
    expect(fn("wipeMemberships")).toContain("deleteMembership(aid, pid, { home: isHome(await getMember(pid), aid, pid), teamLocked: true })");
  });
});
