import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { adminSignIn, jar, json, newUser } from "./helpers/session";
import { getUser, saveUser, type Plan, type User } from "@/lib/auth";
import { anchorOf, monthKey, renewIfDue } from "@/lib/credits";
import { ksaDay } from "@/lib/partner-rules";
import { addDays, addMonths, type Billing } from "@/lib/billing-state";
import { creditsResetOn, lastRenewal, nextRenewal, renewDay, renewalDue, type RenewalRecord } from "@/lib/renewal";
import * as plan from "@/app/api/admin/plan/route";

/**
 * Rule 2936 (money review F2, founder decision 2026-10-22): a paid plan's monthly allowance renews on the plan's own
 * paid-period day, not on the 1st. A plan set on the 20th got its allowance that day and again on the 1st, eleven days
 * later; now it renews on the 20th, and only once that next period is paid. Expand step (rule 679): `renewedOn` and
 * `renewAnchor` are new optional fields beside `renewedAt`; a record with only `renewedAt` keeps the 1st.
 */
const KEY = "renewal-anchor-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
beforeEach(async () => { jar().clear(); await adminSignIn(); });

const CREATED = "2026-01-05T00:00:00.000Z";
const hand = (paidThrough: string) => ({ paidThrough, by: "key", at: "2026-10-20T00:00:00.000Z" });
const paymob = (b: Partial<Billing> = {}): Billing => ({ provider: "paymob", plan: "pro", status: "active", paidThrough: "2026-11-15", anchor: 15, autoRenew: true, failures: 0, txns: [], ...b });
const rec = (r: Partial<RenewalRecord>): RenewalRecord => ({ plan: "pro", createdAt: CREATED, ...r });

describe("the allowance renews on the plan's own day (rule 2936)", () => {
  it("a plan set by hand on the 20th is not renewed on the 1st, and renews on the 20th once that month is paid", () => {
    const set = rec({ renewedOn: "2026-10-20", renewAnchor: 20, handPlan: hand("2026-11-20") });
    expect(renewDay(set)).toBe(20);
    expect(nextRenewal(set, "2026-11-01")).toBe("2026-11-20");
    expect(renewalDue(set, "2026-11-01"), "the 1st gives nothing").toBe(false);
    expect(renewalDue(set, "2026-11-19")).toBe(false);
    // The default paid-through day is one month: the last paid day starts no new month.
    expect(renewalDue(set, "2026-11-20"), "the last paid day is not a new period").toBe(false);
    expect(creditsResetOn(set, "2026-11-01")).toBeNull();
    // The founder extends it a month: the 20th renews.
    const paid = { ...set, handPlan: hand("2026-12-20") };
    expect(renewalDue(paid, "2026-11-19")).toBe(false);
    expect(renewalDue(paid, "2026-11-20")).toBe(true);
    expect(creditsResetOn(paid, "2026-11-01")).toBe("2026-11-20");
  });

  it("a Paymob subscription renews on its anchor, after the charge has moved its paid-through day", () => {
    const sub = rec({ renewedOn: "2026-10-15", billing: paymob() });
    expect(renewDay({ ...sub, renewAnchor: 3 }), "the subscription's own anchor wins").toBe(15);
    expect(renewalDue(sub, "2026-11-01")).toBe(false);
    expect(renewalDue(sub, "2026-11-15"), "the charge is not in yet").toBe(false);
    expect(creditsResetOn(sub, "2026-11-01"), "the screens show the anchor day").toBe("2026-11-15");
    const charged = { ...sub, billing: paymob({ paidThrough: "2026-12-15" }) };
    expect(renewalDue(charged, "2026-11-15")).toBe(true);
    // A locked subscription never renews and shows no day.
    const locked = { ...charged, billing: paymob({ status: "locked", paidThrough: "2026-11-15" }) };
    expect(renewalDue(locked, "2026-11-20")).toBe(false);
    expect(creditsResetOn(locked, "2026-11-20")).toBeNull();
  });

  it("a record with only `renewedAt` and no day of its own keeps the 1st (the old shape)", () => {
    const old = rec({ renewedAt: "2026-10" });
    expect(renewDay(old)).toBe(1);
    expect(lastRenewal(old, "2026-10-31")).toBe("2026-10-01");
    expect(renewalDue(old, "2026-10-31")).toBe(false);
    expect(renewalDue(old, "2026-11-01")).toBe(true);
    // Never renewed: the month it was created.
    expect(renewalDue(rec({}), "2026-01-31")).toBe(false);
    expect(renewalDue(rec({}), "2026-02-01")).toBe(true);
    // A trial never renews.
    expect(renewalDue(rec({ plan: "trial", renewedAt: "2020-01" }), "2026-11-01")).toBe(false);
  });

  it("an old record renewed on the 1st whose day is still ahead counts from the day before it: no month without an allowance", () => {
    // Set by hand on the 20th of September; the old rule refilled it on 1 October (renewedAt 2026-10).
    const old = rec({ renewedAt: "2026-10", handPlan: hand("2026-12-20") });
    expect(renewDay(old)).toBe(20);
    expect(lastRenewal(old, "2026-10-05")).toBe("2026-09-20");
    expect(lastRenewal(old, "2026-10-25"), "stable: it does not move with today").toBe("2026-09-20");
    expect(renewalDue(old, "2026-10-05")).toBe(false);
    expect(renewalDue(old, "2026-10-20")).toBe(true);
    expect(renewalDue(old, "2026-10-25"), "a day already passed renews on the next request").toBe(true);
  });

  it("the 31st holds in short months: February takes its last day and March goes back to the 31st", () => {
    const jan = rec({ renewedOn: "2027-01-31", renewAnchor: 31 });
    expect(nextRenewal(jan, "2027-02-01")).toBe("2027-02-28");
    expect(renewalDue(jan, "2027-02-27")).toBe(false);
    expect(renewalDue(jan, "2027-02-28")).toBe(true);
    expect(nextRenewal({ ...jan, renewedOn: "2027-02-28" }, "2027-03-01")).toBe("2027-03-31");
  });

  it("a late renewal keeps the plan's day: renewed on the 25th, the next is still the 20th", () => {
    const late = rec({ renewedOn: "2026-11-25", renewAnchor: 20 });
    expect(nextRenewal(late, "2026-11-26")).toBe("2026-12-20");
    expect(creditsResetOn(rec({ renewedOn: "2026-08-20", renewAnchor: 20 }), "2026-10-08"), "already due reads as today").toBe("2026-10-08");
  });
});

describe("the stored day is written where a period starts (rule 2936)", () => {
  async function account(p: Plan, extra: Partial<User> = {}): Promise<User> {
    const u = await newUser("renewanchor");
    await saveUser({ ...(await getUser(u.email))!, plan: p, ...extra });
    return (await getUser(u.email))!;
  }
  const call = (email: string, body: Record<string, unknown>) => plan.POST(json("/api/admin/plan", "POST", { email, ...body }));

  it("the founder's set-plan stores today as the renewal and its day as the plan's day; nothing renews on the next 1st", async () => {
    const u = await account("trial");
    expect((await call(u.email, { plan: "pro" })).status).toBe(200);
    const after = (await getUser(u.email))!;
    const today = ksaDay();
    expect(after).toMatchObject({ renewedOn: today, renewAnchor: anchorOf(today), renewedAt: monthKey() });
    expect(await renewIfDue(u.email)).toBe(false);
    expect(renewalDue(after, addMonths(today.slice(0, 7) + "-01", 1)), "the next 1st gives nothing").toBe(false);
  });

  it("renewIfDue writes the day and the month, once", async () => {
    const today = ksaDay();
    const u = await account("pro", { credits: 3, renewedAt: "2000-01", renewedOn: addMonths(today, -1), renewAnchor: anchorOf(today), handPlan: { paidThrough: addDays(today, 40), by: "key", at: new Date().toISOString() } });
    expect(await renewIfDue(u.email)).toBe(true);
    expect((await getUser(u.email))!).toMatchObject({ renewedOn: today, renewedAt: monthKey() });
    expect(await renewIfDue(u.email)).toBe(false);
  });

  it("an online plan payment stores the day it starts", () => {
    const src = readFileSync("src/lib/billing.ts", "utf8");
    expect(src).toMatch(/setMonthly\(u, allowanceOf\(u\)\);\s*u\.renewedAt = monthKey\(\);[^]{0,200}?u\.renewedOn = today;/);
  });
});
