import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { adminSignIn, jar, json, newMember, newUser, params, signIn } from "./helpers/session";
import { getUser, saveUser, type Plan } from "@/lib/auth";
import { addTopup, charge, monthKey, refund, type AgentCharge } from "@/lib/credits";
import { db } from "@/lib/db";
import { PARTNER_TERMS_VERSION, commissionAfterRefund, commissionSar, ksaDay, type LedgerRow } from "@/lib/partner-rules";
import { PARTNER_TERMS } from "@/lib/partner-terms";
import { addPaidTopup, approvePartner, recordPayment, refundPaidTopup, voidPaidTopup, type Payment } from "@/lib/partners";
import { lotsOf, monthlyCredits, openLots, parseTopupRefund, refundUnused, returnCredits, topupRevenueSar, unusedRefundSar, type TopupLot } from "@/lib/topups";
import { overview } from "@/lib/admin-stats";
import { LEGAL } from "@/lib/legal";
import * as topupsRoute from "@/app/api/admin/topups/route";
import * as profileRoute from "@/app/api/profile/route";
import * as adminUser from "@/app/api/admin/users/[email]/route";
import BillingPage from "@/app/[lang]/app/settings/billing/page";
import { adminConsoleSrc } from "./helpers/admin-console";

/**
 * The founder's answers of 2026-10-02 to PR #239's open questions, rules 460-464 in docs/system/tests.md:
 * 1. Unused top-up credits can be refunded: only the unused share, only before the pack expires, at the price per credit
 *    actually paid, excluding VAT. The founder transfers the money by hand and records it with "Refund unused": the
 *    credits left leave the pack and the balance at once under the ledger lock, the refund is recorded on the pack's
 *    payment, and the partner's commission on it drops by commission × refunded / paid, once.
 * 2. A failed charge's credits owed to a pack that expired, was voided or was refunded since go to the plan credits.
 * 3. and 4. (revenue by the payment date; a pack's date starts the partner's windows while no plan payment stands) keep
 *    what rules 448 and 454 pin.
 */

// The billing page renders the partner-code field on a trial (main's #236), which reads the router.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app/billing",
  useSearchParams: () => new URLSearchParams(),
}));

const KEY = "topup-refunds-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
afterEach(() => { vi.useRealTimers(); });

const DAY = 864e5;
const day = (offsetDays = 0) => ksaDay(Date.now() + offsetDays * DAY);
const payId = () => `pay_${randomBytes(9).toString("hex")}`;
const rfId = () => `rf_${randomBytes(9).toString("hex")}`;
const ok = (r: AgentCharge) => { if (!r.ok) throw new Error(r.reason); return r; };
const meta = (email: string) => ({ scope: email, agent: "noor" as const });

/** An owner on a paid plan whose month's plan credits are `monthly` (renewed this month, so no renewal is due). */
async function paid(monthly = 0, plan: Plan = "starter"): Promise<string> {
  const u = await newUser("trf");
  await saveUser({ ...(await getUser(u.email))!, plan, credits: monthly, renewedAt: monthKey() });
  return u.email;
}
/** An approved partner, and a paying customer with no plan credits left, attributed to it `daysAgo` days ago. */
async function referred(daysAgo = 2): Promise<{ customer: string; partner: string }> {
  const p = await newUser("trfpartner");
  const code = `RF${randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 12);
  const a = await approvePartner({ email: p.email, code, name: "Partner", consentOutOfBand: true }, "key");
  if (!a.ok) throw new Error(a.error);
  const customer = await paid(0);
  const u = (await getUser(customer))!;
  await saveUser({ ...u, referredBy: { partner: p.email, code, at: new Date(Date.now() - daysAgo * DAY).toISOString(), via: "code", ref: randomBytes(6).toString("hex") } });
  return { customer, partner: p.email };
}
/** A pack added the way the console adds it, with its payment. */
async function pack(email: string, credits = 300, paidSar = credits, extra: { paymentId?: string } = {}): Promise<TopupLot> {
  const r = await addPaidTopup(email, { credits, paidSar, paidOn: day(), ref: "TRX-PACK", paymentId: extra.paymentId ?? payId() }, "key");
  if (!r.ok) throw new Error(r.error);
  return r.lot;
}
const lotOf = async (email: string, id: string) => lotsOf((await getUser(email))!).find((l) => l.id === id);
const payments = async (email: string) => db.hgetall<Payment>(`payments:${email}`);
const ledger = async (email: string) => Object.values(await db.hgetall<LedgerRow>(`partner:ledger:${email}`));
const ask = (credits: number, extra: { on?: string; ref?: string; id?: string } = {}) => ({ credits, on: extra.on ?? day(), ref: extra.ref ?? "RF-SECRET-1", ...(extra.id ? { id: extra.id } : {}) });
const post = (body: Record<string, unknown>) => topupsRoute.POST(json("/api/admin/topups", "POST", body));

describe("refunding a pack's unused credits: the amount and the ledger (rule 460)", () => {
  it("the amount is the credits left × the price per credit actually paid, excluding VAT, to the halala", () => {
    expect(unusedRefundSar({ credits: 300, left: 120, paidSar: 300 })).toBe(120);
    // A pack sold below list price refunds at what was paid: 100 × 287.50 / 300 = 95.833…
    expect(unusedRefundSar({ credits: 300, left: 100, paidSar: 287.5 })).toBe(95.83);
    expect(unusedRefundSar({ credits: 1000, left: 1, paidSar: 950.5 })).toBe(0.95);
    expect(unusedRefundSar({ credits: 100, left: 100, paidSar: 100 })).toBe(100);
    expect(unusedRefundSar({ credits: 100, left: 0, paidSar: 100 })).toBe(0);
    expect(unusedRefundSar({ credits: 100, left: 100, paidSar: 0 }), "a pack given for nothing refunds nothing").toBe(0);
    expect(unusedRefundSar({ credits: 100, left: 500, paidSar: 100 }), "never more than the pack").toBe(100);
    expect(unusedRefundSar({ credits: 100, left: 50, paidSar: NaN })).toBe(0);
  });

  it("partial use: exactly the credits left leave the pack and the balance; the plan credits are untouched", async () => {
    const email = await paid(50);
    const l = await pack(email, 300, 250);
    const c = ok(await charge(email, 80, meta(email)));
    expect(c.from, "plan credits first, then the pack").toEqual({ monthly: 50, lots: [{ id: l.id, n: 30 }] });
    await saveUser({ ...(await getUser(email))!, credits: (await getUser(email))!.credits + 10 }); // 10 plan credits back (a bonus)
    const r = await refundPaidTopup(email, l.id, ask(270), "key");
    if (!r.ok) throw new Error(r.error);
    // 270 × 250 / 300 = 225.
    expect(r).toMatchObject({ before: 280, credits: 10, refunded: { credits: 270, sar: 225 } });
    const u = (await getUser(email))!;
    expect([u.credits, monthlyCredits(u)]).toEqual([10, 10]);
    expect(lotsOf(u)[0]).toMatchObject({ id: l.id, left: 0, refund: { credits: 270, sar: 225, on: day(), ref: "RF-SECRET-1", by: "key" } });
    // The refunded credits are gone: a charge can spend only the 10 plan credits.
    expect(await charge(email, 11)).toEqual({ ok: false, reason: "no_credits", credits: 10, need: 11 });
  });

  it("refused, with nothing changed: expired, voided, already refunded, given for nothing, nothing left, a changed balance, a day before the payment", async () => {
    // Expired: once it is gone from the account, its payment says why.
    const a = await paid();
    const la = await pack(a, 100);
    const ua = (await getUser(a))!;
    await saveUser({ ...ua, topups: ua.topups!.map((l) => ({ ...l, expiresAt: new Date(Date.now() - DAY).toISOString() })) });
    expect(await refundPaidTopup(a, la.id, ask(100), "key")).toEqual({ ok: false, error: "topup_expired" });
    // And on a record not yet settled, the pure check refuses it too.
    const stale = { credits: 100, topups: [{ ...la, expiresAt: new Date(Date.now() - 1).toISOString() }] };
    expect(refundUnused(stale, la.id, { expected: 100, on: day(), ref: "x", by: "key" })).toEqual({ ok: false, error: "topup_expired" });
    expect(stale.credits).toBe(100);

    const b = await paid();
    const lb = await pack(b, 100);
    expect((await voidPaidTopup(b, lb.id, "key", "bounced")).ok).toBe(true);
    expect(await refundPaidTopup(b, lb.id, ask(100), "key")).toEqual({ ok: false, error: "topup_voided" });

    const c = await paid();
    const lc = await pack(c, 300);
    expect((await refundPaidTopup(c, lc.id, ask(300), "key")).ok).toBe(true);
    const once = (await payments(c))[lc.paymentId!];
    expect(await refundPaidTopup(c, lc.id, ask(300), "key"), "a second refund").toEqual({ ok: false, error: "topup_refunded" });
    expect((await payments(c))[lc.paymentId!]).toEqual(once);

    const d = await paid();
    const ld = await pack(d, 100, 0);
    expect(await refundPaidTopup(d, ld.id, ask(100), "key")).toEqual({ ok: false, error: "topup_not_paid" });

    const e = await paid();
    const le = await pack(e, 100);
    ok(await charge(e, 100, meta(e)));
    expect(await refundPaidTopup(e, le.id, ask(1), "key")).toEqual({ ok: false, error: "nothing_left" });

    const f = await paid();
    const lf = await pack(f, 300);
    ok(await charge(f, 30, meta(f)));
    expect(await refundPaidTopup(f, lf.id, ask(300), "key"), "the founder was shown 300").toEqual({ ok: false, error: "left_changed", left: 270, sar: 270 });
    expect(await refundPaidTopup(f, lf.id, ask(270, { on: day(-1) }), "key"), "a transfer before the payment").toEqual({ ok: false, error: "bad_date" });
    expect(await refundPaidTopup(f, "0123456789abcdef", ask(270), "key")).toEqual({ ok: false, error: "topup_not_found" });
    expect(await refundPaidTopup("nobody@test.example", lf.id, ask(270), "key")).toEqual({ ok: false, error: "not_found" });
    expect((await lotOf(f, lf.id))!.left).toBe(270);
    expect((await lotOf(f, lf.id))!.refund).toBeUndefined();
    expect((await getUser(f))!.credits).toBe(270);
  });

  it("a charge racing the refund never spends refunded credits: every credit is either spent or refunded, once", async () => {
    const email = await paid(0);
    const l = await pack(email, 300);
    const charges = Array.from({ length: 10 }, () => charge(email, 20, meta(email)));
    // The founder's console re-reads what is left and asks again when a charge landed first.
    let r = await refundPaidTopup(email, l.id, ask(300), "key");
    for (let i = 0; i < 20 && !r.ok && r.error === "left_changed"; i++) r = await refundPaidTopup(email, l.id, ask(r.left!), "key");
    const done = await Promise.all(charges);
    if (!r.ok) throw new Error(r.error);
    const spent = done.filter((x) => x.ok).length * 20;
    expect(spent + r.refunded.credits, "spent + refunded = the pack").toBe(300);
    expect(r.refunded.sar).toBe(r.refunded.credits);
    const u = (await getUser(email))!;
    expect([u.credits, lotsOf(u)[0].left]).toEqual([0, 0]);
    for (const x of done) if (!x.ok) expect(x).toMatchObject({ reason: "no_credits" });
    expect((await payments(email))[l.paymentId!].refund).toMatchObject({ credits: r.refunded.credits, sar: r.refunded.sar });
  });

  it("parseTopupRefund checks the credits shown, the transfer day and its reference before anything is read", () => {
    const at = Date.parse("2026-10-01T10:00:00Z"); // 13:00 in Riyadh
    const good = { credits: 120, on: "2026-10-01", ref: "  TR\n-9 " };
    expect(parseTopupRefund(good, at)).toEqual({ ok: true, refund: { credits: 120, on: "2026-10-01", ref: "TR -9" } });
    for (const credits of [0, -1, 1.5, "120", 1001, NaN, null]) expect(parseTopupRefund({ ...good, credits }, at), String(credits)).toEqual({ ok: false, error: "bad_credits" });
    for (const on of ["2026-10-02", "2026-02-30", "01/10/2026", "2025-09-29", 20261001]) expect(parseTopupRefund({ ...good, on }, at), String(on)).toEqual({ ok: false, error: "bad_date" });
    for (const ref of [undefined, "", "   ", 42, "x".repeat(81)]) expect(parseTopupRefund({ ...good, ref }, at), String(ref)).toEqual({ ok: false, error: "bad_ref" });
    expect(parseTopupRefund(null, at)).toEqual({ ok: false, error: "bad_credits" });
  });
});

describe("a failed charge's credits owed to a pack that is gone or refunded go to the plan credits (rule 461)", () => {
  it("a charge taken from a pack before its refund, refunded after it, comes back as plan credits", async () => {
    const email = await paid(0);
    const l = await pack(email, 100);
    const c = ok(await charge(email, 40, meta(email)));
    expect(c.from).toEqual({ monthly: 0, lots: [{ id: l.id, n: 40 }] });
    const r = await refundPaidTopup(email, l.id, ask(60), "key");
    expect(r.ok && r.refunded).toEqual({ credits: 60, sar: 60 });
    await refund(email, 40, c);
    const u = (await getUser(email))!;
    expect([u.credits, monthlyCredits(u), lotsOf(u)[0].left], "the refunded pack takes nothing back").toEqual([40, 40, 0]);
  });

  it("returnCredits: gone, expired and refunded packs give to the plan credits; a live full pack still drops a second refund", () => {
    const now = Date.now();
    const lot = (id: string, left: number, extra: Partial<TopupLot> = {}): TopupLot => ({ id, credits: 100, left, at: new Date(now).toISOString(), expiresAt: new Date(now + DAY).toISOString(), paidSar: 100, paidOn: day(), ref: "", by: "key", ...extra });
    const refunded = lot("r", 0, { refund: { credits: 60, sar: 60, on: day(), ref: "x", at: new Date(now).toISOString(), by: "key" } });
    const expired = lot("e", 10, { expiresAt: new Date(now - 1).toISOString() });
    const full = lot("f", 100);
    const u = { credits: 110, topups: [refunded, expired, full] };
    const back = returnCredits(u, 75, { monthly: 5, lots: [{ id: "gone", n: 10 }, { id: "r", n: 20 }, { id: "e", n: 30 }, { id: "f", n: 10 }] }, now);
    expect(back).toEqual({ dropped: 10, toPlan: 60 });
    expect(u.credits, "110 + 60 to the plan + 5 monthly").toBe(175);
    expect([refunded.left, expired.left, full.left]).toEqual([0, 10, 100]);
  });

  it("settleTopups keeps a refunded pack empty whatever its stored left says", async () => {
    const email = await paid(5);
    const l = await pack(email, 100);
    expect((await refundPaidTopup(email, l.id, ask(100), "key")).ok).toBe(true);
    const u = (await getUser(email))!;
    await saveUser({ ...u, credits: 105, topups: u.topups!.map((x) => ({ ...x, left: 100 })) });
    const v = (await getUser(email))!;
    expect([v.credits, lotsOf(v)[0].left, monthlyCredits(v)]).toEqual([105, 0, 105]);
  });
});

describe("the refund is recorded on the pack's payment and the commission drops in proportion, once (rule 462)", () => {
  it("commissionAfterRefund: the commission less commission × refunded / paid, each to the halala", () => {
    expect(commissionAfterRefund(300, 120)).toBe(27); // 45 − 45 × 120 / 300
    expect(commissionAfterRefund(287.5, 95.83)).toBe(28.75); // 43.13 − round(43.13 × 95.83 / 287.50)
    expect(commissionAfterRefund(300, 0)).toBe(commissionSar(300));
    expect(commissionAfterRefund(300, 300)).toBe(0);
    expect(commissionAfterRefund(300, 500), "a refund never counts for more than the payment").toBe(0);
    expect(commissionAfterRefund(0, 0)).toBe(0);
    expect(commissionAfterRefund(300, NaN)).toBe(commissionSar(300));
  });

  it("a referred customer's pack: the payment carries the refund, the ledger row its kept base, and later settles keep it", async () => {
    const { customer, partner } = await referred(3);
    const plan = await recordPayment(customer, { amountSar: 299, plan: "starter", date: day(-1), reference: "PLAN-1" }, "key");
    if (!plan.ok) throw new Error(plan.error);
    const l = await pack(customer, 300);
    expect((await payments(customer))[l.paymentId!].commission?.sar).toBe(45);
    ok(await charge(customer, 180, meta(customer)));
    const r = await refundPaidTopup(customer, l.id, ask(120, { ref: "RF-77" }), "key");
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ refunded: { credits: 120, sar: 120 }, commissionBefore: 45, payment: { id: l.paymentId, amountSar: 300, commission: { partner, sar: 27 }, refund: { credits: 120, sar: 120, date: day(), reference: "RF-77", by: "key" } } });
    const row = (await ledger(partner)).find((x) => x.id === l.paymentId)!;
    expect(row).toMatchObject({ kind: "commission", sar: 27, baseSar: 180, refundSar: 120 });
    expect(row.voidedAt).toBeUndefined();

    // Every later decision re-derives the same cut from the one refund record: never taken twice.
    const later = await recordPayment(customer, { amountSar: 299, plan: "starter", date: day(), reference: "PLAN-2" }, "key");
    expect(later.ok).toBe(true);
    expect((await payments(customer))[l.paymentId!].commission?.sar).toBe(27);
    const live = (await ledger(partner)).filter((x) => x.kind === "commission" && !x.voidedAt);
    expect(live.map((x) => (x.kind === "commission" ? x.sar : 0)).sort((x, y) => x - y)).toEqual([27, commissionSar(299), commissionSar(299)].sort((x, y) => x - y));
  });

  it("a pack refunded in full keeps no commission: the payment says refunded and the ledger row is voided", async () => {
    const { customer, partner } = await referred(1);
    const l = await pack(customer, 100);
    const r = await refundPaidTopup(customer, l.id, ask(100), "key");
    if (!r.ok) throw new Error(r.error);
    expect(r.payment).toMatchObject({ notCounted: "refunded", refund: { credits: 100, sar: 100 } });
    expect(r.payment!.commission).toBeUndefined();
    expect((await ledger(partner)).find((x) => x.id === l.paymentId)!.voidedAt).toBeTruthy();
  });

  it("top-up revenue counts what was kept: the amount paid less the refund, in the payment's month", async () => {
    const m = (paidSar: number, refund?: number): { topups: TopupLot[] } => ({ topups: [{ id: String(paidSar), credits: 300, left: 0, at: "", expiresAt: "", paidSar, paidOn: "2026-10-05", ref: "", by: "key", ...(refund !== undefined ? { refund: { credits: 1, sar: refund, on: "2026-10-06", ref: "", at: "", by: "key" } } : {}) }] });
    expect(topupRevenueSar([m(300, 120), m(100.1), m(50, 50)], "2026-10")).toBe(280.1);
    const email = await paid(0, "pro");
    const before = (await overview()).revenue.topupSarMonth;
    const l = await pack(email, 300, 250);
    expect((await refundPaidTopup(email, l.id, ask(300), "key")).ok).toBe(true);
    const after = (await overview()).revenue.topupSarMonth;
    expect(Math.round((after - before) * 100) / 100, "a full refund leaves nothing").toBe(0);
  });

});

describe("POST /api/admin/topups refund: founder only, checked, logged without references (rule 463)", () => {
  beforeEach(async () => { jar().clear(); await adminSignIn(); });

  it("founder only, and every field is checked before anything is read or written", async () => {
    const email = await paid(0);
    const l = await pack(email, 300);
    const good = { email, action: "refund", id: l.id, credits: 300, on: day(), ref: "RF-1" };
    const logged = (await db.lrange("admin:log", 0, -1)).length;
    jar().clear();
    expect((await post(good)).status).toBe(401);
    await adminSignIn();
    const cases: [Record<string, unknown>, number, string][] = [
      [{ ...good, credits: 0 }, 400, "bad_credits"],
      [{ ...good, credits: "300" }, 400, "bad_credits"],
      [{ ...good, on: ksaDay(Date.now() + DAY) }, 400, "bad_date"],
      [{ ...good, on: "2026-02-30" }, 400, "bad_date"],
      [{ ...good, ref: "" }, 400, "bad_ref"],
      [{ ...good, ref: "x".repeat(81) }, 400, "bad_ref"],
      [{ ...good, id: "../../user" }, 400, "bad_id"],
      [{ ...good, refundId: "rf_XYZ" }, 400, "bad_id"],
      [{ ...good, email: "nobody@test.example" }, 404, "not_found"],
      [{ ...good, id: "0123456789abcdef" }, 404, "topup_not_found"],
      [{ ...good, credits: 299 }, 409, "left_changed"],
    ];
    for (const [body, status, error] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(((await res.json()) as { error: string }).error, JSON.stringify(body)).toBe(error);
    }
    expect((await lotOf(email, l.id))!).toMatchObject({ left: 300 });
    expect((await lotOf(email, l.id))!.refund).toBeUndefined();
    expect((await db.lrange("admin:log", 0, -1)).length, "a refused request is not logged").toBe(logged);
  });

  it("refunds, logs the credits, the amount and the commission without either reference, and knows a retry", async () => {
    const { customer } = await referred(2);
    const l = await pack(customer, 300);
    ok(await charge(customer, 180, meta(customer)));
    const refundId = rfId();
    const body = { email: customer, action: "refund", id: l.id, credits: 120, on: day(), ref: "RF-SECRET-55", refundId, reason: "customer asked on WhatsApp" };
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, credits: 0, topupCredits: 0, refunded: { credits: 120, sar: 120 }, already: false, payment: { commission: { sar: 27 } } });
    const log = JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as Record<string, unknown>;
    expect(log).toMatchObject({ actor: "key", email: customer, what: `topup_refund:300 removed:120 sar:120 payment:${l.paymentId} commission:45->27`, before: { credits: 120 }, after: { credits: 0 }, refund: { credits: 120, sar: 120, on: day() }, reason: "customer asked on WhatsApp" });
    for (const secret of ["RF-SECRET-55", "TRX-PACK"]) expect(JSON.stringify(log), secret).not.toContain(secret);

    const logged = (await db.lrange("admin:log", 0, -1)).length;
    const retry = await post(body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, already: true, refunded: { credits: 120, sar: 120 } });
    expect((await db.lrange("admin:log", 0, -1)).length, "a retry is not logged twice").toBe(logged);
    const other = await post({ ...body, refundId: rfId() });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ ok: false, error: "topup_refunded" });
  });

  it("409 for an expired or voided pack; a refund that stopped before its payment was marked is finished by the next request", async () => {
    const a = await paid(0);
    const la = await pack(a, 100);
    const ua = (await getUser(a))!;
    await saveUser({ ...ua, topups: ua.topups!.map((l) => ({ ...l, expiresAt: new Date(Date.now() - DAY).toISOString() })) });
    const expired = await post({ email: a, action: "refund", id: la.id, credits: 100, on: day(), ref: "RF" });
    expect([expired.status, ((await expired.json()) as { error: string }).error]).toEqual([409, "topup_expired"]);
    const b = await paid(0);
    const lb = await pack(b, 100);
    expect((await post({ email: b, action: "void", id: lb.id })).status).toBe(200);
    const voided = await post({ email: b, action: "refund", id: lb.id, credits: 100, on: day(), ref: "RF" });
    expect([voided.status, ((await voided.json()) as { error: string }).error]).toEqual([409, "topup_voided"]);

    // The credits left (saved first), the payment not marked yet: the request died in between.
    const { customer } = await referred(1);
    const lc = await pack(customer, 300);
    const u = (await getUser(customer))!;
    const half = refundUnused(u, lc.id, { expected: 300, on: day(), ref: "RF-HALF", by: "key" });
    expect(half.ok).toBe(true);
    await saveUser(u);
    expect((await payments(customer))[lc.paymentId!].refund).toBeUndefined();
    const finish = await post({ email: customer, action: "refund", id: lc.id, credits: 300, on: day(), ref: "RF-HALF" });
    expect(finish.status).toBe(200);
    expect(await finish.json()).toMatchObject({ ok: true, completed: true, refunded: { credits: 300, sar: 300 }, payment: { notCounted: "refunded", refund: { credits: 300, sar: 300, reference: "RF-HALF" } } });
    expect((await getUser(customer))!.credits, "nothing left twice").toBe(0);
  });

  it("the console shows the amount, sends the credits it showed and one request id through adminFetch; Payments shows the refund", () => {
    const src = adminConsoleSrc();
    expect(src).toContain('import { unusedRefundSar } from "@/lib/topups";');
    expect(src).toContain("if (!confirm(S.confirmRefund(l.left, l.credits, sarText(unusedRefundSar(l))))) return;");
    expect(src).toContain('const ask = { email: u.email, action: "refund", id: l.id, credits: l.left, on: on.trim(), ref };');
    expect(src).toContain("if (pendingRefund.current?.key !== key) pendingRefund.current = { key, id: newRefundId() };");
    expect(src).toContain('await adminFetch("/api/admin/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...ask, refundId: pendingRefund.current.id, reason }) });');
    expect(src).toContain("if (j.ok || (r.status >= 400 && r.status < 500)) pendingRefund.current = null;");
    expect(src).toContain("l.paidSar > 0 && l.left > 0 && <button");
    expect(src).toContain("data-topup-refund-note");
    expect(src).not.toMatch(/[^n]fetch\("\/api\/admin\/topups"/);
    for (const [lang, re] of [["en", /Refund unused[\s\S]*only when the customer asks, before the pack expires[\s\S]*excluding VAT/], ["ar", /استرداد غير المستخدم[\s\S]*فقط إذا طلبه العميل، وقبل انتهاء الباقة[\s\S]*دون الضريبة/]] as const) expect(src, lang).toMatch(re);
    const panel = readFileSync("src/components/admin/PaymentsPanel.tsx", "utf8");
    expect(panel).toContain("data-payment-refund");
    expect(panel).toContain('refunded: "refunded in full"');
    expect(panel).toContain('refunded: "استُردت كاملة"');
  });
});

describe("the owner is told unused top-up credits can be refunded; a refunded pack is not listed (rule 464)", () => {
  type AsyncPage = (p: { params: Promise<{ lang: string }> }) => Promise<ReactElement>;
  const billing = async (lang: "ar" | "en") => renderToStaticMarkup(await (BillingPage as unknown as AsyncPage)({ params: Promise.resolve({ lang }) }));
  const EN = "Unused top-up credits can be refunded on request before they expire.";
  const AR = "يمكن استرداد كريدت باقات الشحن غير المستخدم عند الطلب قبل انتهاء صلاحيته.";

  it("the billing page's top-up card says it in both languages, to the owner, a member and a trial", async () => {
    const email = await paid(300);
    await signIn(email);
    expect(await billing("en")).toContain(EN);
    expect(await billing("ar")).toContain(AR);
    const m = await newMember((await getUser(email))!, "admin");
    await signIn(m.email);
    expect(await billing("en")).toContain(EN);
    const t = await newUser("trftrial");
    await signIn(t.email);
    expect(await billing("en")).toContain(EN);
  });

  it("the terms say it as the one exception to non-refundable credits, in both languages", () => {
    const terms = (lang: "ar" | "en") => LEGAL[lang].terms.sections.flatMap((s) => s.p).join(" ");
    expect(terms("en")).toContain("Credits are non-refundable and non-transferable, except that unused top-up credits can be refunded on request before they expire.");
    expect(terms("ar")).toContain("إلا أن كريدت باقات الشحن غير المستخدم يمكن استرداده عند الطلب قبل انتهاء صلاحيته");
    expect(LEGAL.en.terms.updated).toBe("Last updated: 2026-10-02");
    expect(LEGAL.en.privacy.updated, "the privacy policy did not change").toBe("Last updated: 2026-10-01");
  });

  it("a refunded pack is not listed on the billing page or sent by the profile; the console still shows it", async () => {
    const email = await paid(10);
    const kept = await pack(email, 100);
    const gone = await pack(email, 300);
    expect((await refundPaidTopup(email, gone.id, ask(300), "key")).ok).toBe(true);
    expect(openLots((await getUser(email))!).map((l) => l.id)).toEqual([kept.id]);
    await signIn(email);
    const html = await billing("en");
    expect(html).toContain(`data-lot="${kept.id}"`);
    expect(html).not.toContain(`data-lot="${gone.id}"`);
    const body = (await (await profileRoute.GET()).json()) as { user: { credits: number; topups: unknown } };
    expect(body.user.credits).toBe(110);
    expect(body.user.topups).toEqual([{ credits: 100, left: 100, expiresAt: kept.expiresAt }]);
    expect(lotsOf((await getUser(email))!).map((l) => l.id).sort(), "the founder's record keeps both").toEqual([kept.id, gone.id].sort());
  });
});

describe("a refund that stopped halfway can be finished, and a pack's missing payment is recorded with its refund (rule 465)", () => {
  beforeEach(async () => { jar().clear(); await adminSignIn(); });
  const detail = async (email: string) =>
    (await (await adminUser.GET(json("/api/admin/users/x", "GET"), params({ email: encodeURIComponent(email) }))).json()) as { unfinishedRefunds: string[]; user: { topups: TopupLot[] } };
  /** A referred customer's 300-credit pack, 200 credits spent, whose refund of the 100 left stopped after the credits left. */
  async function stopped(): Promise<{ customer: string; partner: string; lot: TopupLot }> {
    const { customer, partner } = await referred(1);
    const lot = await pack(customer, 300);
    ok(await charge(customer, 200, meta(customer)));
    const u = (await getUser(customer))!;
    expect(refundUnused(u, lot.id, { expected: 100, on: day(), ref: "RF-STOP", by: "key", id: rfId() }).ok).toBe(true);
    await saveUser(u);
    return { customer, partner, lot };
  }

  it("the console's actual request (no credits, day or reference) finishes it: the payment carries the refund, the commission drops once", async () => {
    const { customer, partner, lot } = await stopped();
    expect((await payments(customer))[lot.paymentId!].commission, "the full commission before it is finished").toEqual({ partner, sar: 45 });
    expect((await detail(customer)).unfinishedRefunds, "the console is told which pack to finish").toEqual([lot.id]);
    // Exactly what the Users section's `finishRefund` posts (src/components/admin/Users.tsx).
    const body = { email: customer, action: "refund", id: lot.id, finish: true };
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, completed: true, credits: 0, refunded: { credits: 100, sar: 100 }, payment: { commission: { sar: 30 }, refund: { credits: 100, sar: 100, reference: "RF-STOP" } } });
    expect(JSON.parse((await db.lrange("admin:log", 0, 0))[0]).what).toBe(`topup_refund:300 removed:100 sar:100 payment:${lot.paymentId} commission:45->30 completed`);
    expect((await ledger(partner)).filter((r) => r.kind === "commission" && !r.voidedAt)).toMatchObject([{ sar: 30, baseSar: 200, refundSar: 100 }]);
    expect((await detail(customer)).unfinishedRefunds).toEqual([]);
    const logged = (await db.lrange("admin:log", 0, -1)).length;
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, already: true, completed: false });
    expect((await db.lrange("admin:log", 0, -1)).length, "nothing to do is not logged").toBe(logged);
    expect((await getUser(customer))!.credits, "nothing refunded twice").toBe(0);
  });

  it("finish on a pack never refunded is 409 not_refunded and changes nothing; the console offers it only on an unfinished refund", async () => {
    const email = await paid(0);
    const l = await pack(email, 100);
    const res = await post({ email, action: "refund", id: l.id, finish: true });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([409, "not_refunded"]);
    expect((await lotOf(email, l.id))!).toMatchObject({ left: 100 });
    expect((await lotOf(email, l.id))!.refund).toBeUndefined();
    const src = adminConsoleSrc();
    expect(src).toContain('body: JSON.stringify({ email: u.email, action: "refund", id: l.id, finish: true })');
    expect(src).toContain("sel.unfinishedRefunds?.includes(l.id) && ");
    expect(src).toContain('finishRefund: "Finish refund"');
    expect(src).toContain('finishRefund: "إكمال الاسترداد"');
  });

  it("any later payment on the account copies the pack's refund onto its payment, so the full commission never stands", async () => {
    const { customer, partner, lot } = await stopped();
    const plan = await recordPayment(customer, { id: payId(), amountSar: 299, plan: "starter", date: day() }, "key");
    expect(plan.ok).toBe(true);
    expect((await payments(customer))[lot.paymentId!]).toMatchObject({ commission: { partner, sar: 30 }, refund: { credits: 100, sar: 100, date: day(), reference: "RF-STOP" } });
    expect((await detail(customer)).unfinishedRefunds).toEqual([]);
  });

  it("an Add top-up that stopped before its payment: the refund records that payment with the refund, and the retried add finds it", async () => {
    const { customer, partner } = await referred(1);
    const id = payId();
    // "Add top-up" stopped after the pack and before its payment.
    const added = await addTopup(customer, { credits: 300, paidSar: 300, paidOn: day(), ref: "TRX-STOP", by: "key", paymentId: id });
    expect(added.ok).toBe(true);
    const lot = (added as { lot: TopupLot }).lot;
    expect(await payments(customer)).toEqual({});
    ok(await charge(customer, 200, meta(customer)));
    const r = await refundPaidTopup(customer, lot.id, ask(100), "key");
    expect(r).toMatchObject({ ok: true, refunded: { credits: 100, sar: 100 }, payment: { id, amountSar: 300, date: day(), topup: { lot: lot.id, credits: 300 }, commission: { partner, sar: 30 }, refund: { credits: 100, sar: 100 } } });
    expect((await ledger(partner)).filter((x) => x.kind === "commission" && !x.voidedAt)).toMatchObject([{ id, sar: 30, baseSar: 200 }]);
    const again = await addPaidTopup(customer, { credits: 300, paidSar: 300, paidOn: day(), ref: "TRX-STOP", paymentId: id }, "key");
    expect(again).toMatchObject({ ok: true, already: true, payment: { id, commission: { sar: 30 }, refund: { sar: 100 } } });
    expect(Object.keys(await payments(customer))).toEqual([id]);
    expect((await getUser(customer))!.credits).toBe(0);
  });

  it("on an account no longer on a paid plan, a pack with a missing payment is refused (409 payment_missing) with nothing changed", async () => {
    const email = await paid(0);
    const added = await addTopup(email, { credits: 100, paidSar: 100, paidOn: day(), ref: "TRX", by: "key", paymentId: payId() });
    expect(added.ok).toBe(true);
    const lot = (added as { lot: TopupLot }).lot;
    await saveUser({ ...(await getUser(email))!, plan: "trial" });
    const res = await post({ email, action: "refund", id: lot.id, credits: 100, on: day(), ref: "RF" });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([409, "payment_missing"]);
    expect((await lotOf(email, lot.id))!).toMatchObject({ left: 100 });
    expect(await payments(email)).toEqual({});
  });
});

describe("the partner terms say a partly refunded payment's commission is reduced in proportion (rule 466)", () => {
  it("both languages, at the new version", () => {
    expect(PARTNER_TERMS_VERSION).toBe("2026-10-02");
    const en = PARTNER_TERMS.en.sections.find((s) => s.id === "payouts")!.p.join(" ");
    const ar = PARTNER_TERMS.ar.sections.find((s) => s.id === "payouts")!.p.join(" ");
    expect(en).toContain("Commission on a refunded or voided payment is cancelled; when only part of a payment is refunded, its commission is reduced in proportion to the amount refunded.");
    expect(ar).toContain("إذا استُردّت دفعة كاملةً أو أُلغيت، تُلغى عمولتها؛ وإذا استُرد جزء منها، تُخفَّض عمولتها بنسبة المبلغ المسترد.");
    // What the terms say is what `settle` pays: commission × (paid − refunded) / paid.
    expect(commissionAfterRefund(300, 100)).toBe(commissionSar(300) - commissionSar(100));
  });
});
