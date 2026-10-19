import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { json, jar, newMember, newUser, signIn, signOut } from "./helpers/session";
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
import { TXN_HMAC_FIELDS, hmacString, signHmac } from "@/lib/paymob";

/**
 * Multi-workspace M1 expand, Task 8 (docs/specs/2026-10-18-multi-org.md sections 9 and 15, plan reconciliation 7):
 * deleting an account removes its memberships through `wipeMemberships` and keeps every member's other accounts (rule
 * 2126, M1 half); the founder console's workspace view finds the account as a sign-in does and shows a member's other
 * workspaces as a count only (rule 2130's read-only part, rule 2079); a team lock timeout is a 409 "busy" wherever a
 * caller reaches `enforceSeats` or an accept (rule 2139). The single-membership member wipe is pinned by
 * tests/account-security-wipe.test.ts, which runs unchanged.
 */

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); signOut(); });

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
  await join(C, P.pid);
  await Promise.all([db.set(personKey.activeBrand(P.pid, aidOf(B)), "default"), db.set(personKey.activeBrand(P.pid, aidOf(C)), "default")]);
  // Someone else on each roster, so the other accounts have a team of their own to keep.
  const [mB, mC] = [await newMember(B), await newMember(C)];
  return { P, A: P.owned, B, C, mB, mC };
}
const resolveAs = async (email: string, account: User) => { await signIn(email, { acct: acct(account) }); return currentUser(); };

describe("rule 2126 (M1 half): deleting an account keeps its members' other accounts", () => {
  it("deleting a member-account (B) leaves A and C working and every key of A and C unchanged", async () => {
    const { P, A, B, C } = await threeAccounts();
    const before = snapshot([acct(A), acct(C)]);
    expect(Object.keys(before).some((k) => k.includes(`mbr:${acct(C)}:${P.pid}`))).toBe(true);
    await wipeAccount(acct(B));
    expect(await db.get(accountKey.user(acct(B)))).toBeNull();
    expect(snapshot([acct(A), acct(C)])).toEqual(before);
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
    const { P, A, B, C } = await threeAccounts();
    const before = snapshot([acct(B), acct(C)]);
    await wipeAccount(acct(A));
    expect(await db.get(accountKey.user(acct(A)))).toBeNull();
    expect(snapshot([acct(B), acct(C)])).toEqual(before);
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

  it("a legacy owner's deletion with one plain member is R1's: the owner and the member login both go", async () => {
    const O = await newUser("leg");
    const m = await newMember(O);
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

describe("Task 6 review fold-in: createInvite refuses an account deleted while it waited for lock:team", () => {
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
      await saveUser({ ...(await getUser(u.email))!, phone: "+966500000123" });
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

    it("a Paymob callback whose seat refit cannot take lock:team answers 409 busy; the retry pays and fits the seats", async () => {
      const { u, m, it } = await started("starter");
      const obj = txnObj(it);
      const first = await held(u, () => hook(obj));
      expect(first.status).toBe(409);
      expect(await first.json()).toMatchObject({ result: "busy" });
      // The plan and its transaction id were saved before the refit; the seats were not fitted yet.
      expect((await getUser(u.email))!.plan).toBe("starter");
      expect(await disabled(u, m.email)).toBeUndefined();
      const second = await hook(obj);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ result: "paid" });
      expect(await disabled(u, m.email)).toBe("seats");
      const p = paymentProvider()!;
      expect((await applyTransaction(p, p.parseTransaction(obj)!)).result).toBe("already");
    }, 30_000);

    it("a console refund whose seat refit cannot take lock:team answers busy; the retry fits the seats", async () => {
      const { u, m, it } = await started("pro");
      expect((await hook(txnObj(it))).status).toBe(200);
      expect(await disabled(u, m.email)).toBeUndefined();
      const [pay] = Object.values(await db.hgetall<Payment>(`payments:${u.email}`));
      const first = await held(u, () => refundPaymobPayment(u.email, pay.id, "founder@test.example", "test refund"));
      expect(first).toEqual({ ok: false, error: "busy" });
      expect((await getUser(u.email))!.plan).toBe("trial");
      expect(await disabled(u, m.email)).toBeUndefined();
      // The trial seats three like Pro, so a one-seat limit set now shows whether the retry fits the seats at all (the
      // plan already ended: before Task 8 the retry returned without refitting).
      await saveUser({ ...(await getUser(u.email))!, seats: 1 });
      const second = await refundPaymobPayment(u.email, pay.id, "founder@test.example", "test refund");
      expect(second).toMatchObject({ ok: true, alreadyRefunded: true });
      expect(await disabled(u, m.email)).toBe("seats");
    }, 30_000);

    it("the console plan route with lock:team held saves and logs the plan and answers 409 busy", async () => {
      vi.stubEnv("WAITLIST_ADMIN_KEY", "wipe-test-admin-key-0123456789");
      const u = await withPlan(await newUser("cpl"), "pro");
      const m = await newMember(u);
      const r = await held(u, () => planRoute.POST(json("/api/admin/plan", "POST", { email: u.email, plan: "starter" }, { "x-admin-key": "wipe-test-admin-key-0123456789" })));
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ ok: false, error: "busy" });
      expect((await getUser(u.email))!.plan).toBe("starter");
      // The audit row keeps `extra` beside its own fields (as `openedFrom` in the workspace view's row).
      const rows = (await db.lrange("admin:log", 0, 200)).map((x) => (typeof x === "string" ? JSON.parse(x) : x) as { action?: string; target?: string; team?: unknown });
      expect(rows.find((x) => x.action === "plan" && x.target === u.email)).toMatchObject({ team: "busy" });
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
