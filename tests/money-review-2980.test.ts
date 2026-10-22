import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { adminSignIn, jar, json, newOpaqueUser, newUser, params, signIn } from "./helpers/session";
import { acct, getUser, saveUser, trialOver, type User } from "@/lib/auth";
import { monthKey, withUserLock } from "@/lib/credits";
import { db } from "@/lib/db";
import { ksaDay } from "@/lib/partner-rules";
import { allowanceOf } from "@/lib/pricing";
import { TXN_HMAC_FIELDS, hmacString, signHmac } from "@/lib/paymob";
import { addDays, addMonths, type Billing } from "@/lib/billing-state";
import { cardKey, paymentIdFor, renewPaymob } from "@/lib/billing";
import { LOCKS_KEY, SEATS_KEY, applyGrant, claimOnPayment, freePlaces, placeMembers } from "@/lib/founding";
import { wipeAccount } from "@/lib/account";
import { voidTopup } from "@/lib/credits";
import { lotsOf } from "@/lib/topups";
import * as checkout from "@/app/api/billing/checkout/route";
import * as webhook from "@/app/api/billing/paymob/webhook/route";
import * as adminPayments from "@/app/api/admin/payments/[email]/route";

/**
 * The 2026-10-22 money review (rules 2980-2984, docs/system/tests/2980-money-review.md): a pack's refund never ends a
 * plan; the first online subscription refills the month; founding places by account id; a renewal applies only to its
 * own plan; a charge with no answer keeps its pending guard. Paymob is faked at `fetch` exactly as tests/paymob.test.ts.
 */

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app/billing",
  useSearchParams: () => new URLSearchParams(),
}));

const ENV = {
  PAYMOB_SECRET_KEY: "sk_test_fake_secret_for_unit_tests",
  PAYMOB_PUBLIC_KEY: "pk_test_fake_public_for_unit_tests",
  PAYMOB_HMAC_SECRET: "fake-hmac-secret-for-unit-tests",
  PAYMOB_INTEGRATION_ID_CARD: "111111",
  PAYMOB_INTEGRATION_ID_MOTO: "222222",
};
const ADMIN_KEY = "paymob-admin-key-0123456789abcdef";
const on = () => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); vi.stubEnv("WAITLIST_ADMIN_KEY", ADMIN_KEY); };

type Fake = { calls: string[]; pay: (orderId: number, ref: string) => Record<string, unknown> | null; nextOrder: number; intents: { orderId: number; ref: string; amount: number }[] };
let fake: Fake;
function installFake() {
  fake = { calls: [], pay: () => null, nextOrder: 800000 + Math.floor(Math.random() * 100000), intents: [] };
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== "https://ksa.paymob.com") throw new Error(`unexpected fetch ${u.origin}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    fake.calls.push(u.pathname);
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
    if (u.pathname === "/api/acceptance/void_refund/refund") return Response.json({ id: 1, success: true }, { status: 200 });
    return Response.json({}, { status: 404 });
  });
}

beforeEach(() => { on(); installFake(); jar().clear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const today = () => ksaDay();
let txnSeq = 70000000 + Math.floor(Math.random() * 1000000);
function txnObj(o: { amount: number; orderId: number; ref: string; success?: boolean }) {
  return {
    id: ++txnSeq, pending: false, amount_cents: o.amount, success: o.success ?? true, is_auth: false, is_capture: false,
    is_standalone_payment: true, is_voided: false, is_refunded: false, is_3d_secure: true, integration_id: 111111,
    has_parent_transaction: false, owner: 1053928, created_at: "2026-10-22T10:00:00.000000", currency: "SAR",
    error_occured: false, is_live: false, source_data: { pan: "2346", type: "card", sub_type: "MasterCard" },
    order: { id: o.orderId, merchant_order_id: o.ref },
  };
}
let ipSeq = 0;
const hook = (obj: Record<string, unknown>) =>
  webhook.POST(json(`/api/billing/paymob/webhook?hmac=${signHmac(hmacString(obj, TXN_HMAC_FIELDS), ENV.PAYMOB_HMAC_SECRET)}`, "POST", { type: "TRANSACTION", obj }, { "x-forwarded-for": `10.8.${++ipSeq % 250}.${ipSeq % 250}` }));
const pay = (body: Record<string, unknown>) => checkout.POST(json("/api/billing/checkout", "POST", body));
async function payAndConfirm(body: Record<string, unknown>) {
  const res = await pay(body);
  expect(res.status).toBe(200);
  const it = fake.intents.at(-1)!;
  const obj = txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref });
  const answer = (await (await hook(obj)).json()) as { result: string };
  return { it, obj, answer };
}
async function owner(prefix = "mr"): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...(await getUser(u.email))!, phone: "+966500000123" });
  await signIn(u.email);
  return (await getUser(u.email))!;
}
async function subscribed(b: Partial<Billing> = {}): Promise<User> {
  const u = await owner("mrsub");
  const billing: Billing = { provider: "paymob", plan: "starter", status: "active", paidThrough: today(), anchor: Number(today().slice(8, 10)), autoRenew: true, failures: 0, txns: [], card: { brand: "MasterCard", last4: "2346" }, ...b };
  await saveUser({ ...(await getUser(u.email))!, plan: "starter", renewedAt: monthKey(), billing });
  await db.set(cardKey(u.email), { token: "tok_" + randomBytes(16).toString("hex"), last4: "2346", brand: "MasterCard", expMonth: "01", expYear: "38", savedAt: new Date().toISOString(), orderId: 1 });
  return (await getUser(u.email))!;
}
const refund = (email: string, b: Record<string, unknown>) => adminPayments.POST(json(`/api/admin/payments/${encodeURIComponent(email)}`, "POST", { action: "refund", ...b }), params({ email: encodeURIComponent(email) }));

describe("a pack's refund never ends a plan (rule 2980)", () => {
  it("a retried pack refund, after the first run took the pack away, answers planEnded false and keeps the plan and its card", async () => {
    const u = await owner();
    await payAndConfirm({ kind: "plan", plan: "starter" });
    const { obj } = await payAndConfirm({ kind: "topup", credits: 300 });
    await db.set(cardKey(u.email), { token: "tok_keep", last4: "2346", brand: "MasterCard", expMonth: "01", expYear: "38", savedAt: new Date().toISOString(), orderId: 1 });
    jar().clear();
    await adminSignIn();
    const id = paymentIdFor(obj.id);
    expect(await (await refund(u.email, { id })).json()).toMatchObject({ ok: true, planEnded: false });
    // The retry: Paymob already refunded, the pack is gone, so `voidPaidTopup` answers topup_not_found.
    const again = await refund(u.email, { id });
    expect(await again.json()).toMatchObject({ ok: true, alreadyRefunded: true, planEnded: false, payment: { id, voidedAt: expect.any(String) } });
    const after = (await getUser(u.email))!;
    expect(after.plan).toBe("starter");
    expect(after.billing).toMatchObject({ status: "active", plan: "starter" });
    expect(trialOver(after)).toBe(false);
    expect(await db.get(cardKey(u.email))).toMatchObject({ token: "tok_keep" });
    expect(fake.calls.filter((c) => c === "/api/acceptance/void_refund/refund")).toHaveLength(1);
  });

  it("a pack that ran out or was voided before its refund still leaves the plan alone and voids the payment", async () => {
    const u = await owner();
    await payAndConfirm({ kind: "plan", plan: "starter" });
    const { obj } = await payAndConfirm({ kind: "topup", credits: 300 });
    const lot = lotsOf((await getUser(u.email))!).find((l) => l.paymentId === paymentIdFor(obj.id))!;
    expect(lot).toBeTruthy();
    await voidTopup(u.email, lot.id);
    jar().clear();
    await adminSignIn();
    const r = await refund(u.email, { id: paymentIdFor(obj.id) });
    expect(await r.json()).toMatchObject({ ok: true, alreadyRefunded: false, planEnded: false, payment: { voidedAt: expect.any(String) } });
    const after = (await getUser(u.email))!;
    expect([after.plan, after.billing?.status]).toEqual(["starter", "active"]);
  });
});

describe("the first online subscription refills the month (rule 2981)", () => {
  it("paying online for the plan held by hand gives that plan's month of credits and renews from today", async () => {
    const u = await owner();
    await saveUser({ ...(await getUser(u.email))!, plan: "starter", credits: 7, renewedAt: monthKey(), renewedOn: addDays(today(), -25), handPlan: { paidThrough: addDays(today(), 5), by: "key", at: new Date().toISOString() } });
    const { answer } = await payAndConfirm({ kind: "plan", plan: "starter" });
    expect(answer.result).toBe("paid");
    const after = (await getUser(u.email))!;
    expect(after.handPlan).toBeUndefined();
    expect(after.credits).toBe(allowanceOf(after));
    expect(after.credits).toBeGreaterThan(7);
    expect(after.renewedOn).toBe(today());
    expect(after.billing).toMatchObject({ plan: "starter", paidThrough: addMonths(today(), 1), anchor: Number(today().slice(8, 10)) });
  });

  it("a plan set by hand with no paid-through day, paid online for the first time, is refilled too", async () => {
    const u = await owner();
    await saveUser({ ...(await getUser(u.email))!, plan: "starter", credits: 3, renewedAt: monthKey(), renewedOn: addDays(today(), -3) });
    await payAndConfirm({ kind: "plan", plan: "starter" });
    const after = (await getUser(u.email))!;
    expect(after.credits).toBe(allowanceOf(after));
    expect(after.renewedOn).toBe(today());
  });

  it("the same plan paid again while a subscription runs still only adds a month, no second refill (rule 721 unchanged)", async () => {
    const u = await subscribed({ paidThrough: addDays(today(), 10), anchor: 5, autoRenew: false });
    await saveUser({ ...(await getUser(u.email))!, credits: 9, renewedOn: addDays(today(), -2) });
    await payAndConfirm({ kind: "plan", plan: "starter" });
    const after = (await getUser(u.email))!;
    expect(after.credits).toBe(9);
    expect(after.renewedOn).toBe(addDays(today(), -2));
    expect(after.billing).toMatchObject({ paidThrough: addMonths(addDays(today(), 10), 1, 5), anchor: 5 });
  });
});

describe("founding places by account id (rule 2982)", () => {
  it("a claim and a hand grant store the account id; freeing removes the id and an address row written before", async () => {
    const u = await newOpaqueUser("mrf");
    expect(acct(u)).not.toBe(u.email);
    const day = "2026-11-02";
    const user = { ...(await getUser(acct(u)))! };
    const claim = await claimOnPayment(user, { founding: true, plan: "starter", paidHalalas: 34385, paymentId: "pay_" + "a".repeat(24), day });
    expect(claim.seat).toBe("claimed");
    expect(await db.zscore(SEATS_KEY, acct(u))).not.toBeNull();
    expect(await db.zscore(LOCKS_KEY, acct(u))).not.toBeNull();
    expect(await db.zscore(SEATS_KEY, u.email)).toBeNull();
    // A row from before rule 2982, under the address.
    await db.zaddCapped(SEATS_KEY, Date.now(), u.email, Number.MAX_SAFE_INTEGER);
    expect(placeMembers(user)).toEqual([acct(u), u.email]);
    await freePlaces(user);
    for (const k of [SEATS_KEY, LOCKS_KEY]) for (const m of [acct(u), u.email]) expect(await db.zscore(k, m)).toBeNull();
  });

  it("the founder's grant uses the id, and deleting the account frees both the id and the address", async () => {
    const u = await newOpaqueUser("mrg");
    await withUserLock(acct(u), async (x) => {
      expect(await applyGrant(x, "grant_seat", {}, "founder")).toMatchObject({ ok: true });
      await saveUser(x);
    });
    expect(await db.zscore(SEATS_KEY, acct(u))).not.toBeNull();
    await db.zaddCapped(LOCKS_KEY, Date.now(), u.email, Number.MAX_SAFE_INTEGER);
    await wipeAccount(acct(u));
    for (const k of [SEATS_KEY, LOCKS_KEY]) for (const m of [acct(u), u.email]) expect(await db.zscore(k, m)).toBeNull();
  });
});

describe("a renewal applies only to the plan it was priced for (rule 2983)", () => {
  it("a late renewal callback for the old plan after an upgrade adds nothing to the new plan", async () => {
    const u = await subscribed({ paidThrough: today() });
    // The renewal is sent and Paymob has not answered yet (pending).
    expect(await renewPaymob(u.email)).toBe("paymob_pending");
    const renewalIntent = fake.intents.at(-1)!;
    // Meanwhile the owner moves to Pro.
    const { answer } = await payAndConfirm({ kind: "plan", plan: "pro" });
    expect(answer.result).toBe("paid");
    const upgraded = (await getUser(u.email))!;
    expect(upgraded.billing).toMatchObject({ plan: "pro", paidThrough: addMonths(today(), 1) });
    // The old Starter renewal's callback arrives.
    const late = await hook(txnObj({ amount: renewalIntent.amount, orderId: renewalIntent.orderId, ref: renewalIntent.ref }));
    expect(await late.json()).toMatchObject({ result: "unapplied" });
    const after = (await getUser(u.email))!;
    expect(after.billing).toMatchObject({ plan: "pro", paidThrough: addMonths(today(), 1) });
    expect(after.billing?.txns).toEqual(upgraded.billing?.txns);
  });
});

describe("a renewal charge with no answer keeps its pending guard (rule 2984)", () => {
  it("a charge that times out leaves pending, so the next day's run does not charge the card again", async () => {
    const u = await subscribed({ paidThrough: today() });
    fake.pay = () => { throw new Error("timeout"); };
    const now = Date.now();
    expect(await renewPaymob(u.email, now)).toBe("paymob_error");
    const b = (await getUser(u.email))!.billing!;
    expect(b.status).toBe("past_due");
    expect(b.pending).toMatchObject({ ref: fake.intents.at(-1)!.ref, day: ksaDay(now) });
    expect(await renewPaymob(u.email, now + 86400e3)).toBe("paymob_pending");
    expect(fake.calls.filter((c) => c === "/api/acceptance/payments/pay")).toHaveLength(1);
    // The charge did go through: its callback applies it and clears the guard.
    const it = fake.intents.at(-1)!;
    expect(await (await hook(txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref }))).json()).toMatchObject({ result: "paid" });
    const after = (await getUser(u.email))!.billing!;
    expect(after).toMatchObject({ status: "active", failures: 0, paidThrough: addMonths(today(), 1, b.anchor) });
    expect(after.pending).toBeUndefined();
  });

  it("a definite decline still clears pending (rule 714 unchanged)", async () => {
    const u = await subscribed({ paidThrough: today() });
    fake.pay = (orderId, ref) => txnObj({ amount: fake.intents.at(-1)!.amount, orderId, ref, success: false });
    expect(await renewPaymob(u.email)).toBe("paymob_declined");
    const b = (await getUser(u.email))!.billing!;
    expect(b).toMatchObject({ status: "past_due", failures: 1 });
    expect(b.pending).toBeUndefined();
  });
});
