import { describe, expect, it } from "vitest";
import {
  AGENCY_MIN, MAX_DEAL_CREDITS, MAX_DEAL_PRICE_SAR, ONBOARD_EXTRA_BRAND_COST, PLANS, PLAN_CREDITS, PLAN_PRICE_SAR, PLAN_SEATS, PUBLIC_TIERS,
  SELF_SERVE_PLANS, allowanceOf, dealRespectsFloor, formatCount, isPlan, onboardCost, parseDeal, planFromStore, priceOf, seatLimit,
  type AgencyDeal, type Plan,
} from "@/lib/pricing";
import * as auth from "@/lib/auth";
import { getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { monthKey, renewIfDue } from "@/lib/credits";
import { overview, usersCsv } from "@/lib/admin-stats";
import { newUser } from "./helpers/session";

/**
 * Rule 214: one plan table (src/lib/pricing.ts) and the account helpers that read it: allowanceOf, priceOf, seatLimit
 * and the stored-plan mapping. Rule 215: the monthly renewal grants allowanceOf(u), never a per-plan lookup, so an
 * Agency deal renews to its own credits and a legacy enterprise record to Business's. Rule 216 (the deal floor) is
 * pinned here at the helper level; the founder console route is in tests/admin-deal.test.ts.
 */
const deal = (credits: number, priceSar: number): AgencyDeal => ({ credits, priceSar, setAt: "2026-09-29T00:00:00.000Z", setBy: "test" });

describe("the plan table (rule 214)", () => {
  it("prices, credits and seats are the phase-1 numbers", () => {
    expect(PLAN_PRICE_SAR).toEqual({ trial: 0, starter: 299, pro: 499, business: 999 });
    expect(PLAN_CREDITS).toEqual({ trial: 50, starter: 300, pro: 700, business: 1500 });
    expect(PLAN_SEATS).toEqual({ trial: 3, starter: 1, pro: 3, business: 7 });
  });

  it("the plan list: business is in, the retired enterprise is out", () => {
    expect(PLANS).toEqual(["trial", "starter", "pro", "business", "agency"]);
    expect(SELF_SERVE_PLANS).toEqual(["starter", "pro", "business"]);
    expect(PUBLIC_TIERS).toEqual(["starter", "pro", "business", "agency"]);
    expect(isPlan("business")).toBe(true);
    expect(isPlan("agency")).toBe(true);
    expect(isPlan("enterprise")).toBe(false);
    expect(PLANS).not.toContain("enterprise");
  });

  it("a stored plan maps on read: enterprise reads as agency, anything unknown as trial", () => {
    expect(planFromStore("enterprise")).toBe("agency");
    for (const p of PLANS) expect(planFromStore(p)).toBe(p);
    for (const junk of ["gold", "AGENCY", "", "constructor", "__proto__", null, undefined, 3, {}]) expect(planFromStore(junk), String(junk)).toBe("trial");
  });

  it("auth.ts re-exports the same table, so existing @/lib/auth imports read pricing.ts", () => {
    expect(auth.PLAN_CREDITS).toBe(PLAN_CREDITS);
    expect(auth.PLAN_SEATS).toBe(PLAN_SEATS);
    expect(auth.PLANS).toBe(PLANS);
    expect(auth.isPlan).toBe(isPlan);
    expect(auth.seatLimit).toBe(seatLimit);
  });

  it("an Agency account has no fixed allowance: indexing the table by Plan does not compile", () => {
    const p: Plan = "agency";
    // @ts-expect-error PLAN_CREDITS is keyed by FixedPlan on purpose: callers must go through allowanceOf.
    expect(PLAN_CREDITS[p]).toBeUndefined();
  });

  it("the Agency floor is the Business plan, and the extra-brand setup costs 9 credits, the first brand free", () => {
    expect(AGENCY_MIN).toEqual({ priceSar: PLAN_PRICE_SAR.business, credits: PLAN_CREDITS.business });
    expect(ONBOARD_EXTRA_BRAND_COST).toBe(9);
    expect(onboardCost(undefined)).toBe(0);
    expect(onboardCost("default")).toBe(0);
    expect(onboardCost("b1a2c3")).toBe(ONBOARD_EXTRA_BRAND_COST);
    expect(formatCount(1500)).toBe("1,500");
    expect(formatCount(300)).toBe("300");
    expect([formatCount(100_000), formatCount(1_000_000), formatCount(-2500), formatCount(1234.5)]).toEqual(["100,000", "1,000,000", "-2,500", "1,234.5"]);
  });
});

describe("allowanceOf, priceOf and seatLimit (rule 214)", () => {
  it("fixed plans read the table", () => {
    for (const plan of ["trial", "starter", "pro", "business"] as const) {
      expect(allowanceOf({ plan }), plan).toBe(PLAN_CREDITS[plan]);
      expect(priceOf({ plan }), plan).toBe(PLAN_PRICE_SAR[plan]);
      expect(seatLimit({ plan }), plan).toBe(PLAN_SEATS[plan]);
    }
  });

  it("agency without a deal behaves like Business: 1,500 credits, 999 SAR, 7 seats", () => {
    expect([allowanceOf({ plan: "agency" }), priceOf({ plan: "agency" }), seatLimit({ plan: "agency" })]).toEqual([1500, 999, 7]);
    expect([allowanceOf({ plan: "agency", deal: null }), priceOf({ plan: "agency", deal: null })]).toEqual([1500, 999]);
  });

  it("agency with a deal at or above the floor gets the deal", () => {
    expect(allowanceOf({ plan: "agency", deal: deal(3003, 2000) })).toBe(3003);
    expect(priceOf({ plan: "agency", deal: deal(3003, 2000) })).toBe(2000);
    expect(allowanceOf({ plan: "agency", deal: deal(1500, 999) })).toBe(1500);
  });

  it("a stored deal below the floor, or a malformed one, falls back to Business", () => {
    for (const d of [deal(3004, 2000), deal(1501, 999), deal(1500, 998), deal(1.5, 999), deal(NaN, 5000), { credits: "3000", priceSar: "2000" } as unknown as AgencyDeal]) {
      expect(allowanceOf({ plan: "agency", deal: d }), JSON.stringify(d)).toBe(1500);
      expect(priceOf({ plan: "agency", deal: d }), JSON.stringify(d)).toBe(999);
    }
  });

  it("a deal left on a non-agency plan is ignored", () => {
    expect(allowanceOf({ plan: "pro", deal: deal(5000, 5000) })).toBe(700);
    expect(priceOf({ plan: "pro", deal: deal(5000, 5000) })).toBe(499);
  });

  it("the founder's seat override wins when it is a positive number (floored); anything else falls back to the plan", () => {
    expect(seatLimit({ plan: "starter", seats: 12 })).toBe(12);
    expect(seatLimit({ plan: "agency", seats: 25.9 })).toBe(25);
    for (const seats of [0, -1, NaN, Infinity, 0.5]) expect(seatLimit({ plan: "pro", seats }), String(seats)).toBe(PLAN_SEATS.pro);
  });

  it("an unknown plan grants nothing and counts nothing, never NaN; a legacy enterprise record reads as agency", () => {
    const junk = { plan: "gold" as Plan };
    expect([allowanceOf(junk), priceOf(junk), seatLimit(junk)]).toEqual([0, 0, 1]);
    const legacy = { plan: "enterprise" as Plan };
    expect([allowanceOf(legacy), priceOf(legacy), seatLimit(legacy)]).toEqual([1500, 999, 7]);
  });
});

describe("the Agency deal floor (rule 216)", () => {
  it("dealRespectsFloor: integers only, at or above 999 SAR and 1,500 credits and the Business rate", () => {
    expect(dealRespectsFloor(999, 1500)).toBe(true);
    expect(dealRespectsFloor(2000, 3003)).toBe(true);
    expect(dealRespectsFloor(MAX_DEAL_PRICE_SAR, MAX_DEAL_CREDITS)).toBe(true);
    for (const [p, c] of [[998, 1500], [999, 1501], [2000, 3004], [1.5, 1500], [999, 1500.5], [-1, 1500], [999, -1], [Infinity, 1500], [999, Infinity], [NaN, 1500], [MAX_DEAL_PRICE_SAR, MAX_DEAL_CREDITS + 1], [MAX_DEAL_PRICE_SAR + 1, 1500]]) {
      expect(dealRespectsFloor(p, c), `${p}/${c}`).toBe(false);
    }
    expect(dealRespectsFloor("999" as unknown as number, 1500)).toBe(false);
  });

  it("parseDeal: malformed is bad_deal, well-formed below the Business rate is below_floor", () => {
    expect(parseDeal({ credits: 1500, priceSar: 999 })).toEqual({ ok: true, deal: { credits: 1500, priceSar: 999 } });
    expect(parseDeal({ credits: 3003, priceSar: 2000, seats: 12, setBy: "attacker" })).toEqual({ ok: true, deal: { credits: 3003, priceSar: 2000 } });
    for (const raw of [null, undefined, "1500@999", 1500, [1500, 999], {}, { credits: 1500 }, { credits: 1.5, priceSar: 999 }, { credits: "1500", priceSar: 999 }, { credits: 1500, priceSar: -1 }, { credits: Infinity, priceSar: 999 }, { credits: MAX_DEAL_CREDITS + 1, priceSar: MAX_DEAL_PRICE_SAR }, { credits: 0, priceSar: 999 }]) {
      expect(parseDeal(raw), JSON.stringify(raw) ?? String(raw)).toEqual({ ok: false, error: "bad_deal" });
    }
    for (const raw of [{ credits: 1500, priceSar: 998 }, { credits: 1501, priceSar: 999 }, { credits: 3004, priceSar: 2000 }, { credits: 1000, priceSar: 999 }]) {
      expect(parseDeal(raw), JSON.stringify(raw)).toEqual({ ok: false, error: "below_floor" });
    }
  });
});

describe("renewal grants allowanceOf (rule 215)", () => {
  const due = async (over: Partial<User>) => {
    const u = await newUser("renew");
    await saveUser({ ...u, credits: 3, renewedAt: "2020-01", ...over });
    return u.email;
  };

  it("business renews to 1,500 and an agency deal to the deal's credits", async () => {
    const business = await due({ plan: "business" });
    expect(await renewIfDue(business)).toBe(true);
    expect((await getUser(business))!).toMatchObject({ credits: 1500, renewedAt: monthKey() });

    const agency = await due({ plan: "agency", deal: deal(3003, 2000) });
    expect(await renewIfDue(agency)).toBe(true);
    expect((await getUser(agency))!.credits).toBe(3003);

    const noDeal = await due({ plan: "agency" });
    expect(await renewIfDue(noDeal)).toBe(true);
    expect((await getUser(noDeal))!.credits).toBe(1500);

    const belowFloor = await due({ plan: "agency", deal: deal(9000, 999) });
    expect(await renewIfDue(belowFloor)).toBe(true);
    expect((await getUser(belowFloor))!.credits, "a deal below the floor renews as Business").toBe(1500);
  });

  it("a legacy enterprise record reads as agency through getUser, renews to 1,500 and is written back as agency", async () => {
    const u = await newUser("legacy");
    await db.set(`user:${u.email}`, { ...u, plan: "enterprise", credits: 10000, renewedAt: "2020-01" });
    const read = (await getUser(u.email))!;
    expect(read.plan).toBe("agency");
    expect(seatLimit(read)).toBe(7);
    expect(await renewIfDue(u.email)).toBe(true);
    expect((await getUser(u.email))!.credits).toBe(1500);
    expect((await db.get<{ plan: string }>(`user:${u.email}`))!.plan, "the locked save writes the mapped plan").toBe("agency");
  });

  it("an unknown stored plan reads as trial and never renews", async () => {
    const u = await newUser("junkplan");
    await db.set(`user:${u.email}`, { ...u, plan: "gold", credits: 7, renewedAt: "2020-01" });
    expect((await getUser(u.email))!.plan).toBe("trial");
    expect(await renewIfDue(u.email)).toBe(false);
    expect((await getUser(u.email))!.credits).toBe(7);
  });

  it("a trial never renews, and a paid plan renews once a month", async () => {
    const trial = await due({ plan: "trial" });
    expect(await renewIfDue(trial)).toBe(false);
    expect((await getUser(trial))!.credits).toBe(3);
    const pro = await due({ plan: "pro" });
    expect(await renewIfDue(pro)).toBe(true);
    expect(await renewIfDue(pro)).toBe(false);
    expect((await getUser(pro))!.credits).toBe(700);
  });
});

describe("founder reporting reads priceOf (rules 214-215)", () => {
  it("MRR counts an Agency deal at its price and skips suspended accounts", async () => {
    const before = await overview();
    const agency = await newUser("mrr");
    await saveUser({ ...agency, plan: "agency", deal: deal(3003, 2000) });
    const suspended = await newUser("mrr");
    await saveUser({ ...suspended, plan: "business", suspended: true });
    const plain = await newUser("mrr");
    await saveUser({ ...plain, plan: "agency" });
    const after = await overview();
    expect(after.revenue.mrrSar - before.revenue.mrrSar).toBe(2000 + PLAN_PRICE_SAR.business);
    expect(after.users.paying - before.users.paying, "a suspended account is not paying").toBe(2);
    expect(after.revenue.planMix.enterprise).toBeUndefined();
  });

  it("the users CSV carries price, credits, seats and deal columns, every cell through csvSafe", () => {
    const base = { name: "Test", phone: "", credits: 10, trialEnds: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" };
    const csv = usersCsv([
      { ...base, email: "a@test.example", plan: "agency", deal: deal(3003, 2000), seats: 12 },
      { ...base, email: "b@test.example", plan: "business", name: "=HYPERLINK(\"http://x\")" },
      { ...base, email: "c@test.example", plan: "agency" },
    ]);
    const [head, a, b, c] = csv.split("\n");
    expect(head).toBe("email,name,phone,plan,credits,trial_ends,created_at,renewed_at,monthly_price_sar,monthly_credits,seats,deal");
    expect(a).toBe('"a@test.example","Test","","agency","10","2026-10-01","2026-09-01","","2000","3003","12","3003@2000"');
    expect(b).toBe('"b@test.example","\'=HYPERLINK(""http://x"")","","business","10","2026-10-01","2026-09-01","","999","1500","7",""');
    expect(c).toBe('"c@test.example","Test","","agency","10","2026-10-01","2026-09-01","","999","1500","7",""');
  });
});
