import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { adminSignIn, jar, json, newMember, newUser, params } from "./helpers/session";
import { getUser, saveUser, type Plan, type User } from "@/lib/auth";
import { chargeOnce, monthKey, refundOnce, resolveOnceHolds, voidTopup, type AgentCharge } from "@/lib/credits";
import { db } from "@/lib/db";
import { commissionSar, ksaDay, type LedgerRow } from "@/lib/partner-rules";
import { addPaidTopup, approvePartner, paymentsView, recordPayment, voidPayment, type Payment } from "@/lib/partners";
import { lotsOf, monthlyCredits, parseTopup, creditSplit } from "@/lib/topups";
import { appDict } from "@/lib/app-i18n";
import { noCreditsText } from "@/components/app/LimitModal";
import ProfilePanel from "@/components/app/ProfilePanel";
import { shortOfCredits } from "@/components/app/MediaControls";
import { firstMonthPriceSar } from "@/lib/pricing";
import * as topupsRoute from "@/app/api/admin/topups/route";
import * as adminPayments from "@/app/api/admin/payments/[email]/route";

/**
 * Credit top-ups after main's partner programme (#236) came in, and the review findings on PR #239: rules 454-459 in
 * docs/system/tests.md. A pack is a customer payment: "Add top-up" records it through the same path as every payment
 * (src/lib/partners.ts `recordPayment` and `settle`), so a referred customer's top-up inside the partner's 4 months earns
 * 15% of the amount before VAT, exactly once, and voiding the pack voids the payment and the commission.
 */

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app/profile",
  useSearchParams: () => new URLSearchParams(),
}));

const KEY = "topup-payments-admin-key-0123456789";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
afterEach(() => { vi.useRealTimers(); });

const DAY = 864e5;
const day = (offsetDays = 0) => ksaDay(Date.now() + offsetDays * DAY);
const payId = () => `pay_${randomBytes(9).toString("hex")}`;
const ok = (r: AgentCharge) => { if (!r.ok) throw new Error(r.reason); return r; };

/** An owner on a paid plan whose month's plan credits are `monthly` (renewed this month, so no renewal is due). */
async function paid(monthly = 300, plan: Plan = "starter"): Promise<string> {
  const u = await newUser("tpay");
  await saveUser({ ...(await getUser(u.email))!, plan, credits: monthly, renewedAt: monthKey() });
  return u.email;
}
/** An approved partner, and a paying customer attributed to it `daysAgo` days ago (by code). */
async function referred(daysAgo = 1): Promise<{ customer: string; partner: string }> {
  const p = await newUser("tpartner");
  const code = `TP${randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 12);
  const a = await approvePartner({ email: p.email, code, name: "Partner", consentOutOfBand: true }, "key");
  if (!a.ok) throw new Error(a.error);
  const customer = await paid(300);
  const u = (await getUser(customer))!;
  await saveUser({ ...u, referredBy: { partner: p.email, code, at: new Date(Date.now() - daysAgo * DAY).toISOString(), via: "code", ref: randomBytes(6).toString("hex") } });
  return { customer, partner: p.email };
}
const payments = async (email: string) => db.hgetall<Payment>(`payments:${email}`);
const ledger = async (email: string) => Object.values(await db.hgetall<LedgerRow>(`partner:ledger:${email}`));
const post = (body: Record<string, unknown>) => topupsRoute.POST(json("/api/admin/topups", "POST", body));
const add = (email: string, extra: Record<string, unknown> = {}) => post({ email, action: "add", credits: 300, paidSar: 300, paidOn: day(), ref: "TRX-T", ...extra });
const payRoute = (email: string, b: Record<string, unknown>) =>
  adminPayments.POST(json(`/api/admin/payments/${encodeURIComponent(email)}`, "POST", b), params({ email: encodeURIComponent(email) }));
type AddBody = { ok: boolean; error?: string; already?: boolean; credits: number; lot: { id: string; paymentId?: string }; payment: Payment | null };

describe("a pack is a customer payment: 'Add top-up' records it with the partner's commission, once (rule 454)", () => {
  beforeEach(async () => { jar().clear(); await adminSignIn(); });

  it("a referred customer's top-up inside the 4 months earns 15% of the amount before VAT, through the same path as any payment", async () => {
    const { customer, partner } = await referred(5);
    const first = await recordPayment(customer, { amountSar: 299, plan: "starter", date: day(-3), reference: "PLAN-1" }, "key");
    expect(first.ok && first.payment.commission?.sar).toBe(commissionSar(299));
    const id = payId();
    const res = await add(customer, { paymentId: id, paidSar: 287.5 });
    expect(res.status).toBe(200);
    const b = (await res.json()) as AddBody;
    expect(b.lot.paymentId).toBe(id);
    expect(b.payment).toMatchObject({ id, amountSar: 287.5, plan: "starter", date: day(), reference: "TRX-T", topup: { lot: b.lot.id, credits: 300 }, commission: { partner, sar: commissionSar(287.5) } });
    expect(commissionSar(287.5)).toBe(43.13);
    expect(b.payment!.offer, "a top-up never takes the first-month offer").toBeUndefined();
    const rows = (await ledger(partner)).filter((r) => r.kind === "commission" && !r.voidedAt);
    expect(rows.map((r) => [r.id, r.kind === "commission" ? r.sar : 0]).sort()).toEqual([[first.ok ? first.payment.id : "", commissionSar(299)], [id, commissionSar(287.5)]].sort());
    const log = JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { what: string };
    expect(log.what).toBe(`topup:+300 payment:${id} commission:${commissionSar(287.5)}`);
    expect(JSON.stringify(log), "the reference stays on the pack and the payment").not.toContain("TRX-T");
  });

  it("a retried request adds one pack, records one payment and one commission, and logs once", async () => {
    const { customer, partner } = await referred(2);
    const id = payId();
    const logged = (await db.lrange("admin:log", 0, -1)).length;
    const a = (await (await add(customer, { paymentId: id })).json()) as AddBody;
    const b = (await (await add(customer, { paymentId: id })).json()) as AddBody;
    expect(a.already).toBe(false);
    expect(b).toMatchObject({ ok: true, already: true, credits: 600, lot: { id: a.lot.id } });
    expect(lotsOf((await getUser(customer))!).map((l) => l.id)).toEqual([a.lot.id]);
    expect(Object.keys(await payments(customer))).toEqual([id]);
    expect((await ledger(partner)).filter((r) => r.id === id)).toHaveLength(1);
    expect((await db.lrange("admin:log", 0, -1)).length - logged).toBe(1);
    // A request that failed after the pack went on (the payment not recorded yet) is completed by its retry.
    const half = payId();
    const lib = await addPaidTopup(customer, { credits: 100, paidSar: 100, paidOn: day(), ref: "", paymentId: half }, "key");
    expect(lib.ok).toBe(true);
    await db.hdel(`payments:${customer}`, half);
    const again = (await (await add(customer, { paymentId: half, credits: 100, paidSar: 100, ref: "" })).json()) as AddBody;
    expect(again).toMatchObject({ already: true, payment: { id: half, topup: { credits: 100 } } });
    expect(lotsOf((await getUser(customer))!)).toHaveLength(2);
  });

  it("no commission past the partner's 4 months, none without a partner, no payment when nothing was paid", async () => {
    const { customer, partner } = await referred(200);
    expect((await recordPayment(customer, { amountSar: 299, plan: "starter", date: day(-190) }, "key")).ok).toBe(true);
    const late = (await (await add(customer, { paymentId: payId() })).json()) as AddBody;
    expect(late.payment).toMatchObject({ notCounted: "window" });
    expect(late.payment!.commission).toBeUndefined();
    expect((await ledger(partner)).filter((r) => r.id === late.payment!.id)).toEqual([]);

    const plain = await paid(0);
    const p = (await (await add(plain, { paymentId: payId() })).json()) as AddBody;
    expect(p.payment!.commission).toBeUndefined();
    expect(p.payment!.notCounted).toBeUndefined();

    const free = (await (await add(plain, { paymentId: payId(), paidSar: 0 })).json()) as AddBody;
    expect(free.ok).toBe(true);
    expect(free.payment, "a pack given for nothing records no payment").toBeNull();
    expect(Object.values(await payments(plain))).toHaveLength(1);
  });

  it("a top-up never takes the first-month offer, and an id already used by a plan payment is refused before anything is written", async () => {
    const email = await paid(0);
    const u = (await getUser(email))!;
    await saveUser({ ...u, firstMonthOffer: { kind: "partner", pct: 15, at: new Date(Date.now() - DAY).toISOString() } });
    const t = (await (await add(email, { paymentId: payId() })).json()) as AddBody;
    expect(t.payment!.offer).toBeUndefined();
    expect((await getUser(email))!.firstMonthOffer!.usedAt).toBeUndefined();

    const plan = await recordPayment(email, { amountSar: 299, plan: "starter", date: day() }, "key");
    if (!plan.ok) throw new Error(plan.error);
    const before = (await getUser(email))!.credits;
    const clash = await add(email, { paymentId: plan.payment.id });
    expect(clash.status).toBe(400);
    expect(await clash.json()).toEqual({ ok: false, error: "bad_id" });
    expect((await getUser(email))!.credits).toBe(before);
  });

  it("a pack recorded before the plan's first payment leaves the offer open: the plan payment after it, backdated or not, takes it", async () => {
    for (const planDay of [-2, 0]) {
      const email = await paid(0);
      const u = (await getUser(email))!;
      await saveUser({ ...u, firstMonthOffer: { kind: "partner", pct: 15, at: new Date(Date.now() - 5 * DAY).toISOString() } });
      const t = (await (await add(email, { paymentId: payId() })).json()) as AddBody;
      expect(t.payment!.offer).toBeUndefined();
      let now = (await getUser(email))!;
      expect(now.firstPaidOn, "a pack's payment is not the plan's first payment").toBeUndefined();
      expect(now.firstMonthOffer!.usedAt).toBeUndefined();
      expect((await paymentsView(email))!.open, "the console still shows the offer open").toBe(true);

      const plan = await recordPayment(email, { amountSar: firstMonthPriceSar("starter"), plan: "starter", date: day(planDay) }, "key");
      if (!plan.ok) throw new Error(plan.error);
      expect(plan.payment, `plan payment dated ${planDay}`).toMatchObject({ offer: "partner", expectedSar: firstMonthPriceSar("starter") });
      now = (await getUser(email))!;
      expect(now.firstMonthOffer).toMatchObject({ paymentId: plan.payment.id });
      expect(now.firstMonthOffer!.usedAt).toBeTruthy();
      expect(now.firstPaidOn, "the first payment day is the plan payment's").toBe(day(planDay));

      // Voiding the plan payment reopens the offer although the pack's payment still stands.
      expect((await voidPayment(email, plan.payment.id, "key", "entered by mistake")).ok).toBe(true);
      now = (await getUser(email))!;
      expect(now.firstPaidOn).toBeUndefined();
      expect(now.firstMonthOffer!.usedAt).toBeUndefined();
    }
  });

  it("the partner's window starts at the plan's first payment; a pack starts it only while no plan payment stands", async () => {
    const { customer, partner } = await referred(10);
    const id = payId();
    const t = (await (await add(customer, { paymentId: id })).json()) as AddBody;
    expect(t.payment, "a paying customer's pack is never left without a decision").toMatchObject({ commission: { partner, sar: commissionSar(300) } });
    expect((await getUser(customer))!.firstPaidOn).toBeUndefined();
    const plan = await recordPayment(customer, { amountSar: 299, plan: "starter", date: day(-4) }, "key");
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.payment.commission?.sar).toBe(commissionSar(299));
    expect((await getUser(customer))!.firstPaidOn).toBe(day(-4));
    expect((await payments(customer))[id].commission?.sar, "the pack keeps its commission").toBe(commissionSar(300));
    expect((await ledger(partner)).filter((r) => r.kind === "commission" && !r.voidedAt).map((r) => r.id).sort()).toEqual([id, plan.payment.id].sort());
    const src = readFileSync("src/lib/partners.ts", "utf8");
    expect(src).toContain("const firstPaidOn = windowStartDay(all);");
    expect(src).toContain("const windowStartDay = (all: Record<string, Payment>) => firstLiveDay(all, { plan: true }) ?? firstLiveDay(all);");
  });

  it("the Payments route never records a top-up: its body's fields are passed one by one", async () => {
    const email = await paid(0);
    const res = await payRoute(email, { action: "record", amountSar: 100, plan: "starter", date: day(), topup: { lot: "0123456789abcdef", credits: 1000 } });
    expect(res.status).toBe(200);
    const p = ((await res.json()) as { payment: Payment }).payment;
    expect(p.topup).toBeUndefined();
    expect(lotsOf((await getUser(email))!)).toEqual([]);
  });
});

describe("voiding a pack voids its payment and the commission; a live pack's payment is voided only with it (rule 455)", () => {
  beforeEach(async () => { jar().clear(); await adminSignIn(); });

  it("Payments refuses to void a live pack's payment; the pack's Void voids both, and the id cannot be reused", async () => {
    const { customer, partner } = await referred(3);
    const id = payId();
    const a = (await (await add(customer, { paymentId: id })).json()) as AddBody;
    const refused = await payRoute(customer, { action: "void", id, reason: "refund" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, error: "topup_live" });
    expect((await payments(customer))[id].voidedAt).toBeUndefined();
    expect((await paymentsView(customer))!.livePacks).toEqual([a.lot.id]);

    const res = await post({ email: customer, action: "void", id: a.lot.id, reason: "transfer bounced" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, removed: 300, credits: 300, payment: { id, voidReason: "transfer bounced" } });
    expect((await payments(customer))[id].voidedAt).toBeTruthy();
    const row = (await ledger(partner)).find((r) => r.id === id)!;
    expect(row.voidedAt, "the commission is voided with the payment").toBeTruthy();
    expect(lotsOf((await getUser(customer))!)).toEqual([]);
    const log = JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { what: string };
    expect(log.what).toBe(`topup_void:300 removed:300 payment:${id} void`);

    const retry = await add(customer, { paymentId: id });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ ok: false, error: "payment_voided" });
    expect(lotsOf((await getUser(customer))!)).toEqual([]);
  });

  it("a void that stopped halfway is completed by its retry; once a pack has expired its payment is voided from Payments", async () => {
    const email = await paid(0);
    const id = payId();
    const a = (await (await add(email, { paymentId: id })).json()) as AddBody;
    // The payment was voided, the pack not yet (the request died in between).
    expect((await voidPayment(email, id, "key", "x", { withPack: true })).ok).toBe(true);
    const res = await post({ email, action: "void", id: a.lot.id });
    expect(res.status).toBe(200);
    expect(lotsOf((await getUser(email))!)).toEqual([]);

    const other = payId();
    const b = (await (await add(email, { paymentId: other })).json()) as AddBody;
    const u = (await getUser(email))!;
    await saveUser({ ...u, topups: u.topups!.map((l) => (l.id === b.lot.id ? { ...l, expiresAt: new Date(Date.now() - DAY).toISOString() } : l)) });
    expect((await paymentsView(email))!.livePacks).toEqual([]);
    const v = await payRoute(email, { action: "void", id: other, reason: "refund after expiry" });
    expect(v.status).toBe(200);
    expect((await payments(email))[other].voidedAt).toBeTruthy();
  });

  it("the console sends one payment id per pack through adminFetch and keeps it until a definite answer; Payments points to the pack", () => {
    const src = readFileSync("src/components/app/AdminConsole.tsx", "utf8");
    expect(src).toContain('adminFetch("/api/admin/topups"');
    expect(src).not.toMatch(/[^n]fetch\("\/api\/admin\/topups"/);
    expect(src).toContain("if (pendingTopup.current?.key !== key) pendingTopup.current = { key, id: newPaymentId() };");
    expect(src).toContain("paymentId: pendingTopup.current.id");
    expect(src).toContain("if (j.ok || (r.status >= 400 && r.status < 500)) pendingTopup.current = null;");
    expect(src).toContain("key={`${sel.user.email}:${payTick}`}");
    expect(src).toContain("data-topup-pay-note");
    const panel = readFileSync("src/components/app/PaymentsPanel.tsx", "utf8");
    expect(panel).toContain("p.topup && view.livePacks?.includes(p.topup.lot)");
    expect(panel).toContain("data-topup-note");
    for (const lang of ["en", "ar"] as const) {
      const note = lang === "en" ? /Top-ups: never record them here[\s\S]*Add top-up[\s\S]*commission/ : /باقات الشحن: لا تسجّلها هنا أبداً[\s\S]*أضف باقة شحن[\s\S]*عمولة/;
      expect(panel, lang).toMatch(note);
    }
  });
});

describe("the profile shows plan credits and top-up credits apart, with each pack's expiry (rule 456)", () => {
  it("creditSplit: the plan part is the rest of the balance, packs sorted by expiry, never more than the balance", () => {
    const soon = { credits: 300, left: 120, expiresAt: "2026-11-01T00:00:00.000Z" };
    const late = { credits: 1000, left: 1000, expiresAt: "2026-12-30T00:00:00.000Z" };
    expect(creditSplit(1400, [late, soon])).toEqual({ plan: 280, topup: 1120, packs: [soon, late] });
    expect(creditSplit(50, [late])).toEqual({ plan: 0, topup: 50, packs: [late] });
    expect(creditSplit(80, undefined)).toEqual({ plan: 80, topup: 0, packs: [] });
    expect(creditSplit(80, [{ credits: 100, left: 0, expiresAt: "2026-12-01T00:00:00.000Z" }]).packs, "an empty pack is not listed").toEqual([]);
    expect(creditSplit(NaN, [{ credits: 100, left: 500, expiresAt: "x" }])).toEqual({ plan: 0, topup: 0, packs: [{ credits: 100, left: 100, expiresAt: "x" }] });
  });

  const initial = (topups?: { credits: number; left: number; expiresAt: string }[]) => ({
    ok: true, role: "owner" as const, me: { name: "Test", email: "o@test.example", lang: "en" as const, role: "owner" as const },
    may: { passwordChange: true, accountDelete: true },
    user: { name: "Test", email: "o@test.example", phone: "+966500000123", plan: "starter", credits: 1400, trialEnds: "2026-10-04T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z", lang: "en" as const, ...(topups ? { topups } : {}) },
    usage: {}, images: 0, mediaCredits: 0, emails: "all", allowance: 300, nextReset: "2026-11-01",
    brand: { name: "Roastery", website: "roastery.example", sitemap: "", products: "Beans", audience: "Locals", tone: "warm", valueProp: "", social: {} },
  });
  const render = (lang: "en" | "ar", topups?: { credits: number; left: number; expiresAt: string }[]) =>
    renderToStaticMarkup(createElement(ProfilePanel, { t: appDict[lang], lang, initial: initial(topups) }));

  it("the credit card splits the balance and dates each pack, in both languages; without packs it shows the balance alone", () => {
    const packs = [{ credits: 1000, left: 1000, expiresAt: "2026-12-30T10:00:00.000Z" }, { credits: 300, left: 120, expiresAt: "2026-11-15T10:00:00.000Z" }];
    const en = render("en", packs);
    expect(en).toMatch(/data-plan-credits=""><dt>Plan credits \(reset on 2026-11-01\)<\/dt><dd[^>]*>280<\/dd>/);
    expect(en).toMatch(/data-topup-credits=""><dt>Top-up credits \(used after the plan credits; no reset\)<\/dt><dd[^>]*>1,120<\/dd>/);
    expect(en.indexOf("2026-11-15"), "the pack that expires first is listed first").toBeLessThan(en.indexOf("2026-12-30"));
    expect(en).toContain("300-credit pack: 120 left");
    expect(en).toContain("The plan&#x27;s credits reset on the 1st of each month (UTC); top-up packs keep what is left in them until they expire.");
    const ar = render("ar", packs);
    expect(ar).toContain("كريدت الخطة (يتجدد في 2026-11-01)");
    expect(ar).toContain("كريدت باقات الشحن");
    expect(ar).toContain("تنتهي");
    const none = render("en");
    expect(none).toContain("data-credit-split");
    expect(none).not.toContain("data-plan-credits");
  });
});

describe("out of credits, the line fits the plan and the role (rule 457)", () => {
  it("a paid owner is offered a top-up or an upgrade, a trial owner a plan, anyone else is told to ask the owner", () => {
    for (const lang of ["ar", "en"] as const) {
      const g = appDict[lang].generate;
      const paidOwner = noCreditsText(g, true, true);
      const trialOwner = noCreditsText(g, true, false);
      const paidMember = noCreditsText(g, false, true);
      const trialMember = noCreditsText(g, false, false);
      expect(paidOwner, lang).toMatch(lang === "ar" ? /اشحن رصيدك[\s\S]*رقِّ خطتك[\s\S]*صفحة الاشتراك/ : /Top up[\s\S]*upgrade your plan[\s\S]*Subscription page/);
      expect(paidMember, lang).toMatch(lang === "ar" ? /مالك الحساب شحن الرصيد/ : /account owner to top up/);
      for (const [name, line] of [["trial owner", trialOwner], ["trial member", trialMember]] as const) {
        expect(line, `${lang} ${name}`).not.toMatch(/top.?up|شحن|باقة/i);
      }
      expect(trialOwner, lang).toMatch(lang === "ar" ? /اختر خطة/ : /Choose a plan/);
      expect(trialMember, lang).toMatch(lang === "ar" ? /مالك الحساب/ : /account owner/);
      // A paid plan's media note names the top-up.
      expect(appDict[lang].inbox.needTopup, lang).toMatch(lang === "ar" ? /اشحن رصيدك/ : /Top up/);
    }
    for (const f of ["src/components/app/GeneratePanel.tsx", "src/components/app/ReportsPanel.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toMatch(/no_credits: noCreditsText\((g|t\.generate), owner, topups\)/);
    }
    for (const f of ["src/app/[lang]/app/generate/page.tsx", "src/app/[lang]/app/reports/page.tsx"]) {
      expect(readFileSync(f, "utf8"), f).toContain('owner={can(u, "billing")} topups={topupsSold(u.plan)}');
    }
    const media = readFileSync("src/components/app/MediaControls.tsx", "utf8");
    expect(media).toContain('if (e === "no_credits") return say(kind, shortOfCredits(i, { need: j.need ?? m?.credits, have: j.have, plan, owner }));');
  });

  it("a media render short of credits: packs and a link for a paid owner, plans for a trial owner, ask the owner for anyone else", () => {
    for (const lang of ["ar", "en"] as const) {
      const i = appDict[lang].inbox;
      const at = (plan: string, owner: boolean) => shortOfCredits(i, { need: 40, have: 12, plan, owner });
      const paidOwner = at("pro", true);
      expect(paidOwner, lang).toMatchObject({ billing: true, topup: true });
      expect(paidOwner.text, lang).toContain(i.needTopup);
      expect(paidOwner.text, lang).toMatch(/40[\s\S]*12/);
      const trialOwner = at("trial", true);
      expect(trialOwner, lang).toMatchObject({ billing: true, topup: false });
      expect(trialOwner.text, lang).not.toMatch(/top.?up|شحن|باقة/i);
      // A member of a paid account cannot buy a pack (the billing page tells them to ask the owner): no link, no "top up".
      const paidMember = at("business", false);
      expect(paidMember.billing, lang).toBeUndefined();
      expect(paidMember.topup, lang).toBeUndefined();
      expect(paidMember.text, lang).toContain(i.needTopupAsk);
      expect(paidMember.text, lang).not.toContain(i.needTopup);
      expect(paidMember.text, lang).toMatch(lang === "ar" ? /مالك الحساب/ : /account owner/);
      const trialMember = at("trial", false);
      expect(trialMember.billing, lang).toBeUndefined();
      expect(trialMember.text, lang).toContain(i.needPlanAsk);
      expect(trialMember.text, lang).not.toMatch(/top.?up|شحن|باقة/i);
    }
    expect(readFileSync("src/app/[lang]/app/page.tsx", "utf8")).toContain('canPublish={can(u, "publish")} owner={can(u, "billing")}');
    expect(readFileSync("src/components/app/Inbox.tsx", "utf8")).toContain('paused={!!paused} owner={owner} onChanged=');
  });

  it("the console's deal copy says a deal sets the month's plan credits and live packs are kept", async () => {
    const src = readFileSync("src/components/app/AdminConsole.tsx", "utf8");
    expect(src).toContain("OK sets the month's plan credits to the deal's credits today (live top-up packs keep what is left in them)");
    expect(src).toContain("«موافق» يجعل كريدت الخطة الشهري كريدت العقد اليوم (وتحتفظ باقات الشحن السارية بما بقي فيها)");
    expect(src).not.toContain("OK sets the balance to the deal's credits");
    expect(src).toContain("the month's plan credits become the deal's credits; live top-up packs are kept");
  });
});

describe("a Sunday plan's paid-once hold keeps its top-up receipt (rule 458)", () => {
  it("chargeOnce records where the credits came from; refundOnce and the weekly sweep put them back in the pack", async () => {
    const email = await paid(1);
    const r = await addPaidTopup(email, { credits: 100, paidSar: 100, paidOn: day(), ref: "" }, "key");
    if (!r.ok) throw new Error(r.error);
    const meta = { scope: email, agent: "noor" as const };
    const c = await chargeOnce(email, 3, meta, `weekly:${email}:W1`);
    const held = ok(c as AgentCharge);
    expect(held).toMatchObject({ from: { monthly: 1, lots: [{ id: r.lot.id, n: 2 }] } });
    expect((await getUser(email))!.paidOnce![`weekly:${email}:W1`].from).toEqual({ monthly: 1, lots: [{ id: r.lot.id, n: 2 }] });
    expect(await refundOnce(email, `weekly:${email}:W1`)).toEqual({ credits: 101, refunded: 3 });
    let u = (await getUser(email))!;
    expect([monthlyCredits(u), lotsOf(u)[0].left]).toEqual([1, 100]);

    await chargeOnce(email, 3, meta, `weekly:${email}:W2`);
    const swept = await resolveOnceHolds(email, { [`weekly:${email}:W2`]: false });
    expect(swept.refunded).toEqual([{ scope: email, agent: "noor", credits: 3 }]);
    u = (await getUser(email))!;
    expect([monthlyCredits(u), lotsOf(u)[0].left]).toEqual([1, 100]);
    // A pack voided since: its share comes back as plan credits (founder decision of 2026-10-02, rule 461).
    await chargeOnce(email, 3, meta, `weekly:${email}:W3`);
    await voidTopup(email, r.lot.id);
    expect(await refundOnce(email, `weekly:${email}:W3`)).toEqual({ credits: 3, refunded: 3 });
    u = (await getUser(email))!;
    expect([monthlyCredits(u), lotsOf(u)]).toEqual([3, []]);
  });
});

describe("a pack's payment date is the Riyadh day, as for every recorded payment (rule 459)", () => {
  it("parseTopup refuses a day after today in Riyadh and takes today there, so the payment is never refused after the pack", () => {
    const body = (paidOn: string) => ({ credits: 100, paidSar: 100, paidOn });
    // 22:30 UTC on 2026-10-01 is 01:30 on 2026-10-02 in Riyadh.
    const late = Date.parse("2026-10-01T22:30:00Z");
    expect(parseTopup(body("2026-10-02"), late).ok).toBe(true);
    expect(parseTopup(body("2026-10-03"), late)).toEqual({ ok: false, error: "bad_date" });
    // 10:00 UTC on 2026-10-01 is 13:00 on 2026-10-01 in Riyadh: tomorrow is refused, which the UTC rule let through.
    const noon = Date.parse("2026-10-01T10:00:00Z");
    expect(parseTopup(body("2026-10-01"), noon).ok).toBe(true);
    expect(parseTopup(body("2026-10-02"), noon)).toEqual({ ok: false, error: "bad_date" });
    expect(parseTopup(body("2025-09-30"), noon)).toEqual({ ok: false, error: "bad_date" });
    const src = readFileSync("src/components/app/AdminConsole.tsx", "utf8");
    expect(src, "the console's default date is today in Riyadh").toContain("prompt(S.promptTopupDate, ksaDay())");
  });

  it("a member account is never sold a pack, and the payment carries the account's plan", async () => {
    jar().clear(); await adminSignIn();
    const email = await paid(0, "business");
    const m = await newMember((await getUser(email))! as User, "admin");
    const asMember = await add(m.email, { paymentId: payId() });
    expect(asMember.status, "a member login is not an account").toBe(404);
    const b = (await (await add(email, { paymentId: payId() })).json()) as AddBody;
    expect(b.payment).toMatchObject({ plan: "business" });
  });
});
