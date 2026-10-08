import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { adminSignIn, jar, json, newMember, newUser, params, signIn } from "./helpers/session";
import { getUser, saveUser, trialOver, type User } from "@/lib/auth";
import { monthKey, renewalDue } from "@/lib/credits";
import { db } from "@/lib/db";
import { ksaDay } from "@/lib/partner-rules";
import { lotsOf } from "@/lib/topups";
import type { Payment } from "@/lib/partners";
import { TOKEN_HMAC_FIELDS, TXN_HMAC_FIELDS, hmacString, paymobConfig, signHmac, verifyHmac } from "@/lib/paymob";
import { addDays, addMonths, type Billing } from "@/lib/billing-state";
import { billingView, cardKey, paymentIdFor, priceFor, renewPaymob } from "@/lib/billing";
import { wipeAccount } from "@/lib/account";
import * as checkout from "@/app/api/billing/checkout/route";
import * as webhook from "@/app/api/billing/paymob/webhook/route";
import * as renewal from "@/app/api/billing/renewal/route";
import * as adminPayments from "@/app/api/admin/payments/[email]/route";
import * as adminPlan from "@/app/api/admin/plan/route";

/**
 * Paymob KSA billing (spec docs/superpowers/specs/2026-10-08-paymob-billing-design.md): rules 700-722 in
 * docs/system/tests.md. Paymob itself is faked at `fetch`: the intention, the saved-card pay call and the refund answer
 * as the documentation shows; callbacks are signed with the test HMAC secret exactly as Paymob signs them.
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

type Call = { path: string; body: Record<string, unknown>; auth: string | null };
type Fake = { calls: Call[]; pay: (orderId: number, ref: string) => Record<string, unknown> | null; refundStatus: number; nextOrder: number; intents: { orderId: number; ref: string; amount: number; integration: number }[] };
let fake: Fake;
function installFake() {
  fake = { calls: [], pay: () => null, refundStatus: 200, nextOrder: 700000 + Math.floor(Math.random() * 100000), intents: [] };
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== "https://ksa.paymob.com") throw new Error(`unexpected fetch ${u.origin}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    fake.calls.push({ path: u.pathname, body, auth });
    if (u.pathname === "/v1/intention/") {
      const orderId = ++fake.nextOrder;
      fake.intents.push({ orderId, ref: String(body.special_reference), amount: Number(body.amount), integration: (body.payment_methods as number[])[0] });
      return Response.json({ id: `pi_test_${orderId}`, client_secret: `csk_test_${orderId}`, intention_order_id: orderId, payment_keys: [{ integration: (body.payment_methods as number[])[0], key: `paykey_${orderId}` }] }, { status: 201 });
    }
    if (u.pathname === "/api/acceptance/payments/pay") {
      const last = fake.intents.at(-1)!;
      const obj = fake.pay(last.orderId, last.ref);
      return obj ? Response.json(obj) : Response.json({ detail: "no" }, { status: 400 });
    }
    if (u.pathname === "/api/acceptance/void_refund/refund") return Response.json({ id: 1, success: fake.refundStatus === 200 }, { status: fake.refundStatus });
    return Response.json({}, { status: 404 });
  });
}

beforeEach(() => { on(); installFake(); jar().clear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const today = () => ksaDay();
let txnSeq = 90000000 + Math.floor(Math.random() * 1000000);
const nextTxn = () => ++txnSeq;
/** A transaction callback's `obj` as Paymob sends it (fields from the documented sample). */
function txnObj(o: { id?: number; amount: number; orderId: number; ref: string; success?: boolean; pending?: boolean; currency?: string; refunded?: boolean; parent?: boolean; live?: boolean }) {
  return {
    id: o.id ?? nextTxn(), pending: o.pending ?? false, amount_cents: o.amount, success: o.success ?? true, is_auth: false, is_capture: false,
    is_standalone_payment: true, is_voided: false, is_refunded: o.refunded ?? false, is_3d_secure: true, integration_id: 111111,
    has_parent_transaction: o.parent ?? false, owner: 1053928, created_at: "2026-10-08T10:00:00.000000", currency: o.currency ?? "SAR",
    error_occured: false, is_live: o.live ?? false, source_data: { pan: "2346", type: "card", sub_type: "MasterCard" },
    order: { id: o.orderId, merchant_order_id: o.ref },
  };
}
const sign = (obj: Record<string, unknown>, fields: readonly string[] = TXN_HMAC_FIELDS, secret = ENV.PAYMOB_HMAC_SECRET) => signHmac(hmacString(obj, fields), secret);
let ipSeq = 0;
const hook = (obj: Record<string, unknown>, type: "TRANSACTION" | "TOKEN" = "TRANSACTION", hmac?: string) =>
  webhook.POST(json(`/api/billing/paymob/webhook?hmac=${hmac ?? sign(obj, type === "TOKEN" ? TOKEN_HMAC_FIELDS : TXN_HMAC_FIELDS)}`, "POST", { type, obj }, { "x-real-ip": `10.9.${++ipSeq % 250}.${ipSeq % 250}` }));
const pay = (body: Record<string, unknown>) => checkout.POST(json("/api/billing/checkout", "POST", body));
const payments = async (email: string) => Object.values(await db.hgetall<Payment>(`payments:${email}`));

/** A trial owner with a mobile number, signed in. */
async function owner(prefix = "pm"): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...(await getUser(u.email))!, phone: "+966500000123" });
  await signIn(u.email);
  return (await getUser(u.email))!;
}
/** Checkout, then the callback Paymob sends for it. Answers the intention Paymob saw and the callback's answer. */
async function payAndConfirm(body: Record<string, unknown>, opts: { success?: boolean } = {}) {
  const res = await pay(body);
  expect(res.status).toBe(200);
  const it = fake.intents.at(-1)!;
  const obj = txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref, success: opts.success });
  const cb = await hook(obj);
  return { it, obj, cb, answer: (await cb.json()) as { result: string } };
}
/** A paid Paymob subscription whose month ends `paidThrough`, set directly. */
async function subscribed(b: Partial<Billing> = {}, card = true): Promise<User> {
  const u = await owner("pmsub");
  const billing: Billing = { provider: "paymob", plan: "starter", status: "active", paidThrough: today(), anchor: Number(today().slice(8, 10)), autoRenew: card, failures: 0, txns: [], ...(card ? { card: { brand: "MasterCard", last4: "2346" } } : {}), ...b };
  await saveUser({ ...(await getUser(u.email))!, plan: "starter", renewedAt: monthKey(), billing });
  if (card) await db.set(cardKey(u.email), { token: "tok_" + randomBytes(16).toString("hex"), last4: "2346", brand: "MasterCard", expMonth: "01", expYear: "38", savedAt: new Date().toISOString(), orderId: 1 });
  return (await getUser(u.email))!;
}

describe("the gate (rule 700)", () => {
  it("Paymob is off unless the secret, public key, HMAC secret and card integration are all set; every route answers 404", async () => {
    const u = await owner();
    vi.stubEnv("PAYMOB_HMAC_SECRET", "");
    expect(paymobConfig()).toBeNull();
    expect((await pay({ kind: "plan", plan: "starter" })).status).toBe(404);
    expect((await renewal.POST(json("/api/billing/renewal", "POST", { action: "cancel" }))).status).toBe(404);
    expect((await hook(txnObj({ amount: 1, orderId: 1, ref: "pmi_" + "a".repeat(24) }))).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
    expect((await getUser(u.email))!.plan).toBe("trial");
  });
  it("live keys stay off without PAYMOB_LIVE=1; test keys need nothing more; the Moto integration is optional", () => {
    expect(paymobConfig()).toMatchObject({ live: false, cardIntegration: 111111, motoIntegration: 222222 });
    vi.stubEnv("PAYMOB_SECRET_KEY", "sk_live_fake");
    vi.stubEnv("PAYMOB_PUBLIC_KEY", "pk_live_fake");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(paymobConfig()).toBeNull();
    vi.stubEnv("PAYMOB_LIVE", "1");
    expect(paymobConfig()).toMatchObject({ live: true });
    err.mockRestore();
    vi.stubEnv("PAYMOB_INTEGRATION_ID_MOTO", "");
    expect(paymobConfig()!.motoIntegration).toBeNull();
    vi.stubEnv("PAYMOB_INTEGRATION_ID_CARD", "abc");
    expect(paymobConfig()).toBeNull();
  });
});

describe("callback HMACs (rules 701, 702)", () => {
  // Paymob's documented transaction sample, and the string the documentation says it concatenates to.
  const sample = {
    amount_cents: 100, created_at: "2020-03-25T18:39:44.719228", currency: "EGP", error_occured: false, has_parent_transaction: false,
    id: 2556706, integration_id: 6741, is_3d_secure: true, is_auth: false, is_capture: false, is_refunded: false, is_standalone_payment: true,
    is_voided: false, order: { id: 4778239 }, owner: 4705, pending: false, source_data: { pan: "2346", sub_type: "MasterCard", type: "card" }, success: true,
  };
  it("the transaction string is the 20 documented fields in Paymob's order, whatever the JSON key order (rule 701)", () => {
    expect(hmacString(sample, TXN_HMAC_FIELDS)).toBe("1002020-03-25T18:39:44.719228EGPfalsefalse25567066741truefalsefalsefalsetruefalse47782394705false2346MasterCardcardtrue");
    const reordered = Object.fromEntries(Object.entries(sample).reverse());
    const mac = signHmac(hmacString(sample, TXN_HMAC_FIELDS), "s3cret");
    expect(verifyHmac(reordered, TXN_HMAC_FIELDS, mac, "s3cret")).toBe(true);
    expect(verifyHmac(sample, TXN_HMAC_FIELDS, mac.toUpperCase(), "s3cret")).toBe(true);
  });
  it("a changed field, another secret, a missing, short or non-hex HMAC never verifies (rule 701)", () => {
    const mac = signHmac(hmacString(sample, TXN_HMAC_FIELDS), "s3cret");
    expect(verifyHmac({ ...sample, amount_cents: 1 }, TXN_HMAC_FIELDS, mac, "s3cret")).toBe(false);
    expect(verifyHmac(sample, TXN_HMAC_FIELDS, mac, "other")).toBe(false);
    expect(verifyHmac(sample, TXN_HMAC_FIELDS, null, "s3cret")).toBe(false);
    expect(verifyHmac(sample, TXN_HMAC_FIELDS, mac.slice(0, 64), "s3cret")).toBe(false);
    expect(verifyHmac(sample, TXN_HMAC_FIELDS, "z".repeat(128), "s3cret")).toBe(false);
    expect(verifyHmac(sample, TXN_HMAC_FIELDS, mac, "")).toBe(false);
  });
  it("the card-token string is the 8 documented fields in order (rule 702)", () => {
    const token = { id: 15978654, token: "3f22ce8a4e77125c70f0bc69830e34c36df469351e2fa6be76428be4", masked_pan: "xxxx-xxxx-xxxx-2346", merchant_id: 1053928, card_subtype: "MasterCard", created_at: "2026-08-24T13:28:31.015314", email: "kiyedi3052@claspira.com", order_id: "593881581" };
    expect(hmacString(token, TOKEN_HMAC_FIELDS)).toBe("MasterCard2026-08-24T13:28:31.015314kiyedi3052@claspira.com15978654xxxx-xxxx-xxxx-234610539285938815813f22ce8a4e77125c70f0bc69830e34c36df469351e2fa6be76428be4");
  });
});

describe("the webhook (rule 703)", () => {
  it("a wrong HMAC is 401 and changes nothing; a body that is not a callback is 400; an oversized body is 413", async () => {
    const u = await owner();
    await pay({ kind: "plan", plan: "starter" });
    const it = fake.intents.at(-1)!;
    const obj = txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref });
    expect((await hook(obj, "TRANSACTION", sign(obj, TXN_HMAC_FIELDS, "not-the-secret"))).status).toBe(401);
    expect((await hook(obj, "TRANSACTION", "0".repeat(128))).status).toBe(401);
    expect((await getUser(u.email))!.plan).toBe("trial");
    expect((await webhook.POST(json("/api/billing/paymob/webhook", "POST", { type: "OTHER", obj }))).status).toBe(400);
    const big = new Request("https://nashr.test/api/billing/paymob/webhook", { method: "POST", headers: { "content-type": "application/json", "content-length": String(70 * 1024) }, body: "{}" });
    expect((await webhook.POST(big)).status).toBe(413);
  });
  it("reads no cookie: a signed-in visitor's callback is judged by its HMAC alone", async () => {
    const src = (await import("node:fs")).readFileSync("src/app/api/billing/paymob/webhook/route.ts", "utf8");
    expect(src).not.toMatch(/currentUser|cookies\(|isAdmin|adminActor/);
    expect(src).toMatch(/allow\(`paymobhook:\$\{clientIp\(req\)\}`/);
  });
});

describe("checkout (rules 704-706)", () => {
  it("owner only: a member is 403, the founder impersonating is 403, nobody signed in is 401 (rule 704)", async () => {
    const u = await owner();
    const m = await newMember(u, "admin");
    await signIn(m.email);
    expect((await pay({ kind: "plan", plan: "starter" })).status).toBe(403);
    vi.stubEnv("ADMIN_EMAILS", "paymob-founder@test.example");
    await signIn(u.email, { imp: "paymob-founder@test.example" });
    expect((await pay({ kind: "plan", plan: "starter" })).status).toBe(403);
    jar().clear();
    expect((await pay({ kind: "plan", plan: "starter" })).status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });
  it("the amount is the pricing table's plus 15% VAT in halalas; an amount in the body is never read (rule 705)", async () => {
    await owner();
    const res = await pay({ kind: "plan", plan: "starter", amount: 1, amountCents: 1 });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { url: string };
    expect(j.url).toMatch(/^https:\/\/ksa\.checkout\.paymob\.com\/\?publicKey=pk_test_fake_public_for_unit_tests&clientSecret=csk_test_\d+$/);
    const call = fake.calls.find((c) => c.path === "/v1/intention/")!;
    expect(call.auth).toBe(`Token ${ENV.PAYMOB_SECRET_KEY}`);
    expect(call.body).toMatchObject({ amount: 34385, currency: "SAR", payment_methods: [111111] });
    expect((call.body.items as { amount: number }[])[0].amount).toBe(34385);
    expect(call.body.notification_url).toMatch(/\/api\/billing\/paymob\/webhook$/);
    expect(priceFor("plan", { plan: "pro" })).toEqual({ baseHalalas: 49900, vatHalalas: 7485, amountCents: 57385 });
    expect(priceFor("plan", { plan: "starter" }, true)).toEqual({ baseHalalas: 25400, vatHalalas: 3810, amountCents: 29210 });
    expect(priceFor("topup", { credits: 300 })).toEqual({ baseHalalas: 30000, vatHalalas: 4500, amountCents: 34500 });
    expect(priceFor("plan", { plan: "agency" })).toBeNull();
    expect(priceFor("topup", { credits: 299 })).toBeNull();
  });
  it("refuses a bad plan, Agency, a pack on a trial and an account with no mobile number, before Paymob is called (rule 705)", async () => {
    const u = await owner();
    expect((await pay({ kind: "plan", plan: "agency" })).status).toBe(400);
    expect((await pay({ kind: "plan", plan: "gold" })).status).toBe(400);
    expect((await pay({ kind: "topup", credits: 300 })).status).toBe(409);
    expect((await pay({ kind: "topup", credits: 7 })).status).toBe(400);
    await saveUser({ ...(await getUser(u.email))!, phone: "" });
    const r = await pay({ kind: "plan", plan: "starter" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "need_phone" });
    await saveUser({ ...(await getUser(u.email))!, phone: "+966500000123", plan: "agency" });
    expect(await (await pay({ kind: "plan", plan: "pro" })).json()).toMatchObject({ error: "agency" });
    expect(fake.calls).toHaveLength(0);
  });
  it("the intent is stored before Paymob is called, under a random reference, with the session's account (rule 706)", async () => {
    const u = await owner();
    await pay({ kind: "plan", plan: "pro", email: "someone-else@test.example" });
    const it = fake.intents.at(-1)!;
    expect(it.ref).toMatch(/^pmi_[a-f0-9]{24}$/);
    const intent = await db.get<{ email: string; plan: string; amountCents: number; orderId: number; status: string }>(`paymob:intent:${it.ref}`);
    expect(intent).toMatchObject({ email: u.email, plan: "pro", amountCents: 57385, orderId: it.orderId, status: "open" });
    expect(await db.get(`paymob:order:${it.orderId}`)).toBe(it.ref);
  });
});

describe("applying a payment (rules 707-711)", () => {
  it("a paid plan: plan, month credits, subscription and a payment of the amount before VAT (rule 710)", async () => {
    const u = await owner();
    const { obj, answer } = await payAndConfirm({ kind: "plan", plan: "starter" });
    expect(answer.result).toBe("paid");
    const after = (await getUser(u.email))!;
    expect(after.plan).toBe("starter");
    expect(after.renewedAt).toBe(monthKey());
    expect(after.billing).toMatchObject({ provider: "paymob", plan: "starter", status: "active", paidThrough: addMonths(today(), 1), anchor: Number(today().slice(8, 10)), failures: 0, txns: [String(obj.id)] });
    expect(trialOver(after)).toBe(false);
    const p = await payments(u.email);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: paymentIdFor(obj.id), amountSar: 299, plan: "starter", reference: `paymob:${obj.id}`, recordedBy: "paymob" });
  });
  it("the same callback twice, or concurrently, applies once (rule 707)", async () => {
    const u = await owner();
    const { obj } = await payAndConfirm({ kind: "plan", plan: "starter" });
    const credits = (await getUser(u.email))!.credits;
    const again = await Promise.all([hook(obj), hook(obj), hook(obj)]);
    for (const r of again) expect([200, 503]).toContain(r.status);
    expect((await Promise.all(again.map((r) => r.json()))).map((j: { result: string }) => j.result).filter((x) => x === "paid")).toHaveLength(0);
    expect(await payments(u.email)).toHaveLength(1);
    expect((await getUser(u.email))!.credits).toBe(credits);
  });
  it("an amount, currency, order or live flag that does not match our intent applies nothing and is logged (rule 708)", async () => {
    const u = await owner();
    await pay({ kind: "plan", plan: "business" });
    const it = fake.intents.at(-1)!;
    for (const bad of [{ amount: 100 }, { currency: "EGP" }, { orderId: it.orderId + 1 }, { live: true }]) {
      const r = await hook(txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref, ...bad }));
      expect(await r.json()).toMatchObject({ result: "mismatch" });
    }
    expect((await getUser(u.email))!.plan).toBe("trial");
    expect(await payments(u.email)).toHaveLength(0);
    const log = (await db.lrange("admin:log", 0, 50)).map(String).filter((l) => l.includes(u.email) && l.includes("paymob_mismatch"));
    expect(log.length).toBeGreaterThanOrEqual(4);
  });
  it("declined, pending, refunded and child transactions apply nothing; an unknown reference is ignored (rule 709)", async () => {
    const u = await owner();
    await pay({ kind: "plan", plan: "starter" });
    const it = fake.intents.at(-1)!;
    const base = { amount: it.amount, orderId: it.orderId, ref: it.ref };
    expect(await (await hook(txnObj({ ...base, success: false }))).json()).toMatchObject({ result: "declined" });
    for (const x of [{ pending: true }, { refunded: true }, { parent: true }]) expect(await (await hook(txnObj({ ...base, ...x }))).json()).toMatchObject({ result: "ignored" });
    expect(await (await hook(txnObj({ ...base, ref: "pmi_" + "0".repeat(24) }))).json()).toMatchObject({ result: "ignored" });
    expect(await (await hook(txnObj({ ...base, ref: "not-ours" }))).json()).toMatchObject({ result: "ignored" });
    expect((await getUser(u.email))!.plan).toBe("trial");
  });
  it("a paid pack is added once, through the same path as the console's (rule 711)", async () => {
    const u = await owner();
    await saveUser({ ...(await getUser(u.email))!, plan: "starter", credits: 300, renewedAt: monthKey() });
    const { obj, answer } = await payAndConfirm({ kind: "topup", credits: 300 });
    expect(answer.result).toBe("paid");
    expect(fake.intents.at(-1)!.amount).toBe(34500);
    await hook(obj);
    const after = (await getUser(u.email))!;
    expect(lotsOf(after)).toHaveLength(1);
    expect(after.credits).toBe(600);
    const p = await payments(u.email);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: paymentIdFor(obj.id), amountSar: 300, topup: { credits: 300 } });
  });
  it("paying the same plan again before its month ends adds a month to it (rule 721)", async () => {
    const u = await subscribed({ paidThrough: addDays(today(), 10), anchor: 5 }, false);
    await payAndConfirm({ kind: "plan", plan: "starter" });
    expect((await getUser(u.email))!.billing).toMatchObject({ paidThrough: addMonths(addDays(today(), 10), 1, 5), anchor: 5, status: "active" });
  });
});

describe("the saved card (rule 715)", () => {
  it("is kept only when its order is ours and its email is the intent's; the token never reaches a page or an answer", async () => {
    const u = await owner();
    await pay({ kind: "plan", plan: "starter" });
    const it = fake.intents.at(-1)!;
    const tokenObj = (o: Record<string, unknown> = {}) => ({ id: 1, token: "tok" + randomBytes(20).toString("hex"), masked_pan: "xxxx-xxxx-xxxx-4242", merchant_id: 1, card_subtype: "Visa", created_at: "2026-10-08T10:00:00", email: u.email, order_id: String(it.orderId), expiry_month: "01", expiry_year: "38", ...o });
    expect(await (await hook(tokenObj({ email: "attacker@test.example" }), "TOKEN")).json()).toMatchObject({ result: "ignored" });
    expect(await (await hook(tokenObj({ order_id: "1" }), "TOKEN")).json()).toMatchObject({ result: "ignored" });
    const good = tokenObj();
    expect((await hook(good, "TOKEN", sign(good, TOKEN_HMAC_FIELDS, "wrong"))).status).toBe(401);
    expect(await db.get(cardKey(u.email))).toBeNull();
    expect(await (await hook(good, "TOKEN")).json()).toMatchObject({ result: "card_saved" });
    expect(await db.get(cardKey(u.email))).toMatchObject({ token: good.token, last4: "4242", brand: "Visa" });
    await hook(txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref }));
    const after = (await getUser(u.email))!;
    expect(after.billing).toMatchObject({ autoRenew: true, card: { brand: "Visa", last4: "4242" } });
    expect(JSON.stringify(after)).not.toContain(good.token);
    expect(JSON.stringify(billingView(after.billing))).not.toContain(good.token);
    const r = await renewal.POST(json("/api/billing/renewal", "POST", { action: "cancel" }));
    expect(JSON.stringify(await r.json())).not.toContain(good.token);
  });
});

describe("renewals on the saved card (rules 712-714)", () => {
  it("a due month is charged on the Moto integration with the card token, and moves one month on its anchor day (rule 713)", async () => {
    const u = await subscribed({ paidThrough: today(), anchor: 31 });
    fake.pay = (orderId, ref) => txnObj({ amount: 34385, orderId, ref });
    expect(await renewPaymob(u.email)).toBe("paymob_renewed");
    const intention = fake.calls.find((c) => c.path === "/v1/intention/")!;
    expect(intention.body).toMatchObject({ amount: 34385, payment_methods: [222222] });
    const payCall = fake.calls.find((c) => c.path === "/api/acceptance/payments/pay")!;
    expect(payCall.auth).toBeNull();
    expect(payCall.body).toMatchObject({ source: { subtype: "TOKEN", identifier: (await db.get<{ token: string }>(cardKey(u.email)))!.token }, payment_token: expect.stringMatching(/^paykey_/) });
    const after = (await getUser(u.email))!;
    expect(after.billing).toMatchObject({ status: "active", paidThrough: addMonths(today(), 1, 31), anchor: 31, failures: 0 });
    expect(after.billing!.pending).toBeUndefined();
    expect(await payments(u.email)).toEqual([expect.objectContaining({ amountSar: 299, plan: "starter" })]);
    // Nothing is due until the new end, and a second run the same day charges nothing.
    expect(await renewPaymob(u.email)).toBeNull();
    expect(fake.calls.filter((c) => c.path === "/api/acceptance/payments/pay")).toHaveLength(1);
  });
  it("a declined charge makes the account past due with 7 days of grace; one attempt a day (rule 714)", async () => {
    const u = await subscribed({ paidThrough: today() });
    fake.pay = (orderId, ref) => txnObj({ amount: 34385, orderId, ref, success: false });
    expect(await renewPaymob(u.email)).toBe("paymob_declined");
    expect((await getUser(u.email))!.billing).toMatchObject({ status: "past_due", failures: 1, graceUntil: addDays(today(), 7), paidThrough: today() });
    expect(trialOver((await getUser(u.email))!)).toBe(false);
    expect(await renewPaymob(u.email)).toBeNull();
    expect(fake.calls.filter((c) => c.path === "/api/acceptance/payments/pay")).toHaveLength(1);
    expect(await payments(u.email)).toHaveLength(0);
  });
  it("with no saved card or no Moto integration the month is due by hand: past due, nothing charged (rule 714)", async () => {
    vi.stubEnv("PAYMOB_INTEGRATION_ID_MOTO", "");
    const u = await subscribed({ paidThrough: today() });
    expect(await renewPaymob(u.email)).toBe("paymob_due");
    expect(fake.calls).toHaveLength(0);
    expect((await getUser(u.email))!.billing!.status).toBe("past_due");
  });
  it("after the grace days the account is locked: trialOver, no new month of credits; paying again unlocks it (rule 712)", async () => {
    const u = await subscribed({ status: "past_due", paidThrough: addDays(today(), -8), graceUntil: addDays(today(), -1), failures: 3 });
    expect(await renewPaymob(u.email)).toBe("paymob_locked");
    const locked = (await getUser(u.email))!;
    expect(locked.billing!.status).toBe("locked");
    expect(trialOver(locked)).toBe(true);
    expect(renewalDue({ ...locked, renewedAt: "2000-01" })).toBe(false);
    expect(await renewPaymob(u.email)).toBeNull();
    await signIn(u.email);
    const { answer } = await payAndConfirm({ kind: "plan", plan: "starter" });
    expect(answer.result).toBe("paid");
    const back = (await getUser(u.email))!;
    expect(back.billing).toMatchObject({ status: "active", paidThrough: addMonths(today(), 1) });
    expect(trialOver(back)).toBe(false);
  });
});

describe("the owner's renewal settings (rule 716)", () => {
  it("cancel stops the charge, resume needs a saved card, remove_card deletes the token; owner only", async () => {
    const u = await subscribed();
    const act = (action: unknown) => renewal.POST(json("/api/billing/renewal", "POST", { action }));
    expect((await act("explode")).status).toBe(400);
    expect(await (await act("cancel")).json()).toMatchObject({ ok: true, billing: { autoRenew: false } });
    expect(await (await act("resume")).json()).toMatchObject({ ok: true, billing: { autoRenew: true } });
    expect(await (await act("remove_card")).json()).toMatchObject({ ok: true, billing: { autoRenew: false, card: null } });
    expect(await db.get(cardKey(u.email))).toBeNull();
    expect(await (await act("resume")).json()).toMatchObject({ ok: false, error: "no_card" });
    const m = await newMember(u, "admin");
    await signIn(m.email);
    expect((await act("cancel")).status).toBe(403);
  });
});

describe("the founder (rules 717, 718)", () => {
  const refund = (email: string, b: Record<string, unknown>) => adminPayments.POST(json(`/api/admin/payments/${encodeURIComponent(email)}`, "POST", { action: "refund", ...b }), params({ email: encodeURIComponent(email) }));
  it("a refund calls Paymob once for the whole transaction, voids the payment, and a retry only finishes (rule 718)", async () => {
    const u = await owner();
    const { obj, it } = await payAndConfirm({ kind: "plan", plan: "starter" });
    jar().clear();
    await adminSignIn();
    const id = paymentIdFor(obj.id);
    const r = await refund(u.email, { id, reason: "asked" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, alreadyRefunded: false, payment: { id, voidedAt: expect.any(String) } });
    const calls = fake.calls.filter((c) => c.path === "/api/acceptance/void_refund/refund");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ transaction_id: obj.id, amount_cents: it.amount });
    expect(calls[0].auth).toBe(`Token ${ENV.PAYMOB_SECRET_KEY}`);
    await refund(u.email, { id });
    expect(fake.calls.filter((c) => c.path === "/api/acceptance/void_refund/refund")).toHaveLength(1);
  });
  it("refuses a payment recorded by hand, another account's payment, and keeps the payment when Paymob refuses (rule 718)", async () => {
    const a = await owner();
    const { obj } = await payAndConfirm({ kind: "plan", plan: "starter" });
    const b = await owner();
    jar().clear();
    await adminSignIn();
    expect((await refund(b.email, { id: paymentIdFor(obj.id) })).status).toBe(404);
    const manual = await adminPayments.POST(json(`/api/admin/payments/${encodeURIComponent(b.email)}`, "POST", { action: "record", amountSar: 299, plan: "starter", date: today(), reference: `paymob:${obj.id}` }), params({ email: encodeURIComponent(b.email) }));
    const mid = ((await manual.json()) as { payment: Payment }).payment.id;
    expect((await refund(b.email, { id: mid })).status).toBe(409);
    fake.refundStatus = 400;
    const r = await refund(a.email, { id: paymentIdFor(obj.id) });
    expect(r.status).toBe(502);
    expect((await payments(a.email))[0].voidedAt).toBeUndefined();
    jar().clear();
    expect((await refund(a.email, { id: paymentIdFor(obj.id) })).status).toBe(401);
  });
  it("a plan set by hand ends the online subscription and its lock (rule 717)", async () => {
    const u = await subscribed({ status: "locked" });
    jar().clear();
    await adminSignIn();
    const r = await adminPlan.POST(json("/api/admin/plan", "POST", { email: u.email, plan: "pro" }));
    expect(r.status).toBe(200);
    const after = (await getUser(u.email))!;
    expect(after.billing).toBeUndefined();
    expect(trialOver(after)).toBe(false);
  });
});

describe("leaving (rule 719)", () => {
  it("deleting the account deletes the saved card token", async () => {
    const u = await subscribed();
    expect(await db.get(cardKey(u.email))).not.toBeNull();
    await wipeAccount(u.email);
    expect(await db.get(cardKey(u.email))).toBeNull();
  });
});

describe("the ZATCA seam (rule 720)", () => {
  it("every applied payment calls invoiceForPayment once with the base, the VAT and the Paymob transaction", async () => {
    const inv = await import("@/lib/invoice");
    const spy = vi.spyOn(inv, "invoiceForPayment");
    await owner();
    const { obj } = await payAndConfirm({ kind: "plan", plan: "starter" });
    await hook(obj);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ baseHalalas: 29900, vatHalalas: 4485, totalHalalas: 34385, currency: "SAR", provider: "paymob", providerRef: String(obj.id), kind: "plan" });
    spy.mockRestore();
  });
});

describe("the billing page (rule 722)", () => {
  type AsyncPage = (p: { params: Promise<{ lang: string }>; searchParams?: Promise<Record<string, string>> }) => Promise<React.ReactElement>;
  const html = async (sp: Record<string, string> = {}) => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Page = (await import("@/app/[lang]/app/billing/page")).default as unknown as AsyncPage;
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ lang: "en" }), searchParams: Promise.resolve(sp) }));
  };
  it("with Paymob off the pay links and WhatsApp are unchanged and no card button is shown", async () => {
    vi.stubEnv("PAYMOB_SECRET_KEY", "");
    vi.stubEnv("PAY_LINK_STARTER", "https://pay.example/starter");
    await owner();
    const h = await html({ paymob: "return" });
    expect(h).toContain('href="https://pay.example/starter"');
    expect(h).not.toContain("data-paymob-pay");
    expect(h).not.toContain("data-paymob-return");
  });
  it("with Paymob on the owner gets card buttons for plans and packs, the subscription card and the return notice", async () => {
    vi.stubEnv("PAY_LINK_STARTER", "https://pay.example/starter");
    const u = await subscribed({ paidThrough: addDays(today(), 20), status: "past_due", graceUntil: addDays(today(), 27) });
    await signIn(u.email);
    const h = await html({ paymob: "return" });
    expect(h).toContain('data-paymob-pay="plan"');
    expect(h).toContain('data-paymob-pay="topup"');
    expect(h).toContain('data-paymob-plan="past_due"');
    expect(h).toContain("data-paymob-return");
    expect(h).toContain("MasterCard •••• 2346");
    expect(h).not.toContain('href="https://pay.example/starter"');
    expect(h).not.toContain((await db.get<{ token: string }>(cardKey(u.email)))!.token);
  });
  it("the founder impersonating sees no card button: paying is the owner's own act", async () => {
    const u = await subscribed();
    vi.stubEnv("ADMIN_EMAILS", "paymob-founder@test.example");
    await signIn(u.email, { imp: "paymob-founder@test.example" });
    const h = await html();
    expect(h).not.toContain("data-paymob-pay");
    expect(h).not.toContain("data-paymob-plan");
  });
});
