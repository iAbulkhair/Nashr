import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { json, newUser, signIn } from "./helpers/session";
import { getUser, saveUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { dict } from "@/lib/i18n";
import {
  PLAN_CREDITS, PLAN_PRICE_SAR, PLAN_YEARLY_MONTHS_FREE, PLAN_YEARLY_PRICE_SAR, PRICES_INCLUDE_VAT, SELF_SERVE_PLANS,
  anyYearlyOffered, cheapestCreditUsd, priceOf, readInterval, yearlyOffered, yearlyPriceSar,
} from "@/lib/pricing";
import { billingInterval, billingMonths, type Billing } from "@/lib/billing-state";
import { lastCheckoutKey, priceFor } from "@/lib/billing";
import Pricing from "@/components/Pricing";
import * as checkout from "@/app/api/billing/checkout/route";

/**
 * Yearly billing at the founder's price (rules 3530-3532, 3537-3538, 4035; docs/system/tests/3530-yearly-pricing.md and
 * 4030-yearly-floor.md). On 2026-10-24 the founder set 2 months free on every self-serve plan: 2,990 / 4,990 / 9,990 SAR
 * a year before VAT. This file pins those values; tests/yearly-pricing-on.test.ts proves the switch, totals and renewals
 * with its own test-only table.
 */

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/pricing",
  useSearchParams: () => new URLSearchParams(),
}));

const ENV = {
  PAYMOB_SECRET_KEY: "sk_test_fake_secret_for_unit_tests",
  PAYMOB_PUBLIC_KEY: "pk_test_fake_public_for_unit_tests",
  PAYMOB_HMAC_SECRET: "fake-hmac-secret-for-unit-tests",
  PAYMOB_INTEGRATION_ID_CARD: "111111",
};
let fetched = 0;
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetched = 0;
  vi.stubGlobal("fetch", async () => { fetched++; return Response.json({}, { status: 500 }); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const pay = (body: Record<string, unknown>) => checkout.POST(json("/api/billing/checkout", "POST", body));
async function owner() {
  const u = await newUser("yr0");
  await saveUser({ ...(await getUser(u.email))!, phone: "+966500000123" });
  await signIn(u.email);
  return (await getUser(u.email))!;
}

describe("the tripwire: the founder's yearly price, 2 months free on every plan (rules 3530, 4035)", () => {
  it("every plan gives 2 months free and no set price, so yearly is offered for all three at 10 months' price", () => {
    // Changing a yearly price is the founder's decision: update this test in the same commit (pricing.ts FOUNDER note).
    expect(PLAN_YEARLY_PRICE_SAR).toEqual({ starter: null, pro: null, business: null });
    expect(PLAN_YEARLY_MONTHS_FREE).toEqual({ starter: 2, pro: 2, business: 2 });
    expect(SELF_SERVE_PLANS.map((p) => yearlyPriceSar(p))).toEqual([2990, 4990, 9990]);
    for (const p of SELF_SERVE_PLANS) {
      expect(yearlyPriceSar(p)).toBe(PLAN_PRICE_SAR[p] * 10);
      expect(yearlyOffered(p)).toBe(true);
    }
    expect(anyYearlyOffered()).toBe(true);
  });

  it("the plan list is the monthly one it always was, in both languages", () => {
    const rows = (lang: "ar" | "en") => dict[lang].pricing.plans.map((p) => ({ id: p.id, price: p.price, period: p.period, note: p.note }));
    expect(rows("en")).toEqual([
      { id: "starter", price: "299", period: "SAR / month", note: undefined },
      { id: "pro", price: "499", period: "SAR / month", note: undefined },
      { id: "business", price: "999", period: "SAR / month", note: undefined },
      { id: "agency", price: "Contact us", period: "annual billing", note: undefined },
    ]);
    expect(rows("ar")).toEqual([
      { id: "starter", price: "299", period: "ريال / شهر", note: undefined },
      { id: "pro", price: "499", period: "ريال / شهر", note: undefined },
      { id: "business", price: "999", period: "ريال / شهر", note: undefined },
      { id: "agency", price: "تواصل معنا", period: "فوترة سنوية", note: undefined },
    ]);
  });

  it("the pricing section draws the monthly/yearly switch, monthly shown first, the yearly prices in its hidden panel", () => {
    for (const lang of ["ar", "en"] as const) {
      const html = renderToStaticMarkup(h(Pricing, { t: dict[lang], lang, headingLevel: 1 }));
      expect(html).toContain("data-interval-switch");
      expect(html).toMatch(/hidden=""[^>]*data-interval-panel="year"/);
      const yearly = html.split('data-interval-panel="year"')[1];
      for (const price of ["2,990", "4,990", "9,990"]) expect(yearly, lang).toContain(price);
    }
  });
});

describe("checkout prices a year at the founder's price (rules 3531-3532, 4035)", () => {
  it("priceFor prices a year at 10 months plus VAT; the monthly price is unchanged", () => {
    for (const p of SELF_SERVE_PLANS) {
      const year = PLAN_PRICE_SAR[p] * 10 * 100;
      expect(priceFor("plan", { plan: p, interval: "year" })).toEqual({ baseHalalas: year, vatHalalas: Math.round(year * 0.15), amountCents: year + Math.round(year * 0.15) });
      const base = PLAN_PRICE_SAR[p] * 100;
      expect(priceFor("plan", { plan: p })).toEqual({ baseHalalas: base, vatHalalas: Math.round(base * 0.15), amountCents: base + Math.round(base * 0.15) });
      expect(priceFor("plan", { plan: p, interval: "month" })).toEqual(priceFor("plan", { plan: p }));
    }
    expect(priceFor("plan", { plan: "starter", interval: "week" })).toBeNull();
    expect(priceFor("topup", { credits: 100, interval: "year" })).toBeNull();
  });

  it("an interval that is neither month nor year, or any interval on a pack, is 400 bad_interval", async () => {
    await owner();
    for (const body of [{ kind: "plan", plan: "pro", interval: "week" }, { kind: "plan", plan: "pro", interval: 12 }, { kind: "topup", credits: 100, interval: "year" }]) {
      const r = await pay(body);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ error: "bad_interval" });
    }
    expect(fetched).toBe(0);
  });
});

describe("old records and the money floor are unchanged (rules 3533, 3537-3538)", () => {
  it("a stored record or intent without an interval reads as monthly", () => {
    expect(readInterval(undefined)).toBe("month");
    expect(readInterval(null)).toBe("month");
    expect(readInterval("month")).toBe("month");
    expect(readInterval("year")).toBe("year");
    expect(readInterval("yearly")).toBeNull();
    const old: Billing = { provider: "paymob", plan: "pro", status: "active", paidThrough: "2026-11-01", anchor: 1, autoRenew: true, failures: 0, txns: [] };
    expect(billingInterval(old)).toBe("month");
    expect(billingMonths(old)).toBe(1);
    expect(billingInterval(undefined)).toBe("month");
  });

  it("MRR counts a yearly record at its yearly price per month, a monthly record at the monthly price", () => {
    expect(priceOf({ plan: "pro" })).toBe(499);
    expect(priceOf({ plan: "pro", billing: { interval: "year" } })).toBe(415.83);
    expect(priceOf({ plan: "business", billing: { interval: "year" } })).toBe(832.5);
  });

  it("the margin floor now counts Business yearly, the cheapest credit: $0.148, down from $0.1776 monthly", () => {
    const monthlyOnly = cheapestCreditUsd(PLAN_PRICE_SAR, PLAN_CREDITS, PRICES_INCLUDE_VAT, { starter: null, pro: null, business: null });
    expect(monthlyOnly).toBeCloseTo(0.1776, 6);
    expect(cheapestCreditUsd()).toBeCloseTo(0.148, 6);
  });
});
