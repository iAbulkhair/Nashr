import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { json, newUser, signIn } from "./helpers/session";
import { acct, getUser, saveUser, type User } from "@/lib/auth";
import { monthKey } from "@/lib/credits";
import { db } from "@/lib/db";
import { dict, yearlyPlanCards } from "@/lib/i18n";
import { ksaDay } from "@/lib/partner-rules";
import type { Payment } from "@/lib/partners";
import {
  PLAN_CREDITS, PLAN_PRICE_SAR, PLAN_YEARLY_MONTHS_FREE, PLAN_YEARLY_PRICE_SAR, PRICES_INCLUDE_VAT, SAR_PER_USD, type SelfServePlan,
  anyYearlyOffered, cheapestCreditUsd, intervalPriceSar, priceOf, yearlyPerMonthSar, yearlyPriceSar,
} from "@/lib/pricing";
import { TXN_HMAC_FIELDS, hmacString, signHmac } from "@/lib/paymob";
import { addDays, addMonths, billingInterval, type Billing } from "@/lib/billing-state";
import { billingView, cardKey, priceFor, renewPaymob } from "@/lib/billing";
import Pricing from "@/components/Pricing";
import { PaymobPayButton } from "@/components/app/PaymobBilling";
import * as checkout from "@/app/api/billing/checkout/route";
import * as webhook from "@/app/api/billing/paymob/webhook/route";

/**
 * Yearly billing with a TEST-ONLY yearly price (rules 3531-3542, docs/system/tests/3530-yearly-pricing.md). These numbers
 * are not prices: they exist only in this file's module graph (each test file has its own), to prove the switch, the
 * totals, VAT, the paid-through day and the renewals once the founder sets real amounts in src/lib/pricing.ts. Starter
 * gets a set price, Pro a months-free count; Business stays monthly only.
 */
const TEST_STARTER_YEARLY = 2990;
const TEST_PRO_MONTHS_FREE = 2;
Object.assign(PLAN_YEARLY_PRICE_SAR as Record<SelfServePlan, number | null>, { starter: TEST_STARTER_YEARLY });
// The whole table, not one entry: pricing.ts now sets 2 months free on every plan (rule 4035), and a plan with both a set
// price and months free is offered for no price (`yearlyPriceSar`). tests/yearly-pricing.test.ts pins the real values.
Object.assign(PLAN_YEARLY_MONTHS_FREE as Record<SelfServePlan, number | null>, { starter: null, pro: TEST_PRO_MONTHS_FREE, business: null });

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

type Call = { path: string; body: Record<string, unknown> };
let calls: Call[] = [];
let intents: { orderId: number; ref: string; amount: number }[] = [];
let payAnswer: ((orderId: number, ref: string, amount: number) => Record<string, unknown>) | null = null;
let nextOrder = 800000 + Math.floor(Math.random() * 100000);
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  calls = [];
  intents = [];
  payAnswer = null;
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== "https://ksa.paymob.com") throw new Error(`unexpected fetch ${u.origin}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: u.pathname, body });
    if (u.pathname === "/v1/intention/") {
      const orderId = ++nextOrder;
      intents.push({ orderId, ref: String(body.special_reference), amount: Number(body.amount) });
      return Response.json({ id: `pi_test_${orderId}`, client_secret: `csk_test_${orderId}`, intention_order_id: orderId, payment_keys: [{ integration: (body.payment_methods as number[])[0], key: `paykey_${orderId}` }] }, { status: 201 });
    }
    if (u.pathname === "/api/acceptance/payments/pay") {
      const last = intents.at(-1)!;
      return payAnswer ? Response.json(payAnswer(last.orderId, last.ref, last.amount)) : Response.json({ detail: "no" }, { status: 400 });
    }
    return Response.json({}, { status: 404 });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const today = () => ksaDay();
let txnSeq = 70000000 + Math.floor(Math.random() * 1000000);
function txnObj(o: { amount: number; orderId: number; ref: string }) {
  return {
    id: ++txnSeq, pending: false, amount_cents: o.amount, success: true, is_auth: false, is_capture: false,
    is_standalone_payment: true, is_voided: false, is_refunded: false, is_3d_secure: true, integration_id: 111111,
    has_parent_transaction: false, owner: 1053928, created_at: "2026-10-08T10:00:00.000000", currency: "SAR",
    error_occured: false, is_live: false, source_data: { pan: "2346", type: "card", sub_type: "MasterCard" },
    order: { id: o.orderId, merchant_order_id: o.ref },
  };
}
let ipSeq = 0;
const hook = (obj: Record<string, unknown>) =>
  webhook.POST(json(`/api/billing/paymob/webhook?hmac=${signHmac(hmacString(obj, TXN_HMAC_FIELDS), ENV.PAYMOB_HMAC_SECRET)}`, "POST", { type: "TRANSACTION", obj }, { "x-forwarded-for": `10.8.${++ipSeq % 250}.${ipSeq % 250}` }));
const pay = (body: Record<string, unknown>) => checkout.POST(json("/api/billing/checkout", "POST", body));
const payments = async (email: string) => Object.values(await db.hgetall<Payment>(`payments:${email}`));

async function owner(): Promise<User> {
  const u = await newUser("yr1");
  await saveUser({ ...(await getUser(acct(u)))!, phone: "+966500000123" });
  await signIn(u.email);
  return (await getUser(acct(u)))!;
}
async function payAndConfirm(body: Record<string, unknown>) {
  const res = await pay(body);
  expect(res.status).toBe(200);
  const it = intents.at(-1)!;
  const cb = await hook(txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref }));
  return { it, answer: (await cb.json()) as { result: string } };
}
/** A paid subscription set directly, with a saved card. */
async function subscribed(b: Partial<Billing> = {}): Promise<User> {
  const u = await owner();
  const plan = b.plan ?? "starter";
  const billing: Billing = { provider: "paymob", plan, status: "active", paidThrough: today(), anchor: Number(today().slice(8, 10)), autoRenew: true, failures: 0, txns: [], card: { brand: "MasterCard", last4: "2346" }, ...b };
  await saveUser({ ...(await getUser(acct(u)))!, plan, renewedAt: monthKey(), billing });
  await db.set(cardKey(acct(u)), { token: "tok_" + randomBytes(16).toString("hex"), last4: "2346", brand: "MasterCard", expMonth: "01", expYear: "38", savedAt: new Date().toISOString(), orderId: 1 });
  return (await getUser(acct(u)))!;
}
const vat = (halalas: number) => Math.round(halalas * 0.15);

describe("the yearly price comes only from pricing.ts (rules 3530-3531)", () => {
  it("a set price, months free, and plans without either", () => {
    expect(yearlyPriceSar("starter")).toBe(TEST_STARTER_YEARLY);
    expect(yearlyPriceSar("pro")).toBe(PLAN_PRICE_SAR.pro * (12 - TEST_PRO_MONTHS_FREE));
    expect(yearlyPriceSar("business")).toBeNull();
    expect(yearlyPriceSar("trial")).toBeNull();
    expect(yearlyPriceSar("agency")).toBeNull();
    expect(anyYearlyOffered()).toBe(true);
    expect(intervalPriceSar("starter", "month")).toBe(299);
    expect(intervalPriceSar("starter", "year")).toBe(TEST_STARTER_YEARLY);
    expect(yearlyPerMonthSar("starter")).toBe(249.17);
    expect(yearlyPerMonthSar("pro")).toBe(415.83);
  });

  it("a typo is never sold: both inputs set, a price over twelve months, a fraction, too many months free", () => {
    const prices = PLAN_YEARLY_PRICE_SAR as Record<SelfServePlan, number | null>;
    const free = PLAN_YEARLY_MONTHS_FREE as Record<SelfServePlan, number | null>;
    try {
      for (const [p, f] of [[999, 1], [999 * 12 + 1, null], [0, null], [9990.5, null], [null, 7], [null, -1], [null, 1.5]] as const) {
        prices.business = p;
        free.business = f;
        expect(yearlyPriceSar("business")).toBeNull();
      }
      prices.business = 999 * 12;
      free.business = null;
      expect(yearlyPriceSar("business")).toBe(11988);
    } finally {
      prices.business = null;
      free.business = null;
    }
  });

  it("VAT is computed on the yearly ex-VAT amount the same way as on a month; the first-month offer never applies", () => {
    const base = TEST_STARTER_YEARLY * 100;
    expect(priceFor("plan", { plan: "starter", interval: "year" })).toEqual({ baseHalalas: base, vatHalalas: vat(base), amountCents: base + vat(base) });
    expect(priceFor("plan", { plan: "starter", interval: "year" })!.amountCents).toBe(343850);
    expect(priceFor("plan", { plan: "starter", interval: "year" }, true)).toBeNull();
    expect(priceFor("plan", { plan: "business", interval: "year" })).toBeNull();
    // A price lock is one month's ex-VAT price: a yearly renewal compares twelve of them with the yearly list price.
    expect(priceFor("renewal", { plan: "starter", interval: "year" }, false, 20000)!.baseHalalas).toBe(240000);
    expect(priceFor("renewal", { plan: "starter", interval: "year" }, false, 29900)!.baseHalalas).toBe(base);
  });

  it("the margin floor counts the yearly credit, so a yearly discount lowers it (rule 3538)", () => {
    const none = cheapestCreditUsd(PLAN_PRICE_SAR, PLAN_CREDITS, PRICES_INCLUDE_VAT, { starter: null, pro: null, business: null });
    const proYear = (PLAN_PRICE_SAR.pro * 10) / 12 / SAR_PER_USD / PLAN_CREDITS.pro;
    expect(cheapestCreditUsd()).toBeCloseTo(Math.min(none, proYear), 12);
    expect(cheapestCreditUsd()).toBeLessThan(none);
  });

  it("MRR counts a yearly subscription at its yearly price per month (rule 3537)", () => {
    expect(priceOf({ plan: "starter", billing: { interval: "year" } })).toBe(249.17);
    expect(priceOf({ plan: "starter", billing: {} })).toBe(299);
    expect(priceOf({ plan: "business", billing: { interval: "year" } })).toBe(999);
  });
});

describe("the pricing switch and cards (rules 3541-3542)", () => {
  it("draws a labelled two-button switch, monthly first and shown, yearly cards hidden until pressed", () => {
    const html = renderToStaticMarkup(h(Pricing, { t: dict.en, lang: "en", headingLevel: 1 }));
    expect(html).toMatch(/<div role="group" aria-label="Billing period" data-interval-switch=""/);
    expect(html).toMatch(/<button type="button" aria-pressed="true"[^>]*data-interval="month"[^>]*>Monthly<\/button>/);
    expect(html).toMatch(/<button type="button" aria-pressed="false"[^>]*data-interval="year"[^>]*>Yearly<\/button>/);
    expect(html).toMatch(/data-interval-panel="month"/);
    expect(html).toMatch(/hidden=""[^>]*data-interval-panel="year"/);
    const [monthly, yearly] = html.split('data-interval-panel="year"');
    expect(monthly).not.toContain("data-yearly-note");
    expect(yearly).toContain("2,990");
    expect(yearly).toContain("That is 249.17 SAR a month, paid once a year");
    expect(yearly).toContain("4,990");
    expect(yearly).toContain("That is 415.83 SAR a month, paid once a year");
    // Business has no yearly price: its yearly card is the monthly one.
    expect(yearly).toContain(">999</span> SAR / month");
  });

  it("Arabic: the same switch in Arabic, the yearly cards in Arabic", () => {
    const html = renderToStaticMarkup(h(Pricing, { t: dict.ar, lang: "ar" }));
    expect(html).toContain('aria-label="مدة الفوترة"');
    expect(html).toContain(">شهري</button>");
    expect(html).toContain(">سنوي</button>");
    const cards = yearlyPlanCards("ar", dict.ar.pricing.plans);
    expect(cards.find((c) => c.id === "starter")).toMatchObject({ price: "2,990", period: "ريال / سنة", note: "أي 249.17 ريال شهرياً، تُدفع مرة واحدة في السنة" });
    expect(cards.find((c) => c.id === "agency")).toEqual(dict.ar.pricing.plans.find((c) => c.id === "agency"));
  });

  it("the billing page's yearly pay button sends interval year; the monthly one sends nothing new (rule 3536)", () => {
    expect(renderToStaticMarkup(h(PaymobPayButton, { lang: "en", kind: "plan", plan: "starter", interval: "year", label: "y" }))).toContain('data-paymob-interval="year"');
    expect(renderToStaticMarkup(h(PaymobPayButton, { lang: "en", kind: "plan", plan: "starter", label: "m" }))).not.toContain("data-paymob-interval");
  });
});

describe("checkout, paid-through and renewals (rules 3532-3535)", () => {
  it("a yearly checkout charges the yearly total with VAT and moves paidThrough twelve months", async () => {
    const u = await owner();
    const { it: intent, answer } = await payAndConfirm({ kind: "plan", plan: "starter", interval: "year" });
    expect(answer.result).toBe("paid");
    expect(intent.amount).toBe(343850);
    const intention = calls.find((c) => c.path === "/v1/intention/")!;
    expect(JSON.stringify(intention.body.items)).toContain("1 year");
    const after = (await getUser(acct(u)))!;
    expect(after.plan).toBe("starter");
    expect(after.billing).toMatchObject({ plan: "starter", status: "active", interval: "year", paidThrough: addMonths(today(), 12) });
    expect(billingView(after.billing)).toMatchObject({ interval: "year" });
    expect(await payments(acct(u))).toEqual([expect.objectContaining({ amountSar: TEST_STARTER_YEARLY, plan: "starter" })]);
  });

  it("a monthly checkout is unchanged: no interval stored, one month", async () => {
    const u = await owner();
    await payAndConfirm({ kind: "plan", plan: "starter" });
    const after = (await getUser(acct(u)))!;
    expect(after.billing!.interval).toBeUndefined();
    expect(after.billing!.paidThrough).toBe(addMonths(today(), 1));
  });

  it("yearly is refused for a plan without a yearly price", async () => {
    await owner();
    const r = await pay({ kind: "plan", plan: "business", interval: "year" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "yearly_not_offered" });
    expect(calls).toHaveLength(0);
  });

  it("a yearly renewal charges the yearly total on the saved card and moves twelve months on the anchor day", async () => {
    const u = await subscribed({ plan: "starter", interval: "year", paidThrough: today(), anchor: 31 });
    payAnswer = (orderId, ref, amount) => txnObj({ amount, orderId, ref });
    expect(await renewPaymob(acct(u))).toBe("paymob_renewed");
    expect(intents.at(-1)!.amount).toBe(343850);
    const after = (await getUser(acct(u)))!;
    expect(after.billing).toMatchObject({ status: "active", interval: "year", paidThrough: addMonths(today(), 12, 31), anchor: 31 });
  });

  it("an old record with no interval renews one month at the monthly price (expand: rule 3533)", async () => {
    const u = await subscribed({ plan: "starter", paidThrough: today(), anchor: 31 });
    expect(billingInterval(u.billing)).toBe("month");
    payAnswer = (orderId, ref, amount) => txnObj({ amount, orderId, ref });
    expect(await renewPaymob(acct(u))).toBe("paymob_renewed");
    expect(intents.at(-1)!.amount).toBe(34385);
    const after = (await getUser(acct(u)))!;
    expect(after.billing!.paidThrough).toBe(addMonths(today(), 1, 31));
    expect(after.billing!.interval).toBeUndefined();
  });

  it("a yearly subscription whose yearly price was withdrawn renews monthly and is monthly from then on", async () => {
    const u = await subscribed({ plan: "business", interval: "year", paidThrough: today(), anchor: 31 });
    payAnswer = (orderId, ref, amount) => txnObj({ amount, orderId, ref });
    expect(await renewPaymob(acct(u))).toBe("paymob_renewed");
    expect(intents.at(-1)!.amount).toBe(99900 + vat(99900));
    const after = (await getUser(acct(u)))!;
    expect(after.billing!.paidThrough).toBe(addMonths(today(), 1, 31));
    expect(after.billing!.interval).toBeUndefined();
  });

  it("monthly to yearly on the same plan adds the year after the month already paid: nothing is lost", async () => {
    const paidThrough = addDays(today(), 10);
    const u = await subscribed({ plan: "starter", paidThrough, anchor: Number(paidThrough.slice(8, 10)) });
    await payAndConfirm({ kind: "plan", plan: "starter", interval: "year" });
    const after = (await getUser(acct(u)))!;
    expect(after.billing).toMatchObject({ interval: "year", paidThrough: addMonths(paidThrough, 12, Number(paidThrough.slice(8, 10))) });
  });

  it("another plan while a paid year runs is refused at checkout, and when a checkout opened earlier is paid (rule 3535)", async () => {
    const paidThrough = addMonths(today(), 6);
    const u = await subscribed({ plan: "pro", interval: "year", paidThrough });
    for (const body of [{ kind: "plan", plan: "starter" }, { kind: "plan", plan: "starter", interval: "year" }, { kind: "plan", plan: "business" }]) {
      const r = await pay(body);
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: "yearly_active" });
    }
    expect(calls).toHaveLength(0);
    // Two tabs: a Starter checkout opened while monthly, paid after the Pro year was bought. Nothing is applied.
    await saveUser({ ...(await getUser(acct(u)))!, billing: { ...(await getUser(acct(u)))!.billing!, interval: undefined } });
    const res = await pay({ kind: "plan", plan: "starter" });
    expect(res.status).toBe(200);
    const it = intents.at(-1)!;
    await saveUser({ ...(await getUser(acct(u)))!, billing: { ...(await getUser(acct(u)))!.billing!, interval: "year" } });
    const cb = await hook(txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref }));
    expect(((await cb.json()) as { result: string }).result).not.toBe("paid");
    const after = (await getUser(acct(u)))!;
    expect(after.plan).toBe("pro");
    expect(after.billing).toMatchObject({ plan: "pro", interval: "year", paidThrough });
    expect(await payments(acct(u))).toEqual([]);
  });

  it("the same plan paid again during its year extends it; the year's end frees a plan change", async () => {
    const paidThrough = addMonths(today(), 3);
    const anchor = Number(paidThrough.slice(8, 10));
    const u = await subscribed({ plan: "starter", interval: "year", paidThrough, anchor });
    await payAndConfirm({ kind: "plan", plan: "starter", interval: "year" });
    expect((await getUser(acct(u)))!.billing!.paidThrough).toBe(addMonths(paidThrough, 12, anchor));
    const ended = await subscribed({ plan: "pro", interval: "year", paidThrough: today() });
    expect(ended.email).toBeTruthy();
    const r = await pay({ kind: "plan", plan: "starter" });
    expect(r.status).toBe(200);
  });
});
