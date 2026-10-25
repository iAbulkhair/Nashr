import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acct } from "@/lib/account-id";
import { randomBytes } from "crypto";
import { adminSignIn, jar, json, newUser, params, signIn } from "./helpers/session";
import { getUser, saveUser, type User } from "@/lib/auth";
import { monthKey } from "@/lib/credits";
import { db } from "@/lib/db";
import { ksaDay } from "@/lib/partner-rules";
import { TXN_HMAC_FIELDS, hmacString, signHmac } from "@/lib/paymob";
import { addDays, addMonths, type Billing } from "@/lib/billing-state";
import { cardKey, paymentIdFor, priceFor, renewPaymob } from "@/lib/billing";
import { wipeAccount } from "@/lib/account";
import { buildExport } from "@/lib/privacy-export";
import {
  FOUNDING_LOCK_MONTHS, FOUNDING_SEATS, LATER_LOCK_MONTHS, LOCKS_KEY, PRICE_LOCK_ACCOUNTS, REFUND_WINDOW_DAYS, SALE_START, SEATS_KEY,
  lockedBaseHalalas, newLock, refundProposal, saleStarted,
} from "@/lib/founding";
import * as checkout from "@/app/api/billing/checkout/route";
import * as webhook from "@/app/api/billing/paymob/webhook/route";
import * as adminPayments from "@/app/api/admin/payments/[email]/route";
import * as adminFounding from "@/app/api/admin/founding/route";
import * as publicSeats from "@/app/api/founding/seats/route";

/**
 * The founding offer and the price lock (rules 1700-1712, docs/system/tests/1700-founding-offer.md, spec
 * docs/specs/2026-10-13-founding-20-seats-price-lock.md). Paymob is faked at `fetch` as in tests/paymob.test.ts; the
 * clock (Date only) is moved into the sale, which starts on SALE_START.
 */

const ENV = {
  PAYMOB_SECRET_KEY: "sk_test_fake_secret_for_unit_tests",
  PAYMOB_PUBLIC_KEY: "pk_test_fake_public_for_unit_tests",
  PAYMOB_HMAC_SECRET: "fake-hmac-secret-for-unit-tests",
  PAYMOB_INTEGRATION_ID_CARD: "111111",
  PAYMOB_INTEGRATION_ID_MOTO: "222222",
};
const on = () => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); vi.stubEnv("WAITLIST_ADMIN_KEY", "founding-admin-key-0123456789abcdef"); };
const IN_SALE = new Date(`${addDays(SALE_START, 4)}T09:00:00Z`);
const BEFORE_SALE = new Date(`${addDays(SALE_START, -3)}T09:00:00Z`);

type Fake = { calls: { path: string; body: Record<string, unknown> }[]; pay: (orderId: number, ref: string) => Record<string, unknown> | null; nextOrder: number; intents: { orderId: number; ref: string; amount: number }[] };
let fake: Fake;
function installFake() {
  fake = { calls: [], pay: () => null, nextOrder: 800000 + Math.floor(Math.random() * 100000), intents: [] };
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== "https://ksa.paymob.com") throw new Error(`unexpected fetch ${u.origin}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    fake.calls.push({ path: u.pathname, body });
    if (u.pathname === "/v1/intention/") {
      const orderId = ++fake.nextOrder;
      fake.intents.push({ orderId, ref: String(body.special_reference), amount: Number(body.amount) });
      return Response.json({ id: `pi_test_${orderId}`, client_secret: `csk_test_${orderId}`, intention_order_id: orderId, payment_keys: [{ integration: (body.payment_methods as number[])[0], key: `paykey_${orderId}` }] }, { status: 201 });
    }
    if (u.pathname === "/api/acceptance/payments/pay") {
      const last = fake.intents.at(-1)!;
      const obj = fake.pay(last.orderId, last.ref);
      return obj ? Response.json(obj) : Response.json({ detail: "no" }, { status: 400 });
    }
    if (u.pathname === "/api/acceptance/void_refund/refund") return Response.json({ id: 1, success: true });
    return Response.json({}, { status: 404 });
  });
}

let txnSeq = 70000000 + Math.floor(Math.random() * 1000000);
function txnObj(o: { amount: number; orderId: number; ref: string; id?: number }) {
  return {
    id: o.id ?? ++txnSeq, pending: false, amount_cents: o.amount, success: true, is_auth: false, is_capture: false,
    is_standalone_payment: true, is_voided: false, is_refunded: false, is_3d_secure: true, integration_id: 111111,
    has_parent_transaction: false, owner: 1053928, created_at: "2026-11-05T10:00:00.000000", currency: "SAR",
    error_occured: false, is_live: false, source_data: { pan: "2346", type: "card", sub_type: "MasterCard" },
    order: { id: o.orderId, merchant_order_id: o.ref },
  };
}
let ipSeq = 0;
const hook = (obj: Record<string, unknown>) =>
  webhook.POST(json(`/api/billing/paymob/webhook?hmac=${signHmac(hmacString(obj, TXN_HMAC_FIELDS), ENV.PAYMOB_HMAC_SECRET)}`, "POST", { type: "TRANSACTION", obj }, { "x-forwarded-for": `10.8.${++ipSeq % 250}.${ipSeq % 250}` }));

async function owner(prefix = "fd"): Promise<User> {
  jar().clear();
  const u = await newUser(prefix);
  await saveUser({ ...(await getUser(acct(u)))!, phone: "+966500000170" });
  await signIn(u.email);
  return (await getUser(acct(u)))!;
}
/** Checkout as the signed-in owner, then Paymob's callback for it. */
async function payAndConfirm(body: Record<string, unknown>) {
  const res = await checkout.POST(json("/api/billing/checkout", "POST", body));
  expect(res.status).toBe(200);
  const it = fake.intents.at(-1)!;
  const obj = txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref });
  const cb = await hook(obj);
  return { it, obj, answer: (await cb.json()) as { result: string } };
}
const intentOf = (ref: string) => db.get<{ founding?: boolean; lockedBaseHalalas?: number }>(`paymob:intent:${ref}`);
const fill = (key: string, n: number) => Promise.all(Array.from({ length: n }, (_, i) => db.zadd(key, i, `filler-${i}-${randomBytes(3).toString("hex")}@test.example`)));
const logRows = async (email: string) => (await db.lrange("admin:log", 0, 500)).map(String).filter((l) => l.includes(email));

beforeEach(async () => {
  on(); installFake(); jar().clear();
  vi.useFakeTimers({ toFake: ["Date"], now: IN_SALE });
  await Promise.all([db.del(SEATS_KEY), db.del(LOCKS_KEY)]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("the seat counter is atomic (rule 1700)", () => {
  it("of 25 concurrent claims exactly 20 get a seat; a repeated claim keeps its place and is not counted twice", async () => {
    const emails = Array.from({ length: 25 }, (_, i) => `seat-${i}-${randomBytes(3).toString("hex")}@test.example`);
    const answers = await Promise.all(emails.map((e, i) => db.zaddCapped(SEATS_KEY, i, e, FOUNDING_SEATS)));
    expect(answers.filter((a) => typeof a === "number")).toHaveLength(20);
    expect(answers.filter((a) => a === "full")).toHaveLength(5);
    expect(await db.zcard(SEATS_KEY)).toBe(20);
    const first = emails[answers.findIndex((a) => typeof a === "number")];
    expect(await db.zaddCapped(SEATS_KEY, 999, first, FOUNDING_SEATS)).toBe("exists");
    expect(await db.zcard(SEATS_KEY)).toBe(20);
  });
});

describe("the decided numbers (rule 1701)", () => {
  it("20 seats, 12 months for a seat, 6 after, 100 accounts, 7 days, sale from 1 November 2026", () => {
    expect([FOUNDING_SEATS, FOUNDING_LOCK_MONTHS, LATER_LOCK_MONTHS, PRICE_LOCK_ACCOUNTS, REFUND_WINDOW_DAYS, SALE_START]).toEqual([20, 12, 6, 100, 7, "2026-11-01"]);
    expect(saleStarted("2026-10-31")).toBe(false);
    expect(saleStarted("2026-11-01")).toBe(true);
  });
});

describe("the checkout asks, the server decides (rule 1702)", () => {
  it("a founding intent only while the sale runs, a seat is free and the account never paid online", async () => {
    await owner();
    const r1 = await checkout.POST(json("/api/billing/checkout", "POST", { kind: "plan", plan: "starter", founding: true }));
    expect(r1.status).toBe(200);
    expect((await intentOf(fake.intents.at(-1)!.ref))!.founding).toBe(true);
    // Not asked: an ordinary intent.
    await checkout.POST(json("/api/billing/checkout", "POST", { kind: "plan", plan: "starter" }));
    expect((await intentOf(fake.intents.at(-1)!.ref))!.founding).toBeUndefined();
    // Seats gone: asked, but refused quietly.
    await fill(SEATS_KEY, FOUNDING_SEATS);
    await checkout.POST(json("/api/billing/checkout", "POST", { kind: "plan", plan: "starter", founding: true }));
    expect((await intentOf(fake.intents.at(-1)!.ref))!.founding).toBeUndefined();
  });
  it("before the sale starts, or for an account that already pays online, the flag is never set", async () => {
    vi.setSystemTime(BEFORE_SALE);
    await owner();
    await checkout.POST(json("/api/billing/checkout", "POST", { kind: "plan", plan: "starter", founding: true }));
    expect((await intentOf(fake.intents.at(-1)!.ref))!.founding).toBeUndefined();
    vi.setSystemTime(IN_SALE);
    const u = await owner();
    const billing: Billing = { provider: "paymob", plan: "starter", status: "active", paidThrough: addDays(ksaDay(), 10), anchor: 1, autoRenew: false, failures: 0, txns: [] };
    await saveUser({ ...(await getUser(acct(u)))!, billing });
    await checkout.POST(json("/api/billing/checkout", "POST", { kind: "plan", plan: "pro", founding: true }));
    expect((await intentOf(fake.intents.at(-1)!.ref))!.founding).toBeUndefined();
  });
});

describe("a paid founding first month takes the seat and a 12-month lock (rule 1703)", () => {
  it("the seat and the lock at the list price are set on payment, logged, and a replayed callback takes nothing more", async () => {
    const u = await owner();
    const { obj, it, answer } = await payAndConfirm({ kind: "plan", plan: "pro", founding: true });
    expect(answer.result).toBe("paid");
    const after = (await getUser(acct(u)))!;
    const day = ksaDay();
    expect(after.founding).toMatchObject({ by: "paymob", paymentId: paymentIdFor(obj.id) });
    expect(after.priceLock).toMatchObject({ plan: "pro", baseHalalas: 49900, from: day, until: addMonths(day, 12), months: 12, founding: true, paidHalalas: it.amount });
    expect(await db.zcard(SEATS_KEY)).toBe(1);
    expect(await db.zcard(LOCKS_KEY)).toBe(1);
    expect((await logRows(acct(u))).some((l) => l.includes("seat:claimed") && l.includes("price_lock_months:12"))).toBe(true);
    await hook(obj);
    expect(await db.zcard(SEATS_KEY)).toBe(1);
    expect((await getUser(acct(u)))!.founding!.at).toBe(after.founding!.at);
  });
  it("before the sale starts a first payment takes neither a seat nor a lock", async () => {
    vi.setSystemTime(BEFORE_SALE);
    const u = await owner();
    await payAndConfirm({ kind: "plan", plan: "starter", founding: true });
    const after = (await getUser(acct(u)))!;
    expect(after.founding).toBeUndefined();
    expect(after.priceLock).toBeUndefined();
  });
});

describe("the last seat (rule 1704)", () => {
  it("a founding payment that finds no seat left is an ordinary subscriber with the 6-month lock, and the log says so", async () => {
    const u = await owner();
    const res = await checkout.POST(json("/api/billing/checkout", "POST", { kind: "plan", plan: "starter", founding: true }));
    expect(res.status).toBe(200);
    // Someone else took the last seat between the checkout and the payment.
    await fill(SEATS_KEY, FOUNDING_SEATS);
    const it = fake.intents.at(-1)!;
    await hook(txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref }));
    const after = (await getUser(acct(u)))!;
    expect(after.plan).toBe("starter");
    expect(after.founding).toBeUndefined();
    expect(after.priceLock).toMatchObject({ months: 6, founding: false });
    expect(await db.zcard(SEATS_KEY)).toBe(FOUNDING_SEATS);
    expect((await logRows(acct(u))).some((l) => l.includes("seat:full"))).toBe(true);
  });
});

describe("the first 100 paying accounts (rule 1705)", () => {
  it("an ordinary first payment gets 6 months; once 100 places are taken it gets none; a founding seat is never refused its lock", async () => {
    const a = await owner();
    await payAndConfirm({ kind: "plan", plan: "starter" });
    expect((await getUser(acct(a)))!.priceLock).toMatchObject({ months: LATER_LOCK_MONTHS, until: addMonths(ksaDay(), 6) });
    await fill(LOCKS_KEY, PRICE_LOCK_ACCOUNTS);
    const b = await owner();
    await payAndConfirm({ kind: "plan", plan: "starter" });
    expect((await getUser(acct(b)))!.priceLock).toBeUndefined();
    const c = await owner();
    await payAndConfirm({ kind: "plan", plan: "business", founding: true });
    expect((await getUser(acct(c)))!.priceLock).toMatchObject({ months: 12, founding: true, baseHalalas: 99900 });
  });
});

describe("the renewal charges the locked price (rule 1706)", () => {
  async function lockedSubscriber(lock: { baseHalalas: number; from: string }, paidThrough: string): Promise<User> {
    const u = await owner("fdren");
    const billing: Billing = { provider: "paymob", plan: "starter", status: "active", paidThrough, anchor: Number(paidThrough.slice(8, 10)), autoRenew: true, failures: 0, txns: [], card: { brand: "MasterCard", last4: "2346" } };
    const priceLock = { ...newLock({ plan: "starter", from: lock.from, founding: true, by: "test" }), baseHalalas: lock.baseHalalas };
    await saveUser({ ...(await getUser(acct(u)))!, plan: "starter", renewedAt: monthKey(), billing, priceLock });
    await db.set(cardKey(acct(u)), { token: "tok_" + randomBytes(16).toString("hex"), last4: "2346", brand: "MasterCard", expMonth: "01", expYear: "38", savedAt: new Date().toISOString(), orderId: 1 });
    return (await getUser(acct(u)))!;
  }
  const charged = () => Number(fake.calls.find((c) => c.path === "/v1/intention/")!.body.amount);

  it("inside the lock the stored price is charged even when the list price is higher; the callback accepts it", async () => {
    // A lock taken when Starter cost 250 SAR (a later list price of 299 must not reach it).
    const today = ksaDay();
    const u = await lockedSubscriber({ baseHalalas: 25000, from: addMonths(today, -1) }, today);
    fake.calls = [];
    fake.pay = (orderId, ref) => txnObj({ amount: 28750, orderId, ref });
    expect(await renewPaymob(acct(u))).toBe("paymob_renewed");
    expect(charged()).toBe(28750);
    expect((await getUser(acct(u)))!.billing).toMatchObject({ status: "active" });
    expect((await getUser(acct(u)))!.billing!.paidThrough > today).toBe(true);
    expect((await intentOf(fake.intents.at(-1)!.ref))!.lockedBaseHalalas).toBe(25000);
  });
  it("month 12 after the first payment is charged at the current price", async () => {
    const today = ksaDay();
    const u = await lockedSubscriber({ baseHalalas: 25000, from: addMonths(today, -12) }, today);
    fake.calls = [];
    fake.pay = (orderId, ref) => txnObj({ amount: 34385, orderId, ref });
    expect(await renewPaymob(acct(u))).toBe("paymob_renewed");
    expect(charged()).toBe(34385);
  });
  it("a lock on another plan, an ended lock, a bad lock, or a lock above the list price never changes the wrong charge", () => {
    const today = ksaDay();
    const l = { priceLock: { ...newLock({ plan: "pro", from: today, founding: true, by: "t" }), baseHalalas: 30000 } };
    expect(lockedBaseHalalas(l, "starter", addMonths(today, 1))).toBeNull();
    expect(lockedBaseHalalas(l, "pro", addMonths(today, 1))).toBe(30000);
    expect(lockedBaseHalalas({ priceLock: { ...l.priceLock, endedAt: new Date().toISOString() } }, "pro", addMonths(today, 1))).toBeNull();
    expect(lockedBaseHalalas({ priceLock: { ...l.priceLock, baseHalalas: 80000 } }, "pro", addMonths(today, 1))).toBe(49900);
    expect(lockedBaseHalalas({ priceLock: { ...l.priceLock, baseHalalas: 0 } }, "pro", addMonths(today, 1))).toBeNull();
    expect(priceFor("renewal", { plan: "pro" }, false, 30000)).toEqual({ baseHalalas: 30000, vatHalalas: 4500, amountCents: 34500 });
    expect(priceFor("renewal", { plan: "pro" }, false, 90000)!.baseHalalas).toBe(49900);
    // A lock never touches a first month.
    expect(priceFor("plan", { plan: "pro" }, false, 30000)!.baseHalalas).toBe(49900);
  });
  it("an account without a lock renews exactly as before (old shape)", async () => {
    const today = ksaDay();
    const u = await lockedSubscriber({ baseHalalas: 25000, from: today }, today);
    const plain = { ...(await getUser(acct(u)))! };
    delete plain.priceLock;
    await saveUser(plain);
    fake.calls = [];
    fake.pay = (orderId, ref) => txnObj({ amount: 34385, orderId, ref });
    expect(await renewPaymob(acct(u))).toBe("paymob_renewed");
    expect(charged()).toBe(34385);
    expect((await intentOf(fake.intents.at(-1)!.ref))!.lockedBaseHalalas).toBeUndefined();
  });
});

describe("the 7-day refund proposal (rule 1707)", () => {
  const base = { paidHalalas: 34385, baseHalalas: 29900, allowance: 300, paidOn: "2026-11-05" };
  it("nothing used is the full amount; credits used are deducted at the ex-VAT price per credit, rounded in the customer's favour", () => {
    expect(refundProposal({ ...base, monthlyLeft: 300, today: "2026-11-06" })).toMatchObject({ lastDay: "2026-11-12", inWindow: true, usedCredits: 0, amountHalalas: 34385 });
    // 30 of 300 credits used: 30 × 99.67 halalas = 2990 halalas deducted.
    expect(refundProposal({ ...base, monthlyLeft: 270, today: "2026-11-06" })).toMatchObject({ usedCredits: 30, amountHalalas: 31395 });
    expect(refundProposal({ ...base, monthlyLeft: 299, today: "2026-11-06" }).amountHalalas).toBe(34285);
  });
  it("day 7 after the payment is inside, day 8 is outside; never negative, never above what was paid", () => {
    expect(refundProposal({ ...base, monthlyLeft: 300, today: "2026-11-12" }).inWindow).toBe(true);
    expect(refundProposal({ ...base, monthlyLeft: 300, today: "2026-11-13" }).inWindow).toBe(false);
    expect(refundProposal({ ...base, monthlyLeft: -50, today: "2026-11-06" }).amountHalalas).toBeGreaterThanOrEqual(0);
    expect(refundProposal({ ...base, monthlyLeft: 900, today: "2026-11-06" }).amountHalalas).toBe(34385);
  });
});

describe("a full refund ends the seat and the lock (rule 1708)", () => {
  it("the console's refund ends the plan (rule 1300) and, with it, the seat and the lock; both places are freed", async () => {
    const u = await owner();
    const { obj } = await payAndConfirm({ kind: "plan", plan: "starter", founding: true });
    expect(await db.zcard(SEATS_KEY)).toBe(1);
    jar().clear();
    await adminSignIn();
    const r = await adminPayments.POST(json(`/api/admin/payments/${encodeURIComponent(u.email)}`, "POST", { action: "refund", id: paymentIdFor(obj.id) }), params({ email: encodeURIComponent(u.email) }));
    expect(await r.json()).toMatchObject({ ok: true, planEnded: true });
    const after = (await getUser(acct(u)))!;
    expect(after.founding!.endedAt).toEqual(expect.any(String));
    expect(after.priceLock!.endedAt).toEqual(expect.any(String));
    expect(await db.zcard(SEATS_KEY)).toBe(0);
    expect(await db.zcard(LOCKS_KEY)).toBe(0);
    expect((await logRows(acct(u))).some((l) => l.includes("founding_ended"))).toBe(true);
    // Paying again later is an ordinary subscription: an ended seat or lock is never claimed again automatically.
    jar().clear();
    await signIn(u.email);
    await payAndConfirm({ kind: "plan", plan: "starter", founding: true });
    expect(await db.zcard(SEATS_KEY)).toBe(0);
  });
});

describe("the founder console (rules 1709, 1710)", () => {
  const get = () => adminFounding.GET(json("/api/admin/founding", "GET"));
  const post = (b: Record<string, unknown>) => adminFounding.POST(json("/api/admin/founding", "POST", b));
  it("founder only; the list shows counts, each account's seat, lock and refund proposal", async () => {
    const u = await owner();
    await payAndConfirm({ kind: "plan", plan: "starter", founding: true });
    expect((await get()).status).toBe(401);
    expect((await post({ action: "grant_seat", email: u.email, reason: "agreed" })).status).toBe(401);
    jar().clear();
    await adminSignIn();
    const j = await (await get()).json();
    expect(j).toMatchObject({ ok: true, paymentsOn: true, started: true, seats: { taken: 1, left: 19 }, locks: { taken: 1 } });
    expect(j.rows.find((r: { email: string }) => r.email === acct(u))).toMatchObject({ seat: { by: "paymob", endedAt: null }, lock: { plan: "starter", sar: 299, months: 12 }, refund: { inWindow: true, usedCredits: 0, amountHalalas: 34385 } });
  });
  it("grant and end by hand: a reason, a free seat, one audit row each; ending frees the place", async () => {
    const u = await owner();
    jar().clear();
    await adminSignIn();
    expect((await post({ action: "grant_seat", email: u.email })).status).toBe(400);
    expect((await post({ action: "nope", email: u.email, reason: "agreed" })).status).toBe(400);
    expect((await post({ action: "grant_seat", email: `nobody-${randomBytes(3).toString("hex")}@test.example`, reason: "agreed" })).status).toBe(404);
    expect((await post({ action: "grant_seat", email: u.email, reason: "paid by transfer" })).status).toBe(200);
    expect((await post({ action: "grant_seat", email: u.email, reason: "again" })).status).toBe(409);
    expect((await post({ action: "grant_lock", email: u.email, reason: "paid by transfer", plan: "gold" })).status).toBe(400);
    expect((await post({ action: "grant_lock", email: u.email, reason: "paid by transfer", plan: "pro", from: addDays(ksaDay(), 1) })).status).toBe(400);
    const g = await post({ action: "grant_lock", email: u.email, reason: "paid by transfer", plan: "pro", from: addDays(ksaDay(), -2) });
    expect(await g.json()).toMatchObject({ ok: true, seat: { endedAt: null }, lock: { plan: "pro", sar: 499, months: 12, from: addDays(ksaDay(), -2) } });
    expect([await db.zcard(SEATS_KEY), await db.zcard(LOCKS_KEY)]).toEqual([1, 1]);
    expect((await post({ action: "end_seat", email: u.email, reason: "left" })).status).toBe(200);
    expect((await post({ action: "end_lock", email: u.email, reason: "left" })).status).toBe(200);
    expect((await post({ action: "end_lock", email: u.email, reason: "left" })).status).toBe(409);
    expect([await db.zcard(SEATS_KEY), await db.zcard(LOCKS_KEY)]).toEqual([0, 0]);
    const actions = (await logRows(u.email)).map((l) => (JSON.parse(l) as { action?: string }).action ?? "").filter((a) => a.startsWith("founding_"));
    expect(actions.sort()).toEqual(["founding_end_lock", "founding_end_seat", "founding_grant_lock", "founding_grant_seat"]);
  });
  it("a hand grant cannot go past twenty seats", async () => {
    await fill(SEATS_KEY, FOUNDING_SEATS);
    const u = await owner();
    jar().clear();
    await adminSignIn();
    const r = await post({ action: "grant_seat", email: u.email, reason: "one more" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("seats_full");
    expect((await getUser(acct(u)))!.founding).toBeUndefined();
  });
});

describe("the public counter (rule 1711)", () => {
  const read = (ip = `10.7.${++ipSeq % 250}.${randomBytes(1)[0]}`) => publicSeats.GET(json("/api/founding/seats", "GET", undefined, { "x-forwarded-for": ip }));
  it("closed while payment is off, before the sale and at zero; open with the real count and no account detail", async () => {
    vi.unstubAllEnvs();
    expect(await (await read()).json()).toEqual({ ok: true, open: false });
    on();
    vi.setSystemTime(BEFORE_SALE);
    expect(await (await read()).json()).toEqual({ ok: true, open: false });
    vi.setSystemTime(IN_SALE);
    await db.zadd(SEATS_KEY, 1, "secret-founder@test.example");
    const raw = await (await read()).text();
    expect(JSON.parse(raw)).toEqual({ ok: true, open: true, left: 19, total: 20 });
    expect(raw).not.toContain("@");
    await fill(SEATS_KEY, FOUNDING_SEATS);
    expect(await (await read()).json()).toEqual({ ok: true, open: false });
  });
  it("is rate limited per address", async () => {
    const ip = `10.6.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    const answers: number[] = [];
    for (let i = 0; i < 61; i++) answers.push((await read(ip)).status);
    expect(answers.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(answers[60]).toBe(429);
  });
});

describe("leaving and the data download (rule 1712)", () => {
  it("the download shows the seat and the lock; deleting the account frees both places", async () => {
    const u = await owner();
    await payAndConfirm({ kind: "plan", plan: "starter", founding: true });
    const exp = await buildExport((await getUser(acct(u)))!);
    expect(exp.plan.founding).toMatchObject({ seat: { by: "paymob" }, lock: { plan: "starter", sar: 299, months: 12 } });
    await wipeAccount(acct(u));
    expect([await db.zcard(SEATS_KEY), await db.zcard(LOCKS_KEY)]).toEqual([0, 0]);
  });
});
