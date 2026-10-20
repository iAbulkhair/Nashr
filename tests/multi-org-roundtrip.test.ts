import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { json, newUser, settle, signIn } from "./helpers/session";
import { acct, currentUser, getUser, saveUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { saveTask, type Task } from "@/lib/brand";
import { saveBrands, scopeFor } from "@/lib/brands";
import { charge } from "@/lib/credits";
import { cardKey } from "@/lib/billing";
import { ownerOf } from "@/lib/membership";
import { withAccountTeamLock, writeMembership } from "@/lib/team";
import { saveConnection } from "@/lib/connectors/store";
import { composioUserId } from "@/lib/connectors/composio";
import { accountKey, storedAccountId, wsKey, type AccountId, type Scope } from "@/lib/keys";

import * as tasksRoute from "@/app/api/tasks/route";
import * as filesRoute from "@/app/api/files/route";
import * as brandRoute from "@/app/api/brand/route";
import * as brandsRoute from "@/app/api/brands/route";
import * as connectRoute from "@/app/api/connect/route";

/**
 * Rules 2122 and 2121 (multi-workspace membership, release M1 expand, docs/specs/2026-10-18-multi-org.md section 8,
 * item 6, and section 10).
 *
 * 2122: one person in three accounts (owner of A, admin of B and C) writes a brand, a file and a task in each, each
 * through a session whose active account is that one. Every read in each account returns only that account's rows. A
 * credit charged in A through the real charge path (`charge(acct(u), cost, {scope: sc(u), agent})`, as the routes call
 * it) moves A's balance and A's agent counter only: B's and C's credits, holds (`onboardPaid`, `paidOnce`), `billing`,
 * `plan`, agent counters and saved card (`paymob:card:`) are byte-equal before and after.
 *
 * 2121: connections stay per brand scope and `composioUserId` is unchanged for existing accounts. The fixture values were
 * computed from the code at the base of release M1 (3e0d19b6, src/lib/connectors/composio.ts: HMAC-SHA256 of
 * "composio:user:v1:" + scope under `CONNECT_SECRET`, base64url, first 32 characters) with the test secret below.
 */

const TEST_CONNECT_SECRET = "fixture-connect-secret-2121";

afterEach(() => {
  vi.unstubAllEnvs();
});

type Ws = { name: "A" | "B" | "C"; u: User; aid: AccountId };
let person: User;
let A: Ws, B: Ws, C: Ws;
/** B's and C's money right after the setup wrote it, before any other write touched them (see beforeAll). */
let moneyAtSetup: string[];

const task = (id: string, title: string): Task => ({ id, type: "social", channel: "instagram", title, body: title, status: "pending", createdAt: new Date().toISOString(), lang: "ar" });
const ws = (name: Ws["name"], u: User): Ws => ({ name, u, aid: storedAccountId(acct(u)) });

/** Sign the person in with this account active, as sign-in or (from M2) the switch writes it. */
const into = (w: Ws) => signIn(person.email, { acct: w.aid });

/** The money state of an account, as stored bytes: the record's money fields and the saved card. */
async function money(w: Ws): Promise<string> {
  const [rec, card] = await Promise.all([db.get<Record<string, unknown>>(accountKey.user(w.aid)), db.get<unknown>(cardKey(w.aid))]);
  const r = rec ?? {};
  return JSON.stringify({ credits: r.credits, onboardPaid: r.onboardPaid, paidOnce: r.paidOnce, billing: r.billing, plan: r.plan, agentSpend: r.agentSpend, topups: r.topups, card });
}

beforeAll(async () => {
  person = await newUser("rt-a", { shadow: false });
  A = ws("A", person);
  B = ws("B", await newUser("rt-b", { shadow: false }));
  C = ws("C", await newUser("rt-c", { shadow: false }));
  const pid = ownerOf(person);
  const at = new Date().toISOString();
  // B and C hold money state worth protecting: a paid plan with billing, holds, an agent counter and a saved card.
  const month = new Date().toISOString().slice(0, 7);
  await Promise.all(
    [B, C].map(async (w) => {
      const rec = (await getUser(w.aid))!;
      const hold = { scope: w.aid, agent: "noor" as const, month, credits: 7, at };
      Object.assign(rec, {
        plan: "business",
        credits: 4321,
        onboardPaid: { [w.aid]: hold },
        paidOnce: { [`claim-${w.name}`]: hold },
        billing: { provider: "paymob", plan: "business", status: "active", paidThrough: "2026-11-19", anchor: 19, autoRenew: true, failures: 0, card: { brand: "visa", last4: "4242" }, txns: [`txn-${w.name}`] },
      });
      await saveUser(rec);
      await db.set(cardKey(w.aid), { token: `tok_${randomBytes(8).toString("hex")}`, last4: "4242", brand: "visa", expMonth: "01", expYear: "38", savedAt: at, orderId: 1 });
    }),
  );
  // The money snapshot comes here: right after the money state is written and before every other write that touches B
  // or C (the memberships, the brands, and the round trip's brand, file and task writes in each account). Before the
  // money state there is nothing to protect, so this is the earliest point the snapshot means anything. Test 3 compares
  // it at its start (so the setup's own non-money rows and the writes of tests 1 and 2 moved no money) and again after
  // the charge in A.
  moneyAtSetup = await Promise.all([money(B), money(C)]);
  for (const w of [B, C]) {
    await withAccountTeamLock(w.aid, () => writeMembership(w.aid, pid, { aid: w.aid, pid, role: "admin", acceptedAt: at, invitedBy: w.u.email }, { home: false, teamLocked: true }));
  }
  // A second brand in each account, so a scope with `#` is in play too.
  await Promise.all([A, B, C].map((w) => saveBrands(w.aid, [{ id: "default", name: `RT-${w.name}`, createdAt: at, status: "active" }, { id: `b${w.name.toLowerCase()}2`, name: `RT-${w.name} second`, createdAt: at, status: "active" }])));
});

describe("rule 2122: a person in three accounts, a round trip", () => {
  it("writes in each account land in that account's scope only", async () => {
    for (const w of [A, B, C]) {
      await into(w);
      const u = (await currentUser())!;
      expect(acct(u)).toBe(w.aid);
      expect(u.actor?.role).toBe(w === A ? "owner" : "admin");
      const brandRes = await brandRoute.PUT(json("/api/brand", "PUT", { name: `RT-${w.name} brand`, industry: "i", products: "p", audience: "a", scope: A.aid, acct: A.aid }));
      expect(brandRes.status).toBe(200);
      const fileRes = await filesRoute.PUT(json("/api/files", "PUT", { name: "roundtrip.md", content: `RT-${w.name} file`, scope: A.aid }));
      expect(fileRes.status).toBe(200);
      await saveTask(sc(u), task(randomBytes(8).toString("hex"), `RT-${w.name} task`), true);
      await settle();
    }
  });

  it("every read in each account returns only that account's rows", async () => {
    for (const w of [A, B, C]) {
      await into(w);
      const others = [A, B, C].filter((x) => x !== w).map((x) => `RT-${x.name}`);
      const brand = (await (await brandRoute.GET(json("/api/brand", "GET"))).json()) as { brand: { name: string } };
      expect(brand.brand.name).toBe(`RT-${w.name} brand`);
      const file = (await (await filesRoute.GET(json("/api/files?name=roundtrip.md", "GET"))).json()) as { file: { content: string } };
      expect(file.file.content).toBe(`RT-${w.name} file`);
      const tasks = (await (await tasksRoute.GET(json("/api/tasks", "GET"))).json()) as { tasks: Task[] };
      expect(tasks.tasks.map((t) => t.title)).toEqual([`RT-${w.name} task`]);
      const brands = (await (await brandsRoute.GET()).json()) as { brands: { name: string }[] };
      expect(brands.brands.map((b) => b.name).sort()).toEqual([`RT-${w.name}`, `RT-${w.name} second`]);
      const all = JSON.stringify([brand, file, tasks, brands]);
      for (const o of others) expect(all).not.toContain(`${o} `);
    }
  });

  it("a credit charged in A moves A only; B's and C's money is byte-equal before and after", async () => {
    // Everything since the setup (memberships, brands, the writes of test 1) left B's and C's money as written.
    const before = await Promise.all([money(B), money(C)]);
    expect(before).toEqual(moneyAtSetup);
    const aBefore = (await getUser(A.aid))!;
    await into(A);
    const u = (await currentUser())!;
    // The real charge path, as a route calls it: the account from the session, the scope from sc(u).
    const r = await charge(acct(u), 1, { scope: sc(u), agent: "noor" });
    expect(r.ok).toBe(true);
    const aAfter = (await getUser(A.aid))!;
    expect(aAfter.credits).toBe(aBefore.credits - 1);
    expect(aAfter.agentSpend?.by[sc(u)]?.noor).toBe(1);
    expect(await Promise.all([money(B), money(C)])).toEqual(moneyAtSetup);
    // The same from inside B: a charge there moves B, never A or C.
    const aMoney = await money(A);
    const cMoney = await money(C);
    await into(B);
    const ub = (await currentUser())!;
    expect(acct(ub)).toBe(B.aid);
    expect((await charge(acct(ub), 1, { scope: sc(ub), agent: "noor" })).ok).toBe(true);
    expect((await getUser(B.aid))!.credits).toBe(4320);
    expect(await money(A)).toBe(aMoney);
    expect(await money(C)).toBe(cMoney);
  });
});

describe("rule 2121: connections and composioUserId are per scope and unchanged for existing accounts", () => {
  it("composioUserId of a legacy account's scopes equals the value the code at the base of M1 computed", () => {
    vi.stubEnv("CONNECT_SECRET", TEST_CONNECT_SECRET);
    expect(composioUserId("r1-owner@test.example")).toBe("N-RuFk6dMgDspvfkXjPYNV_yjgShD6VL");
    expect(composioUserId("r1-owner@test.example#b2x9k3m1")).toBe("R4zXcxOvnB2hxsntEOmRb_FUGrLs9cSM");
  });

  it("a legacy owner's scopes are still its address and its address#brand, whichever person signs in", async () => {
    const legacy = await newUser("rt-legacy", { shadow: false, legacy: true });
    await signIn(legacy.email);
    const u = (await currentUser())!;
    expect(sc(u)).toBe(legacy.email);
    expect(scopeFor(acct(u), "b2x9k3m1")).toBe(`${legacy.email}#b2x9k3m1`);
    // The person's scopes in B and C are B's and C's own, never a person-shaped value.
    for (const w of [B, C]) {
      await into(w);
      expect(sc((await currentUser())!)).toBe(w.aid);
    }
  });

  it("conn:{scope}:{provider} is read with the active account's scope only", async () => {
    vi.stubEnv("CONNECT_SECRET", TEST_CONNECT_SECRET);
    const at = new Date().toISOString();
    await Promise.all([A, B, C].map((w) => saveConnection(w.aid, { provider: "telegram", data: { token: `tg-${w.name}` }, meta: { name: `RT-${w.name} channel` }, connectedAt: at })));
    for (const w of [A, B, C]) {
      await into(w);
      const keys: string[] = [];
      const spies = (["get", "smembers", "mget"] as const).map((m) => {
        const real = db[m].bind(db) as (...a: unknown[]) => Promise<unknown>;
        return vi.spyOn(db, m).mockImplementation(((...a: unknown[]) => {
          keys.push(...(Array.isArray(a[0]) ? (a[0] as string[]) : [String(a[0])]));
          return real(...a);
        }) as never);
      });
      let body: { connections: { meta?: { name?: string } }[] };
      try {
        body = (await (await connectRoute.GET()).json()) as typeof body;
      } finally {
        for (const s of spies) s.mockRestore();
      }
      expect(body.connections.map((c) => c.meta?.name)).toEqual([`RT-${w.name} channel`]);
      const connKeys = keys.filter((k) => k.startsWith("conn:") || k.startsWith("conns:"));
      expect(connKeys.length).toBeGreaterThan(0);
      expect(connKeys.filter((k) => k !== wsKey.conns(w.aid as unknown as Scope) && k !== wsKey.conn(w.aid as unknown as Scope, "telegram"))).toEqual([]);
    }
  });
});
