import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { acct } from "@/lib/account-id";
import { readFileSync } from "node:fs";
import { adminSignIn, jar, json, newUser, params } from "./helpers/session";
import { getUser, saveUser, trialOver, type Plan, type User } from "@/lib/auth";
import { renewIfDue } from "@/lib/credits";
import { db } from "@/lib/db";
import { ksaDay } from "@/lib/partner-rules";
import { addDays, type Billing } from "@/lib/billing-state";
import { handPlanEnded } from "@/lib/hand-plan";
import { endHandPlanIfDue } from "@/lib/hand-plan-end";
import { entitlementView, entitlements } from "@/lib/entitlements";
import * as plan from "@/app/api/admin/plan/route";
import * as users from "@/app/api/admin/users/[email]/route";

/**
 * Founder decision 2026-10-19 (docs/system/tests/2270-money-decisions.md): a plan set by hand moves to the trial state once
 * its paid-through day has passed, instead of only losing the monthly refill (rule 1303).
 * - 2273: read at once: `trialOver` and entitlements say the trial is over from the next Riyadh day; no month restarts.
 * - 2274: the daily job writes it (`endHandPlanIfDue`): plan "trial", an ended trial, once, logged; no data deleted; an
 *   account without a paid-through day and an online subscription untouched; the founder's next set-plan restores it.
 * - 2275: no new stored field (the expand step of rule 679): only `plan` and `trialEnds` take values every build reads.
 */
const KEY = "hand-plan-end-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
beforeEach(async () => { jar().clear(); await adminSignIn(); });
afterEach(() => { vi.stubEnv("CRON_SECRET", ""); });

const today = () => ksaDay();
type Row = { action?: string; target?: string; actor?: string; what: string; before?: Record<string, unknown>; after?: Record<string, unknown> };
const rows = async (email: string, action: string) =>
  (await db.lrange("admin:log", 0, 200)).map((l) => (typeof l === "string" ? JSON.parse(l) : l) as Row).filter((r) => r.target === email && r.action === action);
const hand = (paidThrough: string) => ({ paidThrough, by: "key", at: new Date().toISOString() });
async function account(p: Plan, extra: Partial<User> = {}): Promise<User> {
  const u = await newUser("handend");
  await saveUser({ ...(await getUser(acct(u)))!, plan: p, ...extra });
  return (await getUser(acct(u)))!;
}
const paymob = (b: Partial<Billing> = {}): Billing => ({ provider: "paymob", plan: "starter", status: "active", paidThrough: today(), anchor: 1, autoRenew: false, failures: 0, txns: [], ...b });

describe("an ended hand-set plan reads as an ended trial at once (rule 2273)", () => {
  it("handPlanEnded: a paid plan past its day; not on the day, not a trial, not a subscription, not without a day", () => {
    const t = "2026-10-19";
    const ended = { plan: "pro", handPlan: hand("2026-10-18") };
    expect(handPlanEnded(ended, t)).toBe(true);
    expect(handPlanEnded({ plan: "pro", handPlan: hand(t) }, t), "paid through today: still paid").toBe(false);
    expect(handPlanEnded({ ...ended, plan: "trial" }, t), "a trial is governed by its trialEnds alone").toBe(false);
    expect(handPlanEnded({ ...ended, billing: paymob() }, t)).toBe(false);
    expect(handPlanEnded({ plan: "pro" }, t), "no paid-through day: never ends here").toBe(false);
  });
  it("trialOver, entitlements and the console's month say so from the next Riyadh day, before the daily job runs", async () => {
    const u = await account("pro", { handPlan: hand(addDays(today(), -1)), credits: 40 });
    expect(trialOver(u)).toBe(true);
    expect(entitlements(u)).toMatchObject({ active: false, inactive: "trial_over" });
    expect((await entitlementView(u)).resetsAt).toBeNull();
    const paid = await account("pro", { handPlan: hand(today()) });
    expect(trialOver(paid)).toBe(false);
    expect(entitlements(paid).active).toBe(true);
    // Its last paid day: still active, but no new period is paid, so no renewal shows (rule 2936).
    expect((await entitlementView(paid)).resetsAt).toBeNull();
    const ahead = await account("pro", { handPlan: hand(addDays(today(), 40)) });
    expect((await entitlementView(ahead)).resetsAt).not.toBeNull();
    const none = await account("pro");
    expect([trialOver(none), entitlements(none).active]).toEqual([false, true]);
  });
});

describe("the daily job moves it to the trial (rule 2274)", () => {
  it("plan trial, an ended trial, everything else kept; once; one log row", async () => {
    const day = addDays(today(), -2);
    const u = await account("pro", { handPlan: hand(day), credits: 37, deal: undefined, renewedAt: "2000-01" });
    expect(await endHandPlanIfDue(acct(u))).toBe(true);
    const after = (await getUser(acct(u)))!;
    expect(after.plan).toBe("trial");
    expect(new Date(after.trialEnds).getTime()).toBeLessThan(Date.now());
    expect(trialOver(after)).toBe(true);
    // No data deleted: the balance and the paid-through day stay, so the console still shows when it ended.
    expect(after.credits).toBe(37);
    expect(after.handPlan).toMatchObject({ paidThrough: day });
    expect(await renewIfDue(acct(u)), "a trial gets no refill").toBe(false);
    expect(await endHandPlanIfDue(acct(u)), "a second run changes nothing").toBe(false);
    const log = await rows(acct(u), "hand_plan_ended");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: "system", before: { plan: "pro", paidThrough: day, credits: 37 }, after: { plan: "trial", paidThrough: day, credits: 37 } });
  });
  it("an account without a paid-through day, one still paid, and an online subscription are never touched", async () => {
    const none = await account("pro");
    const paid = await account("business", { handPlan: hand(today()) });
    const sub = await account("starter", { billing: paymob({ paidThrough: addDays(today(), -3) }), handPlan: hand(addDays(today(), -3)) });
    expect(await Promise.all([none, paid, sub].map((u) => endHandPlanIfDue(acct(u))))).toEqual([false, false, false]);
    const after = await Promise.all([none, paid, sub].map(async (u) => (await getUser(acct(u)))!.plan));
    expect(after).toEqual(["pro", "business", "starter"]);
  });
  it("the founder can extend the trial afterwards or set a plan again, which restores it", async () => {
    const u = await account("pro", { handPlan: hand(addDays(today(), -1)) });
    await endHandPlanIfDue(acct(u));
    const ext = await users.POST(json(`/api/admin/users/${encodeURIComponent(u.email)}`, "POST", { action: "extendTrial", days: 3 }), params({ email: encodeURIComponent(u.email) }));
    expect(ext.status).toBe(200);
    expect(trialOver((await getUser(acct(u)))!), "a trial extended by hand is a live trial").toBe(false);
    const set = await plan.POST(json("/api/admin/plan", "POST", { email: u.email, plan: "pro", paidThrough: addDays(today(), 30) }));
    expect(set.status).toBe(200);
    const back = (await getUser(acct(u)))!;
    expect(back.plan).toBe("pro");
    expect(trialOver(back)).toBe(false);
  });
  it("the daily cron runs it for the account, on its default brand's entry, before the refill", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-hand-plan");
    vi.stubEnv("RESEND_API_KEY", "");
    const u = await account("pro", { handPlan: hand(addDays(today(), -1)), renewedAt: "2000-01", credits: 5 });
    const { GET } = await import("@/app/api/cron/daily/route");
    const report = (await (await GET(new Request("https://nashr.test/api/cron/daily", { headers: { authorization: "Bearer cron-secret-hand-plan" } }))).json()) as { results: Record<string, string> };
    expect(report.results[acct(u)]).toMatch(/hand_plan_ended/);
    expect(report.results[acct(u)]).not.toMatch(/renewed/);
    const after = (await getUser(acct(u)))!;
    expect([after.plan, after.credits]).toEqual(["trial", 5]);
    const src = readFileSync("src/app/api/cron/daily/route.ts", "utf8");
    expect(src.indexOf("endHandPlanIfDue(acct(u))")).toBeGreaterThan(0);
    expect(src.indexOf("endHandPlanIfDue(acct(u))")).toBeLessThan(src.indexOf("renewIfDue(acct(u))"));
  });
  it("a failing end is reported as hand_plan_failed, the plan is left for the next day's run, and the rest of the run goes on", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-hand-plan");
    vi.stubEnv("RESEND_API_KEY", "");
    const u = await account("pro", { handPlan: hand(addDays(today(), -1)), renewedAt: "2000-01", credits: 5 });
    const other = await account("pro", { renewedAt: "2000-01", credits: 5 });
    vi.resetModules();
    vi.doMock("@/lib/hand-plan-end", () => ({ endHandPlanIfDue: async () => { throw new Error("redis down"); } }));
    try {
      const { GET } = await import("@/app/api/cron/daily/route");
      const res = await GET(new Request("https://nashr.test/api/cron/daily", { headers: { authorization: "Bearer cron-secret-hand-plan" } }));
      expect(res.status).toBe(200);
      const report = (await res.json()) as { results: Record<string, string> };
      expect(report.results[acct(u)]).toMatch(/hand_plan_failed/);
      expect(report.results[acct(u)]).not.toMatch(/redis down/);
      expect((await getUser(acct(u)))!.plan, "left as it was; the gates already refuse it (rule 2273)").toBe("pro");
      expect(report.results[acct(other)], "the next account's day still runs").toMatch(/renewed/);
    } finally {
      vi.doUnmock("@/lib/hand-plan-end");
      vi.resetModules();
    }
  });
});

describe("no new stored field (rule 2275, the expand step of rule 679)", () => {
  it("the change writes only plan and trialEnds; every other field of the record is as it was", async () => {
    const u = await account("pro", { handPlan: hand(addDays(today(), -1)), credits: 9 });
    const before = (await getUser(acct(u)))!;
    await endHandPlanIfDue(acct(u));
    const after = (await getUser(acct(u)))!;
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    const strip = ({ plan: _p, trialEnds: _t, ...rest }: User) => { void _p; void _t; return rest; };
    expect(strip(after)).toEqual(strip(before));
  });
});
