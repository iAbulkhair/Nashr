import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getUser, saveUser, type Plan, type User } from "@/lib/auth";
import { addTopup, adjust, charge, chargeOnboard, monthKey, refund, refundOnboard, renewIfDue, saveSettledTopups, settleChatOverflow, voidTopup, type AgentCharge, type TopupInput } from "@/lib/credits";
import { db } from "@/lib/db";
import { PLAN_CREDITS, SAR_PER_USD, TOPUP_PACKS, TOPUP_SAR_PER_CREDIT, TOPUP_VALID_DAYS, cheapestCreditUsd, isTopupPack, priceOf, topupPriceSar, topupsSold, type Plan as PricingPlan } from "@/lib/pricing";
import { ksaDay } from "@/lib/partner-rules";
import { MAX_LIVE_TOPUPS, NO_CREDITS_HINT, TOPUP_VALID_MS, lotsOf, monthlyCredits, parseTopup, returnCredits, settleTopups, spendCredits, topupCredits, topupRevenueSar, type TopupLot } from "@/lib/topups";
import { overview } from "@/lib/admin-stats";
import { appDict } from "@/lib/app-i18n";
import { limitText } from "@/components/app/LimitModal";
import { refusalText } from "@/lib/chat-allowance";
import { adminSignIn, jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import * as topupsRoute from "@/app/api/admin/topups/route";
import * as planRoute from "@/app/api/admin/plan/route";
import BillingPage from "@/app/[lang]/app/billing/page";
import * as profileRoute from "@/app/api/profile/route";
import { adminConsoleSrc } from "./helpers/admin-console";

/**
 * Credit top-ups (pricing spec section 6 rule 5; founder decisions of 2026-10-01), rules 440-452 in docs/system/tests.md:
 * packs of 100 / 300 / 1,000 at 1 SAR a credit plus VAT, valid 90 days from activation, spent after the month's plan
 * credits, sold to paid plans only and activated by hand in the founder console while there is no payment gateway.
 * `User.credits` stays the whole balance; the packs are lots on the record (src/lib/topups.ts).
 */

// The billing page renders the partner-code field on a trial (main's #236), which reads the router.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app/billing",
  useSearchParams: () => new URLSearchParams(),
}));

const KEY = "topups-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
/**
 * The console's key session (main's #233: a key session cookie holds a random id, never the key), as the console sends
 * it. Not the x-admin-key header: that one is throttled per IP, and every call in this file comes from one address.
 */
const asConsole = async () => { jar().clear(); await adminSignIn(); };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const DAY = 864e5;
const today = () => new Date().toISOString().slice(0, 10);
const pay = (credits: number, extra: Partial<TopupInput> = {}): TopupInput => ({ credits, paidSar: topupPriceSar(credits), paidOn: today(), ref: "TRX-1", by: "key", ...extra });

/** An owner on a paid plan whose month's plan credits are `monthly` (renewed this month, so no renewal is due). */
async function paid(monthly = 300, plan: Plan = "starter"): Promise<string> {
  const u = await newUser("top");
  await saveUser({ ...(await getUser(u.email))!, plan, credits: monthly, renewedAt: monthKey() });
  return u.email;
}
async function lot(email: string, credits: number, now = Date.now(), extra: Partial<TopupInput> = {}): Promise<TopupLot> {
  const r = await addTopup(email, pay(credits, extra), now);
  if (!r.ok) throw new Error(r.error);
  return r.lot;
}
const state = async (email: string) => {
  const u = (await getUser(email))!;
  return { credits: u.credits, monthly: monthlyCredits(u), lots: Object.fromEntries(lotsOf(u).map((l) => [l.id, l.left])) };
};
const ok = (r: AgentCharge) => { if (!r.ok) throw new Error(r.reason); return r; };
const meta = (email: string) => ({ scope: email, agent: "noor" as const });

describe("the pack table lives in src/lib/pricing.ts (rule 440)", () => {
  it("100 / 300 / 1,000 credits at 1 SAR a credit, valid 90 days, sold to every paid plan and never on a trial", () => {
    expect(TOPUP_PACKS).toEqual([100, 300, 1000]);
    expect(TOPUP_SAR_PER_CREDIT).toBe(1);
    expect(TOPUP_VALID_DAYS).toBe(90);
    expect(TOPUP_PACKS.map(topupPriceSar)).toEqual([100, 300, 1000]);
    expect(TOPUP_VALID_MS).toBe(90 * DAY);
    for (const v of [100, 300, 1000]) expect(isTopupPack(v), String(v)).toBe(true);
    for (const v of ["100", 100.5, 200, 0, -100, null, undefined, [100], { credits: 100 }, NaN, Infinity]) expect(isTopupPack(v), String(v)).toBe(false);
    const plans: PricingPlan[] = ["trial", "starter", "pro", "business", "agency"];
    expect(plans.filter(topupsSold)).toEqual(["starter", "pro", "business", "agency"]);
  });

  it("a top-up credit is never cheaper than the cheapest plan credit, so the 60% margin floor holds for it too", () => {
    // The floor (rule 241) is set on the cheapest plan credit; a top-up credit at 1 SAR brings in more than that.
    expect(TOPUP_SAR_PER_CREDIT / SAR_PER_USD).toBeGreaterThanOrEqual(cheapestCreditUsd());
  });
});

describe("spending order: the month's plan credits first, then packs by earliest expiry (rule 441)", () => {
  it("a charge takes the monthly part first, then the pack that expires first, and its receipt says where each credit came from", async () => {
    const email = await paid(300);
    const later = await lot(email, 1000);
    const sooner = await lot(email, 300, Date.now() - 10 * DAY); // activated 10 days ago: expires first
    expect(await state(email)).toEqual({ credits: 1600, monthly: 300, lots: { [later.id]: 1000, [sooner.id]: 300 } });

    const a = ok(await charge(email, 250, meta(email)));
    expect(a.credits).toBe(1350);
    expect(a.from, "a charge inside the monthly part touches no pack and carries no receipt").toBeUndefined();

    const b = ok(await charge(email, 100, meta(email)));
    expect(b.from).toEqual({ monthly: 50, lots: [{ id: sooner.id, n: 50 }] });
    expect(await state(email)).toEqual({ credits: 1250, monthly: 0, lots: { [later.id]: 1000, [sooner.id]: 250 } });

    const c = ok(await charge(email, 400, meta(email)));
    expect(c.from).toEqual({ monthly: 0, lots: [{ id: sooner.id, n: 250 }, { id: later.id, n: 150 }] });
    expect(await state(email)).toEqual({ credits: 850, monthly: 0, lots: { [later.id]: 850, [sooner.id]: 0 } });
    // More than is left is refused without touching anything.
    expect(await charge(email, 851)).toEqual({ ok: false, reason: "no_credits", credits: 850, need: 851 });
    expect((await state(email)).credits).toBe(850);
  });

  it("a chat message billed past the allowance spends the same way: monthly first, then packs", async () => {
    const email = await paid(2);
    const p = await lot(email, 100);
    const r = await settleChatOverflow(email, 5, 5 * 71_040, 71_040);
    expect(r).toEqual({ credits: 97, charged: 5 });
    expect(await state(email)).toEqual({ credits: 97, monthly: 0, lots: { [p.id]: 97 } });
  });

  it("spendCredits and settleTopups on a record in memory: whole numbers, the oldest expiry first", () => {
    const now = Date.now();
    const mk = (id: string, credits: number, left: number, expires: number): TopupLot => ({ id, credits, left, at: new Date(expires - TOPUP_VALID_MS).toISOString(), expiresAt: new Date(expires).toISOString(), paidSar: credits, paidOn: today(), ref: "", by: "key" });
    const u: Pick<User, "credits" | "topups"> = { credits: 10 + 30 + 20, topups: [mk("b", 100, 30, now + 5 * DAY), mk("a", 100, 20, now + 2 * DAY)] };
    expect(settleTopups(u, now)).toBe(true); // sorted by expiry
    expect(monthlyCredits(u)).toBe(10);
    expect(spendCredits(u, 35)).toEqual({ monthly: 10, lots: [{ id: "a", n: 20 }, { id: "b", n: 5 }] });
    expect(u).toMatchObject({ credits: 25, topups: [{ id: "a", left: 0 }, { id: "b", left: 25 }] });
  });
});

describe("refunds go back where the credits came from (rule 442)", () => {
  it("a full refund restores each pack and the monthly part; a partial one undoes the charge from its last credit", async () => {
    const email = await paid(50);
    const p = await lot(email, 100);
    const r = ok(await charge(email, 80, meta(email)));
    expect(r.from).toEqual({ monthly: 50, lots: [{ id: p.id, n: 30 }] });
    await refund(email, 80, r);
    expect(await state(email)).toEqual({ credits: 150, monthly: 50, lots: { [p.id]: 100 } });

    const s = ok(await charge(email, 80, meta(email)));
    await refund(email, 40, s);
    expect(await state(email), "the last 30 credits came from the pack, the 10 before them from the monthly part").toEqual({ credits: 110, monthly: 10, lots: { [p.id]: 100 } });
    // A second refund against the same receipt (no caller makes one) never gives a pack more than it was sold with.
    await refund(email, 30, s);
    expect((await state(email)).lots[p.id]).toBe(100);
  });

  // Founder decision of 2026-10-02 (rule 461): what a failed charge owed to a pack that is gone goes to the plan credits.
  it("a refund owed to a pack that was voided or has expired goes to the month's plan credits", async () => {
    const email = await paid(0);
    const p = await lot(email, 100, Date.now() - 1000);
    const q = await lot(email, 300);
    const r = ok(await charge(email, 150, meta(email)));
    expect(r.from).toEqual({ monthly: 0, lots: [{ id: p.id, n: 100 }, { id: q.id, n: 50 }] });
    expect((await voidTopup(email, p.id)).ok).toBe(true);
    await refund(email, 150, r);
    expect(await state(email), "the voided pack's 100 come back as plan credits; the live pack gets its 50 back").toEqual({ credits: 400, monthly: 100, lots: { [q.id]: 300 } });

    // Expired: the charge took 30 from a pack that expires before the refund lands.
    const e2 = await paid(0);
    const old = await lot(e2, 100, Date.now() - 89 * DAY);
    const s = ok(await charge(e2, 30, meta(e2)));
    expect(s.from).toEqual({ monthly: 0, lots: [{ id: old.id, n: 30 }] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(old.expiresAt));
    await refund(e2, 30, s);
    expect(await state(e2), "the pack's 70 left with it; the 30 refunded are plan credits").toEqual({ credits: 30, monthly: 30, lots: {} });
    vi.useRealTimers();

    const m = { credits: 0, topups: [] as TopupLot[] };
    expect(returnCredits(m, 40, { monthly: 0, lots: [{ id: "gone", n: 40 }] })).toEqual({ dropped: 0, toPlan: 40 });
    expect(m.credits).toBe(40);
  });

  it("a refund with no receipt, or past what the receipt took, goes to the monthly part as before top-ups", async () => {
    const email = await paid(100);
    const p = await lot(email, 100);
    const r = ok(await charge(email, 30, meta(email)));
    expect(r.from).toBeUndefined();
    await refund(email, 30, r);
    expect(await state(email)).toEqual({ credits: 200, monthly: 100, lots: { [p.id]: 100 } });
    await refund(email, 5); // no receipt at all: adjust(+5)
    expect(await state(email)).toEqual({ credits: 205, monthly: 105, lots: { [p.id]: 100 } });
  });

  it("an added brand's setup hold keeps its receipt, and its refund goes back to the pack", async () => {
    const email = await paid(4);
    const p = await lot(email, 100);
    const held = await chargeOnboard(email, 9, { scope: `${email}#b2`, agent: "noor" });
    expect(held.ok && !held.reused && held.hold.from).toEqual({ monthly: 4, lots: [{ id: p.id, n: 5 }] });
    expect(await state(email)).toEqual({ credits: 95, monthly: 0, lots: { [p.id]: 95 } });
    expect(await refundOnboard(email, `${email}#b2`)).toEqual({ credits: 104, refunded: 9 });
    expect(await state(email)).toEqual({ credits: 104, monthly: 4, lots: { [p.id]: 100 } });
  });

  it("every metered spender hands the receipt to its refund: batches pass the charge result, media jobs store it", () => {
    const batch = readFileSync("src/lib/generate-batch.ts", "utf8");
    expect(batch).toContain("refund(user.email, cost, receipt)");
    expect(batch).toContain("receipt = paid;");
    // A reused Sunday-plan hold names the same packs as the run that paid (rule 458).
    expect(batch).toContain("...(paid.hold.from ? { from: paid.hold.from } : {})");
    expect(readFileSync("src/lib/media/jobs.ts", "utf8")).toContain("spend: { scope: paid.scope, agent: paid.agent, month: paid.month, ...(paid.from ? { from: paid.from } : {}) },");
    expect(readFileSync("src/lib/auth.ts", "utf8")).toMatch(/export type OnboardHold = \{[^}]*from\?: Receipt \}/);
  });
});

describe("renewal and the founder's plan changes reset the monthly part only (rule 443)", () => {
  it("renewal resets the month's plan credits to the allowance and keeps every credit left in live packs", async () => {
    const email = await paid(10, "pro");
    const p = await lot(email, 300);
    ok(await charge(email, 60, meta(email)));
    await saveUser({ ...(await getUser(email))!, renewedAt: "2020-01" });
    expect(await renewIfDue(email)).toBe(true);
    expect(await state(email), "unused monthly credits do not roll over; the pack's 250 stay").toEqual({ credits: PLAN_CREDITS.pro + 250, monthly: PLAN_CREDITS.pro, lots: { [p.id]: 250 } });
  });

  it("a plan change in the console sets the monthly part and keeps the packs; '+ credits' never takes a pack's credits", async () => {
    await asConsole();
    const email = await paid(300);
    const p = await lot(email, 100);
    expect((await planRoute.POST(json("/api/admin/plan", "POST", { email, plan: "business" }))).status).toBe(200);
    expect(await state(email)).toEqual({ credits: PLAN_CREDITS.business + 100, monthly: PLAN_CREDITS.business, lots: { [p.id]: 100 } });
    expect((await planRoute.POST(json("/api/admin/plan", "POST", { email, addCredits: -100_000 }))).status).toBe(200);
    expect(await state(email), "taking credits stops at the packs").toEqual({ credits: 100, monthly: 0, lots: { [p.id]: 100 } });
    expect(await adjust(email, -5)).toBe(100);
    expect(await adjust(email, 7)).toBe(107);
    const list = (await (await planRoute.GET(json("/api/admin/plan", "GET"))).json()) as { users: { email: string; credits: number; topupCredits: number }[] };
    expect(list.users.find((x) => x.email === email)).toMatchObject({ credits: 107, topupCredits: 100 });
  });
});

describe("expiry: a pack's unspent credits leave on the day it expires (rule 444)", () => {
  it("every read settles an expired pack out of the balance; the daily sweep writes it back under the lock", async () => {
    const email = await paid(40);
    const old = await lot(email, 100, Date.now() - 89 * DAY);
    const fresh = await lot(email, 300);
    ok(await charge(email, 60, meta(email))); // 40 monthly, 20 from the older pack
    expect(await state(email)).toEqual({ credits: 380, monthly: 0, lots: { [old.id]: 80, [fresh.id]: 300 } });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(old.expiresAt)); // the instant it expires: no longer live
    const u = (await getUser(email))!;
    expect(u.credits, "the expired pack's 80 are gone from the balance at once").toBe(300);
    expect(lotsOf(u).map((l) => l.id)).toEqual([fresh.id]);
    expect(u.topupsDirty).toBe(true);
    const stored = (await db.get<User>(`user:${email}`))!;
    expect(stored.credits, "storage is behind until a locked save").toBe(380);
    expect(stored).not.toHaveProperty("topupsDirty");

    expect(await saveSettledTopups(email)).toEqual({ saved: true, credits: 300 });
    const after = (await db.get<User>(`user:${email}`))!;
    expect(after.credits).toBe(300);
    expect(after.topups?.map((l) => l.id)).toEqual([fresh.id]);
    expect(after, "the runtime flag is never stored").not.toHaveProperty("topupsDirty");
    expect(await saveSettledTopups(email), "nothing left to write").toEqual({ saved: false, credits: 300 });

    vi.setSystemTime(new Date(fresh.expiresAt));
    expect(await state(email), "the last pack gone, the field goes too").toEqual({ credits: 0, monthly: 0, lots: {} });
    await saveSettledTopups(email);
    expect((await db.get<User>(`user:${email}`))!).not.toHaveProperty("topups");
  });

  it("the daily cron saves settled packs once per account, on its default brand's entry, never in an awaited loop", () => {
    const src = readFileSync("src/app/api/cron/daily/route.ts", "utf8");
    expect(src).toContain('if ((u.brandId ?? "default") === "default" && u.topupsDirty) {');
    expect(src).toContain("const settled = await saveSettledTopups(u.email);");
  });

  it("settleTopups repairs what it cannot trust: lefts past the pack, a balance below the packs, a malformed expiry", () => {
    const now = Date.now();
    const base = { at: new Date(now).toISOString(), paidSar: 0, paidOn: today(), ref: "", by: "key" };
    const u: Pick<User, "credits" | "topups"> = { credits: 50, topups: [{ ...base, id: "x", credits: 100, left: 140, expiresAt: new Date(now + DAY).toISOString() }, { ...base, id: "y", credits: 100, left: 100, expiresAt: "not a date" }] };
    expect(settleTopups(u, now)).toBe(true);
    // "y" is not live (its credits leave); "x" holds at most its 100 and never more than the balance.
    expect(u).toMatchObject({ topups: [{ id: "x", left: 0 }] });
    expect(u.credits).toBe(0);
    const v: Pick<User, "credits" | "topups"> = { credits: NaN, topups: [{ ...base, id: "z", credits: 100, left: 60, expiresAt: new Date(now + DAY).toISOString() }] };
    settleTopups(v, now);
    expect(v.credits, "a balance that is not a number keeps the packs' credits").toBe(60);
  });
});

describe("concurrent charges never overspend the monthly part or a pack (rule 445)", () => {
  it("20 parallel charges of 10 on 50 monthly + a 100 pack: exactly 15 succeed and every receipt adds up", async () => {
    const email = await paid(50);
    const p = await lot(email, 100);
    const results = await Promise.all(Array.from({ length: 20 }, () => charge(email, 10, meta(email))));
    const done = results.filter((r): r is Extract<AgentCharge, { ok: true }> => r.ok);
    expect(done).toHaveLength(15);
    expect(await state(email)).toEqual({ credits: 0, monthly: 0, lots: { [p.id]: 0 } });
    const fromPack = done.reduce((s, r) => s + (r.from?.lots.reduce((t, l) => t + l.n, 0) ?? 0), 0);
    expect(fromPack).toBe(100);
    // Refunding all of them in parallel puts back exactly what each took.
    await Promise.all(done.map((r) => refund(email, 10, r)));
    expect(await state(email)).toEqual({ credits: 150, monthly: 50, lots: { [p.id]: 100 } });
  });

  it("a void racing charges never leaves the balance below what the remaining packs hold", async () => {
    const email = await paid(0);
    const p = await lot(email, 300);
    const q = await lot(email, 100);
    await Promise.all([...Array.from({ length: 10 }, () => charge(email, 20)), voidTopup(email, q.id)]);
    const u = (await getUser(email))!;
    expect(u.credits).toBe(topupCredits(u));
    expect(lotsOf(u).map((l) => l.id)).toEqual([p.id]);
  });
});

describe("POST /api/admin/topups: the founder activates a pack by hand (rule 446)", () => {
  beforeEach(asConsole);
  const post = (body: Record<string, unknown>) => topupsRoute.POST(json("/api/admin/topups", "POST", body));
  const lastLog = async () => JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as Record<string, unknown>;

  it("founder only: anyone else is 401 before the body is read", async () => {
    const email = await paid(0);
    jar().clear();
    expect((await post({ email, action: "add", credits: 100, paidSar: 100, paidOn: today() })).status).toBe(401);
    const owner = await newUser("own");
    await signIn(owner.email);
    expect((await post({ email, action: "add", credits: 100, paidSar: 100, paidOn: today() })).status).toBe(401);
    signOut();
    expect((await getUser(email))!.topups).toBeUndefined();
  });

  it("checks every field in code and writes nothing on a bad request", async () => {
    const email = await paid(0);
    const logged = (await db.lrange("admin:log", 0, -1)).length;
    const good = { email, action: "add", credits: 300, paidSar: 300, paidOn: today(), ref: "TRX" };
    const cases: [Record<string, unknown>, number, string][] = [
      [{ ...good, action: "grant" }, 400, "bad_action"],
      [{ ...good, credits: 200 }, 400, "bad_pack"],
      [{ ...good, credits: "300" }, 400, "bad_pack"],
      [{ ...good, paidSar: -1 }, 400, "bad_paid"],
      [{ ...good, paidSar: "300" }, 400, "bad_paid"],
      [{ ...good, paidSar: 100_001 }, 400, "bad_paid"],
      [{ ...good, paidOn: "2026-02-30" }, 400, "bad_date"],
      [{ ...good, paidOn: "30/09/2026" }, 400, "bad_date"],
      [{ ...good, paidOn: new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10) }, 400, "bad_date"],
      [{ ...good, paidOn: new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10) }, 400, "bad_date"],
      // Tomorrow in Riyadh: a recorded payment is never dated after today there (rule 459).
      [{ ...good, paidOn: ksaDay(Date.now() + DAY) }, 400, "bad_date"],
      [{ ...good, paymentId: "pay_XYZ" }, 400, "bad_id"],
      [{ ...good, paymentId: 42 }, 400, "bad_id"],
      [{ ...good, ref: "x".repeat(81) }, 400, "bad_ref"],
      [{ ...good, ref: 42 }, 400, "bad_ref"],
      [{ ...good, email: "nobody@test.example" }, 404, "not_found"],
    ];
    for (const [body, status, error] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(await res.json(), JSON.stringify(body)).toEqual({ ok: false, error });
    }
    expect((await getUser(email))!.topups).toBeUndefined();
    expect((await db.lrange("admin:log", 0, -1)).length, "a refused request is not logged").toBe(logged);
    expect(parseTopup({ credits: 100, paidSar: 99.999, paidOn: today(), ref: "  a\nb\u0007 " })).toEqual({ ok: true, topup: { credits: 100, paidSar: 100, paidOn: today(), ref: "a b" } });
  });

  it("a trial is refused: top-ups are sold to paid plans only", async () => {
    const u = await newUser("trial");
    const res = await post({ email: u.email, action: "add", credits: 100, paidSar: 100, paidOn: today() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "topup_needs_paid_plan" });
    expect((await getUser(u.email))!.credits).toBe(PLAN_CREDITS.trial);
    expect((await getUser(u.email))!.topups).toBeUndefined();
  });

  it("adds the pack at once, valid 90 days, and logs the actor, the pack and the payment without its reference", async () => {
    const email = await paid(120, "agency");
    const before = Date.now();
    const res = await post({ email, action: "add", credits: 1000, paidSar: 950.5, paidOn: today(), ref: "BANK-778899", reason: "WhatsApp request" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; lot: TopupLot; credits: number; topupCredits: number };
    expect(body).toMatchObject({ ok: true, credits: 1120, topupCredits: 1000, lot: { credits: 1000, left: 1000, paidSar: 950.5, paidOn: today(), ref: "BANK-778899", by: "key" } });
    expect(body.lot.id).toMatch(/^[0-9a-f]{16}$/);
    const at = new Date(body.lot.at).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(new Date(body.lot.expiresAt).getTime() - at).toBe(90 * DAY);
    expect(await state(email)).toEqual({ credits: 1120, monthly: 120, lots: { [body.lot.id]: 1000 } });
    const log = await lastLog();
    // The pack's payment is recorded with it (rule 454); this customer has no partner, so no commission is named.
    expect(log).toMatchObject({ actor: "key", email, what: `topup:+1000 payment:${body.lot.paymentId}`, before: { credits: 120 }, after: { credits: 1120 }, reason: "WhatsApp request", topup: { id: body.lot.id, credits: 1000, paidSar: 950.5, paidOn: today() } });
    expect(body.lot.paymentId).toMatch(/^pay_[0-9a-f]+$/);
    expect(JSON.stringify(log), "the payment reference stays on the pack").not.toContain("BANK-778899");
  });

  it("refuses a pack past the live-pack bound", async () => {
    const email = await paid(0);
    const u = (await getUser(email))!;
    const now = Date.now();
    u.topups = Array.from({ length: MAX_LIVE_TOPUPS }, (_, i) => ({ id: i.toString(16).padStart(16, "0"), credits: 100, left: 0, at: new Date(now).toISOString(), expiresAt: new Date(now + DAY).toISOString(), paidSar: 100, paidOn: today(), ref: "", by: "key" }));
    await saveUser(u);
    const res = await post({ email, action: "add", credits: 100, paidSar: 100, paidOn: today() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "too_many_topups" });
  });
});

describe("POST /api/admin/topups void: a pack's unspent credits leave, spent ones stay spent (rule 447)", () => {
  beforeEach(asConsole);
  const post = (body: Record<string, unknown>) => topupsRoute.POST(json("/api/admin/topups", "POST", body));

  it("voids the pack, logs what left the balance, and refuses an id that is malformed or not there", async () => {
    const email = await paid(0);
    const p = await lot(email, 300);
    ok(await charge(email, 120, meta(email)));
    expect((await post({ email, action: "void", id: "../../user" })).status).toBe(400);
    const missing = await post({ email, action: "void", id: "0123456789abcdef" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, error: "topup_not_found" });
    const res = await post({ email, action: "void", id: p.id, reason: "transfer bounced" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, credits: 0, removed: 180, topupCredits: 0 });
    expect(await state(email)).toEqual({ credits: 0, monthly: 0, lots: {} });
    const log = JSON.parse((await db.lrange("admin:log", 0, 0))[0]);
    expect(log).toMatchObject({ actor: "key", email, what: "topup_void:300 removed:180", before: { credits: 180 }, after: { credits: 0 }, reason: "transfer bounced" });
    expect(JSON.stringify(log)).not.toContain("TRX-1");
  });
});

describe("top-up revenue sits next to MRR, never inside it (rule 448)", () => {
  it("sums what packs paid for this month brought in, in halalas; voided packs and other months do not count", () => {
    const m = (paidOn: string, paidSar: number): Pick<User, "topups"> => ({ topups: [{ id: paidOn + paidSar, credits: 100, left: 100, at: "", expiresAt: "", paidSar, paidOn, ref: "", by: "key" }] });
    expect(topupRevenueSar([m("2026-10-01", 100.1), m("2026-10-31", 0.2), m("2026-09-30", 1000), { topups: undefined }], "2026-10")).toBe(100.3);
  });

  it("the founder overview reports this month's top-up revenue and leaves MRR as the plans' prices", async () => {
    const email = await paid(0, "pro");
    const a = await overview();
    const p = await lot(email, 300, Date.now(), { paidSar: 123.45 });
    const b = await overview();
    expect(Math.round((b.revenue.topupSarMonth - a.revenue.topupSarMonth) * 100) / 100).toBe(123.45);
    expect(b.revenue.mrrSar, "MRR is unchanged by a top-up").toBe(a.revenue.mrrSar);
    await voidTopup(email, p.id);
    expect((await overview()).revenue.topupSarMonth).toBe(a.revenue.topupSarMonth);
    expect(priceOf({ plan: "pro" })).toBeGreaterThan(0);
  });
});

describe("the billing page's 'Top up credits' section (rule 449)", () => {
  type AsyncPage = (p: { params: Promise<{ lang: string }> }) => Promise<ReactElement>;
  const billing = async (lang: "ar" | "en") => renderToStaticMarkup(await (BillingPage as unknown as AsyncPage)({ params: Promise.resolve({ lang }) }));
  /** React escapes these in an attribute; compare against what the markup really contains. */
  const amp = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");

  it("the owner of a paid plan gets the three packs with their price, 90 days, and a WhatsApp request naming the pack and the account", async () => {
    vi.stubEnv("SUPPORT_WHATSAPP", "+966 50 000 0000");
    const email = await paid(300);
    const p = await lot(email, 300);
    await signIn(email);
    const en = await billing("en");
    expect(en).toContain('id="topup"');
    expect(en).toContain("Top up credits");
    for (const c of TOPUP_PACKS) {
      expect(en).toContain(`data-pack="${c}"`);
      expect(en).toContain(`${c === 1000 ? "1,000" : c} SAR + VAT`);
    }
    expect(en).toContain("used after your plan&#x27;s monthly credits, and valid for 90 days from activation");
    const msg = encodeURIComponent(`Thakeen: I'd like to top up with the 1,000-credit pack (1,000 SAR + VAT). Account: ${email}`);
    expect(en).toContain(amp(`https://wa.me/966500000000?text=${msg}`));
    expect((en.match(/data-pack-request=""/g) ?? []).length).toBe(3);
    // The account's live pack, and the balance's share from packs.
    expect(en).toContain(`data-lot="${p.id}"`);
    expect(en).toContain("300 of 300 credits left");
    expect(en).toContain(`Expires <span class="font-mono" dir="ltr">${p.expiresAt.slice(0, 10)}</span>`);
    expect(en).toContain("incl. 300 from top-ups");
    const ar = await billing("ar");
    expect(ar).toContain("اشحن رصيدك");
    expect(ar).toContain("100 ريال + الضريبة");
    expect(ar).toContain(amp(`https://wa.me/966500000000?text=${encodeURIComponent(`ذكين: أرغب في شحن رصيدي بباقة 100 كريدت (100 ريال + الضريبة). الحساب: ${email}`)}`));
    vi.unstubAllEnvs(); vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
  });

  it("without a support number the request goes by email; a trial sees the packs as available after subscribing, with no button", async () => {
    vi.stubEnv("SUPPORT_WHATSAPP", "");
    const email = await paid(300);
    await signIn(email);
    const en = await billing("en");
    expect(en).toContain("mailto:hello@nashr.ai?subject=");
    expect(en).not.toContain("wa.me");
    const t = await newUser("trialbill");
    await signIn(t.email);
    const trial = await billing("en");
    expect(trial).toContain('data-pack="100"');
    expect(trial).toContain("Top-up packs are available once you subscribe to a paid plan.");
    expect(trial).not.toContain("data-pack-request");
    vi.unstubAllEnvs(); vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
  });

  it("a member sees the packs and the account's packs read-only, never a request carrying the owner's email", async () => {
    vi.stubEnv("SUPPORT_WHATSAPP", "966500000000");
    const email = await paid(300);
    const p = await lot(email, 100);
    const m = await newMember((await getUser(email))!, "admin");
    await signIn(m.email);
    const html = await billing("en");
    expect(html).toContain('data-pack="1000"');
    expect(html).toContain(`data-lot="${p.id}"`);
    expect(html).not.toContain("data-pack-request");
    expect(html).toContain("Ask the account owner to top up the credits.");
    vi.unstubAllEnvs(); vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
  });

  it("every number on the card comes from src/lib/pricing.ts or the account, never typed into the copy", () => {
    const src = readFileSync("src/components/app/TopupCard.tsx", "utf8");
    for (const typed of ["100", "300", "1000", "1,000", "90"]) expect(src, typed).not.toMatch(new RegExp(`(^|[^\\w.#-])${typed}(?![\\w])`, "m"));
    expect(src).not.toMatch(/^\s*["']use client["']/m);
  });
});

describe("out of credits, every message names the top-up (rule 450)", () => {
  it("the limit dialog offers a pack before an upgrade on a paid plan, and a plan on a trial, in both languages", () => {
    for (const lang of ["ar", "en"] as const) {
      const L = appDict[lang].limit;
      const [, owner] = limitText(L, { kind: "credits" }, true, true);
      const [, member] = limitText(L, { kind: "credits" }, false, true);
      const [, trialOwner] = limitText(L, { kind: "credits" }, true, false);
      const [, trialMember] = limitText(L, { kind: "credits" }, false, false);
      expect(owner, lang).toMatch(lang === "ar" ? /اشحن رصيدك[\s\S]*بعد كريدت خطتك[\s\S]*صفحة الاشتراك/ : /Top up[\s\S]*after your plan's monthly credits[\s\S]*Subscription page/);
      expect(member, lang).toMatch(lang === "ar" ? /مالك الحساب شحن الرصيد/ : /account owner to top up/);
      expect(trialOwner, lang).toMatch(lang === "ar" ? /بعد الاشتراك/ : /once you subscribe/);
      expect(trialMember, lang).not.toMatch(/top up|شحن/i);
      expect(L.topup, lang).toMatch(lang === "ar" ? /اشحن رصيدك/ : /Top up credits/);
      expect(L.chatCreditsBody, lang).toMatch(lang === "ar" ? /اشحن رصيدك/ : /Top up your credits/);
      expect(L.askOwnerChatCredits, lang).toMatch(lang === "ar" ? /شحن الرصيد/ : /top up the credits/);
    }
    for (const lang of ["ar", "en"] as const) expect(appDict[lang].inbox.topupLink, lang).toMatch(lang === "ar" ? /شحن الرصيد/ : /Top-ups/);
    const media = readFileSync("src/components/app/MediaControls.tsx", "utf8");
    expect(media).toContain("billing: true, topup: sold };");
    expect(media).toContain('href={`/${lang}/app/billing${n.topup ? "#topup" : ""}`}');
    const src = readFileSync("src/components/app/LimitModal.tsx", "utf8");
    expect(src).toContain('const topup = kind === "credits" && topups;');
    expect(readFileSync("src/app/[lang]/app/layout.tsx", "utf8")).toContain("topups={topupsSold(user.plan)}");
  });

  it("the model and connected apps are told the same: chat tools, MCP and the chat refusal", () => {
    expect(NO_CREDITS_HINT).toMatch(/top up credits[\s\S]*upgrade the plan on the Subscription page[\s\S]*a trial subscribes/);
    const chat = readFileSync("src/lib/chat.ts", "utf8");
    expect(chat.match(/NO_CREDITS_HINT/g)?.length).toBeGreaterThanOrEqual(4); // the import and three refusals
    expect(readFileSync("src/app/api/mcp/route.ts", "utf8")).toContain("Insufficient credits: need ${r.need}, have ${r.credits}. ${NO_CREDITS_HINT}");
    const status = { used: 250, allowance: 250, left: 0, counted: 250, period: "month" as const, overflow: { on: true, available: true, used: 0, credits: 0, hold: 5 } };
    expect(refusalText({ ok: false, error: "chat_credits", status, credits: 2, need: 5 })).toContain("top up credits");
  });

  it("no pack size or validity is typed into the dialog's copy (rule 248)", () => {
    for (const lang of ["ar", "en"] as const) {
      const L = appDict[lang].limit;
      for (const k of ["creditsBody", "creditsTrialBody", "askOwner", "askOwnerCreditsTrial", "topup", "chatCreditsBody", "askOwnerChatCredits"] as const) {
        expect(L[k], `${lang} ${k}`).not.toMatch(/(^|\D)(100|300|1,?000|90)(\D|$)/);
      }
    }
  });
});

describe("the module boundaries (rules 451-452)", () => {
  it("topups.ts imports only src/lib/pricing.ts and a type, so the console and the billing page can read it", () => {
    const src = readFileSync("src/lib/topups.ts", "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import\s/.test(l));
    expect(imports).toEqual(['import type { User } from "./auth";', 'import { TOPUP_PACKS, TOPUP_VALID_DAYS, isTopupPack } from "./pricing";', 'import { ksaDay } from "./partner-rules";']);
    // Both are import-free, so nothing server-side reaches the console, the billing page or the profile through it.
    for (const f of ["src/lib/pricing.ts", "src/lib/partner-rules.ts"]) expect(readFileSync(f, "utf8").split("\n").filter((l) => /^\s*import\s/.test(l)), f).toEqual([]);
    const console = adminConsoleSrc();
    expect(console).toContain('import type { TopupLot } from "@/lib/topups";');
  });

  it("every whole-balance writer goes through the pack-aware helpers: no bare assignment of the plan allowance is left", () => {
    const plan = readFileSync("src/app/api/admin/plan/route.ts", "utf8");
    expect(plan).toContain("setMonthly(u, allowanceOf(u));");
    expect(plan).toContain("if (addGiven) addMonthly(u, add);");
    expect(plan).not.toMatch(/u\.credits = allowanceOf/);
    const credits = readFileSync("src/lib/credits.ts", "utf8");
    expect(credits).toContain("setMonthly(u, allowanceOf(u));");
    expect(credits).not.toMatch(/u\.credits -= /);
    expect(readFileSync("src/lib/auth.ts", "utf8")).toContain("if (settleTopups(u)) u.topupsDirty = true;");
  });
});

describe("the owner's /api/profile shows packs without what was paid or who activated them (rule 453)", () => {
  it("each pack is its credits, what is left and its dates; no payment reference, amount, founder or runtime flag", async () => {
    const email = await paid(80);
    const live = await lot(email, 300, Date.now(), { ref: "BANK-SECRET-4411", by: "founder-x@test.example", paidSar: 287.5 });
    const gone = await lot(email, 100, Date.now(), { ref: "BANK-SECRET-4412", by: "founder-x@test.example" });
    // The second pack expires under the owner's feet: the read settles it out and marks the record dirty (rule 444).
    const u = (await getUser(email))!;
    await saveUser({ ...u, topups: u.topups!.map((l) => (l.id === gone.id ? { ...l, expiresAt: new Date(Date.now() - DAY).toISOString() } : l)) });
    await signIn(email);
    const res = await profileRoute.GET();
    expect(res.status).toBe(200);
    const raw = await res.text();
    for (const secret of ["BANK-SECRET", "founder-x@test.example", "paidSar", "paidOn", "\"ref\"", "topupsDirty"]) expect(raw).not.toContain(secret);
    const body = JSON.parse(raw) as { user: { credits: number; topups: unknown } };
    expect(body.user.credits).toBe(380);
    // Only what the owner needs (rule 453): each pack's size, the credits left and the expiry. No id, no activation time.
    expect(body.user.topups).toEqual([{ credits: 300, left: 300, expiresAt: live.expiresAt }]);
    for (const field of [live.id, "\"at\"", "paymentId", "\"by\""]) expect(raw, field).not.toContain(field);
  });

  it("a member sees the same packs as the owner, and nothing of their payment", async () => {
    const email = await paid(80);
    const p = await lot(email, 100, Date.now(), { ref: "BANK-SECRET-9", paymentId: "pay_00112233445566778899" });
    const m = await newMember((await getUser(email))!);
    await signIn(m.email);
    const raw = await (await profileRoute.GET()).text();
    for (const secret of ["BANK-SECRET", "paidSar", "paymentId", "pay_00112233"]) expect(raw).not.toContain(secret);
    expect((JSON.parse(raw) as { user: { topups: unknown } }).user.topups).toEqual([{ credits: 100, left: 100, expiresAt: p.expiresAt }]);
  });
});
