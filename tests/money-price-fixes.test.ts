import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { adminSignIn, jar, json, newUser } from "./helpers/session";
import { getUser, saveUser, type Plan, type User } from "@/lib/auth";
import { monthKey, renewIfDue, renewalDue } from "@/lib/credits";
import { db } from "@/lib/db";
import { ksaDay } from "@/lib/partner-rules";
import { addDays, addMonths, type Billing } from "@/lib/billing-state";
import { HAND_PAID_MAX_DAYS, defaultPaidThrough, handPlanEnded, parsePaidThrough } from "@/lib/hand-plan";
import { PLAN_CREDITS } from "@/lib/pricing";
import { dict } from "@/lib/i18n";
import * as plan from "@/app/api/admin/plan/route";

/**
 * 2026-10-12 money and price-copy batch (docs/system/tests/1240-money-price-fixes.md). Rules 1242-1244: a plan set by
 * hand carries the Riyadh day it is paid through (`User.handPlan`, an expand per rule 679), the monthly refill stops
 * after it, and each refill of a hand-set plan leaves a row in the founder's log. Rules 1247-1248: the yearly line is
 * gone and Razan's card says what the pricing line says about VAT. The refund rules (1240, 1241) and rule 1245 are in
 * tests/paymob.test.ts, the empty generation (1246) in tests/generate-batch.test.ts.
 */
const KEY = "money-fixes-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
beforeEach(async () => { jar().clear(); await adminSignIn(); });

const call = (email: string, body: Record<string, unknown>) => plan.POST(json("/api/admin/plan", "POST", { email, ...body }));
type Row = { action?: string; target?: string; actor?: string; what: string; before?: Record<string, unknown>; after?: Record<string, unknown> };
const rows = async (email: string, action: string) =>
  (await db.lrange("admin:log", 0, 200)).map((l) => (typeof l === "string" ? JSON.parse(l) : l) as Row).filter((r) => r.target === email && r.action === action);
async function account(p: Plan, extra: Partial<User> = {}): Promise<User> {
  const u = await newUser("hand");
  await saveUser({ ...(await getUser(u.email))!, plan: p, ...extra });
  return (await getUser(u.email))!;
}
const today = () => ksaDay();
const paymob = (b: Partial<Billing> = {}): Billing => ({ provider: "paymob", plan: "starter", status: "active", paidThrough: today(), anchor: 1, autoRenew: false, failures: 0, txns: [], ...b });

describe("the paid-through day is checked in code (rule 1242)", () => {
  it("parsePaidThrough takes a real day from today to 400 days ahead and nothing else", () => {
    const t = "2026-10-12";
    expect(parsePaidThrough(t, t)).toEqual({ ok: true, day: t });
    expect(parsePaidThrough(addDays(t, HAND_PAID_MAX_DAYS), t)).toEqual({ ok: true, day: addDays(t, HAND_PAID_MAX_DAYS) });
    for (const bad of [addDays(t, -1), addDays(t, HAND_PAID_MAX_DAYS + 1), "2026-02-30", "2026-10-1", "12/11/2026", 20261112, null, undefined, ""]) {
      expect(parsePaidThrough(bad, t), String(bad)).toEqual({ ok: false });
    }
    expect(defaultPaidThrough(t)).toBe(addMonths(t, 1));
  });

  it("a paid plan set by hand gets one month from today, or the day sent; the log and the answer carry it", async () => {
    const a = await account("trial");
    const r = await call(a.email, { plan: "pro" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { user: { paidThrough: string } }).user.paidThrough).toBe(defaultPaidThrough(today()));
    const stored = (await getUser(a.email))!.handPlan!;
    expect(stored.paidThrough).toBe(defaultPaidThrough(today()));
    expect(stored.by).toEqual(expect.any(String));
    expect(Date.parse(stored.at)).not.toBeNaN();
    const log = (await rows(a.email, "plan"))[0];
    expect(log.what).toContain(`paid_through:${defaultPaidThrough(today())}`);
    expect(log.before).toMatchObject({ paidThrough: null });
    expect(log.after).toMatchObject({ paidThrough: defaultPaidThrough(today()) });

    const b = await account("trial");
    const day = addDays(today(), 90);
    expect((await call(b.email, { plan: "business", paidThrough: day })).status).toBe(200);
    expect((await getUser(b.email))!.handPlan!.paidThrough).toBe(day);
  });

  it("a bad day is refused before the account is read and writes nothing", async () => {
    const u = await account("starter");
    const logged = (await db.lrange("admin:log", 0, -1)).length;
    for (const bad of ["2026-02-30", addDays(today(), -1), addDays(today(), HAND_PAID_MAX_DAYS + 1), 5, "soon"]) {
      const r = await call(u.email, { plan: "pro", paidThrough: bad });
      expect(r.status, String(bad)).toBe(400);
      expect(await r.json()).toMatchObject({ error: "bad_paid_through" });
    }
    expect((await call(`nobody-${Date.now()}@example.com`, { paidThrough: "soon" })).status).toBe(400);
    const after = (await getUser(u.email))!;
    expect(after.plan).toBe("starter");
    expect(after.handPlan).toBeUndefined();
    expect((await db.lrange("admin:log", 0, -1)).length).toBe(logged);
  });

  it("alone it moves the day of a hand-set plan; null removes it; a trial and an online subscription refuse it", async () => {
    const u = await account("trial");
    await call(u.email, { plan: "pro" });
    const later = addDays(today(), 45);
    expect((await call(u.email, { paidThrough: later })).status).toBe(200);
    expect((await getUser(u.email))!).toMatchObject({ plan: "pro", handPlan: { paidThrough: later } });
    expect((await call(u.email, { paidThrough: null })).status).toBe(200);
    expect((await getUser(u.email))!.handPlan).toBeUndefined();
    expect((await rows(u.email, "plan"))[0].what).toContain("paid_through:none");

    const t = await account("trial");
    const r = await call(t.email, { paidThrough: later });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "paid_through_needs_plan" });

    const p = await account("starter", { billing: paymob() });
    const q = await call(p.email, { paidThrough: later });
    expect(q.status).toBe(409);
    expect(await q.json()).toMatchObject({ error: "paid_through_paymob" });
    expect((await getUser(p.email))!.billing).toMatchObject({ provider: "paymob" });
  });

  it("back to the trial removes the day; a plan set with null keeps the old no-end refill", async () => {
    const u = await account("trial");
    await call(u.email, { plan: "pro" });
    expect((await call(u.email, { plan: "trial" })).status).toBe(200);
    expect((await getUser(u.email))!.handPlan).toBeUndefined();
    expect((await call(u.email, { plan: "starter", paidThrough: null })).status).toBe(200);
    expect((await getUser(u.email))!.handPlan).toBeUndefined();
  });
});

describe("the monthly refill stops after the paid-through day (rule 1243)", () => {
  const base = { plan: "pro" as Plan, renewedAt: "2000-01", createdAt: "2000-01-01T00:00:00.000Z" };
  it("renewalDue: on or before the day it refills, after it not; no handPlan is the old shape and refills", () => {
    const t = "2026-10-12";
    expect(renewalDue({ ...base, handPlan: { paidThrough: t, by: "key", at: "" } }, "2026-10", t)).toBe(true);
    expect(renewalDue({ ...base, handPlan: { paidThrough: addDays(t, -1), by: "key", at: "" } }, "2026-10", t)).toBe(false);
    expect(renewalDue(base, "2026-10", t)).toBe(true);
    // A Paymob subscription has its own day: a stray handPlan on it decides nothing.
    expect(handPlanEnded({ billing: paymob({ paidThrough: t }), handPlan: { paidThrough: "2000-01-01", by: "key", at: "" } }, t)).toBe(false);
    expect(handPlanEnded({ handPlan: { paidThrough: "not-a-day", by: "key", at: "" } }, t)).toBe(false);
  });

  it("renewIfDue gives nothing after the day and keeps the balance", async () => {
    const u = await account("pro", { renewedAt: "2000-01", credits: 7, handPlan: { paidThrough: addDays(today(), -1), by: "key", at: new Date().toISOString() } });
    expect(await renewIfDue(u.email)).toBe(false);
    expect((await getUser(u.email))!).toMatchObject({ credits: 7, renewedAt: "2000-01" });
    expect(await rows(u.email, "hand_refill")).toHaveLength(0);
  });
});

describe("each refill of a hand-set plan is logged (rule 1244)", () => {
  it("a hand-set plan's refill writes one hand_refill row with the balance before and after and the day", async () => {
    const day = addDays(today(), 20);
    const u = await account("pro", { renewedAt: "2000-01", credits: 7, handPlan: { paidThrough: day, by: "key", at: new Date().toISOString() } });
    expect(await renewIfDue(u.email)).toBe(true);
    expect(await renewIfDue(u.email)).toBe(false);
    expect((await getUser(u.email))!).toMatchObject({ credits: PLAN_CREDITS.pro, renewedAt: monthKey() });
    const log = await rows(u.email, "hand_refill");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: "system", before: { credits: 7 }, after: { credits: PLAN_CREDITS.pro, paidThrough: day } });
    expect(log[0].what).toBe(`hand_refill plan:pro month:${monthKey()} credits:${PLAN_CREDITS.pro} paid_through:${day}`);
  });

  it("an old hand-set plan (no day) is logged with none; a Paymob month has its payment and no row", async () => {
    const old = await account("starter", { renewedAt: "2000-01" });
    expect(await renewIfDue(old.email)).toBe(true);
    expect((await rows(old.email, "hand_refill"))[0].what).toContain("paid_through:none");

    const paid = await account("starter", { renewedAt: "2000-01", billing: paymob({ paidThrough: addDays(today(), 3), autoRenew: true }) });
    expect(await renewIfDue(paid.email)).toBe(true);
    expect(await rows(paid.email, "hand_refill")).toHaveLength(0);
  });
});

describe("price copy (rules 1247, 1248)", () => {
  const i18n = readFileSync("src/lib/i18n.ts", "utf8");
  const pricing = readFileSync("src/components/Pricing.tsx", "utf8");
  it("the yearly line is gone in both languages and from the pricing card", () => {
    for (const s of ["ووفّر شهرين", "ادفع سنوياً", "two months free", "Pay yearly"]) expect(i18n, s).not.toContain(s);
    expect(i18n).not.toMatch(/\bannual:\s*["']/);
    expect(pricing).not.toContain("p.annual");
  });
  it("Razan's card says excluding VAT, the same words as the pricing line, in both languages", () => {
    const razan = (l: "ar" | "en") => dict[l].agents.items.find((a) => a.name === (l === "ar" ? "رزان" : "Razan"))!.body;
    expect(dict.ar.pricing.sub).toContain("الأسعار بالريال السعودي غير شاملة الضريبة");
    expect(razan("ar")).toContain("الأسعار بالريال السعودي غير شاملة الضريبة");
    expect(razan("ar")).not.toContain("شامل الضريبة");
    expect(dict.en.pricing.sub).toContain("Prices in Saudi riyals, excluding VAT");
    expect(razan("en")).toContain("Prices in Saudi riyals, excluding VAT");
    expect(razan("en")).not.toMatch(/with VAT|including VAT|incl\. VAT|VAT in mind/i);
  });
});
