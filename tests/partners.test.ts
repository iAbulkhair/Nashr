import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jar, json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { createUser, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { codeFor } from "@/lib/referral";
import { wipeAccount } from "@/lib/account";
import {
  ATTRIBUTION_DAYS, COMMISSION_MONTHS, COMMISSION_PCT, NEW_TERMS_FROM, PARTNER_COOKIE, PAYOUT_MIN_SAR, attributionDeadline, balances,
  bankConfirmed, codeProblem, commissionDecision, commissionSar, ksaDay, maskIban, normalizeCode, parsePartnerCookie, partnerCookieValue,
  payoutProblem, referralStatus, saIban, suggestCode, validAmount, windowEnd, type LedgerRow,
} from "@/lib/partner-rules";
import { customerLabel, earlyOfferDue, getPartner, grantEarlyOffer, lastDayOfferOwed, listPartners, partnerByCode, partnerDashboard } from "@/lib/partners";
import { LEGAL } from "@/lib/legal";
import { FIRST_MONTH_DISCOUNT_PCT, PLAN_PRICE_SAR, SELF_SERVE_PLANS, firstMonthPriceSar } from "@/lib/pricing";
import { can } from "@/lib/roles";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";

import * as plink from "@/app/p/[code]/route";
import * as signup from "@/app/api/auth/signup/route";
import * as partnerRoute from "@/app/api/partner/route";
import * as codeRoute from "@/app/api/partner/code/route";
import * as adminPartners from "@/app/api/admin/partners/route";
import * as adminPayments from "@/app/api/admin/payments/[email]/route";
import * as affiliates from "@/app/api/affiliates/route";
import * as profileRoute from "@/app/api/profile/route";
import BillingPage from "@/app/[lang]/app/billing/page";
import PartnerPage from "@/app/[lang]/app/partner/page";
import AffiliatesPage from "@/app/[lang]/affiliates/page";

/**
 * The partner programme and the 15% first-month discounts (rules 390-402, docs/superpowers/specs/2026-10-01-affiliates-design.md):
 * own codes approved by the founder, 30-day attribution by link or code, 15% of each payment for the first 4 months,
 * monthly payouts from SAR 200, one first-month discount per account, and a partner page without customer PII.
 */

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app",
  useSearchParams: () => new URLSearchParams(),
}));

const FOUNDER = "founder-partners@test.example";
const VALID_IBAN = "SA0380000000608010167519";
/** A day in Riyadh, as the founder dates payments (the programme's days are Riyadh days, rule 406). */
const day = (offsetDays = 0) => ksaDay(Date.now() + offsetDays * 864e5);
const code = (p = "P") => `${p}${randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 12);
const ip = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
const toH = (sar: number) => Math.round(sar * 100);
const status = async (r: Response | Promise<Response>) => (await r).status;
const body = async <T = Record<string, unknown>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
type AsyncPage = (p: { params: Promise<{ lang: string }> }) => Promise<ReactElement>;
const html = async (page: unknown, lang = "en") => renderToStaticMarkup(await (page as AsyncPage)({ params: Promise.resolve({ lang }) }));

const asFounder = () => signIn(FOUNDER);
async function approve(email: string, c: string, extra: Record<string, unknown> = {}) {
  await asFounder();
  return adminPartners.POST(json("/api/admin/partners", "POST", { action: "approve", email, code: c, name: "Partner", ...extra }));
}
async function partner(prefix = "partner"): Promise<{ user: User; code: string }> {
  const user = await newUser(prefix);
  const c = code();
  expect(await status(approve(user.email, c))).toBe(200);
  return { user: (await getUser(user.email))!, code: c };
}
/** A signup through the real route, from its own address so the per-IP limit never interferes. */
async function signupVia(fields: Record<string, unknown>, cookie?: string) {
  jar().clear();
  if (cookie) jar().set(PARTNER_COOKIE, cookie);
  const email = `cust-${randomBytes(4).toString("hex")}@test.example`;
  const res = await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "Customer", lang: "en", ...fields }, { "x-real-ip": ip() }));
  return { res, email };
}
async function record(email: string, b: Record<string, unknown>) {
  await asFounder();
  return adminPayments.POST(json(`/api/admin/payments/${encodeURIComponent(email)}`, "POST", { action: "record", ...b }), params({ email: encodeURIComponent(email) }));
}
async function voidPay(email: string, id: string, reason = "refund") {
  await asFounder();
  return adminPayments.POST(json(`/api/admin/payments/${encodeURIComponent(email)}`, "POST", { action: "void", id, reason }), params({ email: encodeURIComponent(email) }));
}
const ledger = async (email: string) => Object.values(await db.hgetall<LedgerRow>(`partner:ledger:${email}`));
/** The partner saves bank details and the founder confirms them, as before the first transfer (rule 405). */
async function bankReady(email: string) {
  await signIn(email);
  expect(await status(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Partner Name", iban: VALID_IBAN })))).toBe(200);
  await asFounder();
  const savedAt = (await getPartner(email))!.bank!.savedAt;
  expect(await status(adminPartners.POST(json("/api/admin/partners", "POST", { action: "confirm_bank", email, savedAt })))).toBe(200);
}
const visit = (c: string, headers: Record<string, string> = {}, query = "") => plink.GET(new Request(`https://nashr.test/p/${c}${query}`, { headers: { "x-real-ip": ip(), ...headers } }), params({ code: c }));

beforeAll(async () => {
  vi.stubEnv("ADMIN_EMAILS", FOUNDER);
  vi.stubEnv("WAITLIST_ADMIN_KEY", "");
  if (!(await getUser(FOUNDER))) await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "en" });
});
afterEach(() => signOut());

describe("rule 390: partner codes are the founder's to approve, unique, uppercase A-Z 0-9, 3-16 characters", () => {
  it("codes are trimmed and uppercased; short, long, punctuated and reserved ones are refused", () => {
    expect(normalizeCode("  ahmed ")).toBe("AHMED");
    expect(codeProblem("AHMED")).toBeNull();
    expect(codeProblem("AB")).toBe("bad_code");
    expect(codeProblem("A".repeat(17))).toBe("bad_code");
    expect(codeProblem("AH-MED")).toBe("bad_code");
    expect(codeProblem("أحمد")).toBe("bad_code");
    for (const r of ["ADMIN", "THAKEEN", "NOOR", "NASHR", "PARTNER"]) expect(codeProblem(r), r).toBe("reserved_code");
  });

  it("suggests a code from the applicant's first name, Arabic spelled in Latin, else from the email", () => {
    expect(suggestCode("Sara Ali")).toBe("SARA");
    expect(suggestCode("أحمد العتيبي")).toBe("AHMD");
    expect(suggestCode("", "jo@test.example")).toBe("JOP");
    expect(codeProblem(suggestCode("Admin Person"))).toBeNull();
  });

  it("the founder approves: the code links to the email, reads case-insensitively, and the account gets the partner page", async () => {
    const u = await newUser("apr");
    const c = code("AP");
    const res = await approve(u.email, c.toLowerCase());
    expect(res.status).toBe(200);
    expect((await partnerByCode(c.toLowerCase()))!.email).toBe(u.email);
    expect((await getUser(u.email))!.partnerCode).toBe(c);
    const log = JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { actor: string; what: string };
    expect(log).toMatchObject({ actor: FOUNDER, what: `partner:approve code:${c}` });
  });

  it("a taken code, a second approval, a reserved word, a credits-referral code and a member login are refused", async () => {
    const { code: taken } = await partner();
    const other = await newUser("apr2");
    expect(await body(approve(other.email, taken))).toMatchObject({ ok: false, error: "code_taken" });
    expect(await body(approve(other.email, "ADMIN"))).toMatchObject({ ok: false, error: "reserved_code" });
    const someone = await newUser("ref");
    await db.set(`ref:${codeFor(someone.email)}`, someone.email);
    expect(await body(approve(other.email, codeFor(someone.email)))).toMatchObject({ ok: false, error: "code_taken" });
    const c = code();
    expect(await status(approve(other.email, c))).toBe(200);
    expect(await body(approve(other.email, code()))).toMatchObject({ ok: false, error: "already_partner" });
    const owner = await newUser("team");
    const m = await newMember(owner);
    expect(await body(approve(m.email, code()))).toMatchObject({ ok: false, error: "member_login" });
  });

  it("only the founder approves: an ordinary session is refused and nothing is written", async () => {
    const u = await newUser("nf");
    await signIn(u.email);
    const c = code();
    const res = await adminPartners.POST(json("/api/admin/partners", "POST", { action: "approve", email: u.email, code: c }));
    expect(res.status).toBe(401);
    expect(await partnerByCode(c)).toBeNull();
    expect(await status(adminPartners.GET(json("/api/admin/partners", "GET")))).toBe(401);
  });

  it("approved before the account exists: signing up with that email opens the partner page", async () => {
    const email = `late-${randomBytes(4).toString("hex")}@test.example`;
    const c = code();
    expect(await status(approve(email, c))).toBe(200);
    jar().clear();
    expect(await status(signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "Late", lang: "en" }, { "x-real-ip": ip() })))).toBe(200);
    expect((await getUser(email))!.partnerCode).toBe(c);
  });
});

describe("rule 391: a partner link sets a 30-day first-party cookie and sends the visitor to signup", () => {
  it("a partner's code: httpOnly cookie, redirect to the localized signup with the code", async () => {
    const { code: c } = await partner();
    jar().clear();
    const res = await visit(c.toLowerCase(), {}, "?lang=en");
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/en/app/signup");
    expect(to.searchParams.get("partner")).toBe(c);
    expect(to.searchParams.get("ref"), "never the credits referral's parameter").toBeNull();
    expect(jar().get(PARTNER_COOKIE), "the code and the click time").toMatch(new RegExp(`^${c}\\.\\d{13}$`));
  });

  it("an unknown or malformed code sets nothing; Arabic is the default language", async () => {
    jar().clear();
    for (const c of ["NOSUCHCODE1", "a-b"]) {
      const res = await visit(c);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/ar/app/signup");
      expect(new URL(res.headers.get("location")!).searchParams.get("partner")).toBeNull();
    }
    expect(jar().has(PARTNER_COOKIE)).toBe(false);
  });

  it("first touch: another partner's link does not replace a valid cookie, and the signup page gets the code that counts", async () => {
    const a = await partner("pa");
    const b = await partner("pb");
    jar().clear();
    jar().set(PARTNER_COOKIE, a.code);
    const res = await visit(b.code);
    expect(jar().get(PARTNER_COOKIE)).toBe(a.code);
    expect(new URL(res.headers.get("location")!).searchParams.get("partner")).toBe(a.code);
  });

  it("is throttled per IP: past 60 an hour nothing is set", async () => {
    const { code: c } = await partner();
    const addr = ip();
    for (let i = 0; i < 60; i++) await visit(c, { "x-real-ip": addr });
    jar().clear();
    await visit(c, { "x-real-ip": addr });
    expect(jar().has(PARTNER_COOKIE)).toBe(false);
  });
});

describe("rule 392: signup attributes the account (a typed code wins over the cookie)", () => {
  it("a typed code wins over the link cookie, and the account gets the 15% first-month offer", async () => {
    const a = await partner("sa");
    const b = await partner("sb");
    const { res, email } = await signupVia({ partnerCode: b.code.toLowerCase() }, a.code);
    expect(await body(res)).toMatchObject({ ok: true, partner: true });
    const u = (await getUser(email))!;
    expect(u.referredBy).toMatchObject({ partner: b.user.email, code: b.code, via: "code" });
    expect(u.firstMonthOffer).toMatchObject({ kind: "partner", pct: FIRST_MONTH_DISCOUNT_PCT });
    expect(await db.sismember(`partner:refs:${b.user.email}`, email)).toBe(true);
    expect(await db.sismember(`partner:refs:${a.user.email}`, email)).toBe(false);
  });

  it("the cookie alone attributes by link, and is spent", async () => {
    const a = await partner("sc");
    const { res, email } = await signupVia({}, a.code);
    expect(res.status).toBe(200);
    expect((await getUser(email))!.referredBy).toMatchObject({ partner: a.user.email, via: "link" });
    expect(jar().has(PARTNER_COOKIE)).toBe(false);
  });

  it("a typed code that is no partner's is refused before anything is created", async () => {
    const { res, email } = await signupVia({ partnerCode: "NOSUCHCODE9" });
    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ error: "bad_partner_code" });
    expect(await getUser(email)).toBeNull();
  });

  it("the credits referral (?ref=) keeps working next to a partner code", async () => {
    const referrer = await newUser("credref");
    await db.set(`ref:${codeFor(referrer.email)}`, referrer.email);
    const a = await partner("sd");
    const { res } = await signupVia({ ref: codeFor(referrer.email), partnerCode: a.code });
    expect(await body(res)).toMatchObject({ ok: true, referred: true, partner: true });
  });

  it("the partner's own email is never attributed to itself", async () => {
    const email = `selfp-${randomBytes(4).toString("hex")}@test.example`;
    const c = code();
    expect(await status(approve(email, c))).toBe(200);
    jar().clear();
    const res = await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "Self", lang: "en", partnerCode: c }, { "x-real-ip": ip() }));
    expect(await body(res)).toMatchObject({ ok: true, partner: false });
    expect((await getUser(email))!.referredBy).toBeUndefined();
  });

  it("the owner's profile never carries the partner's email", async () => {
    const a = await partner("se");
    const { email } = await signupVia({ partnerCode: a.code });
    await signIn(email);
    const p = await body(profileRoute.GET());
    expect(JSON.stringify(p)).not.toContain(a.user.email);
  });
});

describe("rule 393: one first-month discount per account, never stacked; the billing page takes a code before the first payment", () => {
  const claim = async (email: string, c: string) => { await signIn(email); return codeRoute.POST(json("/api/partner/code", "POST", { code: c })); };

  it("a trial account takes a partner's code once; a second code, a paid account and a bad code are refused", async () => {
    const a = await partner("ca");
    const b = await partner("cb");
    const u = await newUser("claim");
    expect(await body(claim(u.email, a.code))).toMatchObject({ ok: true, code: a.code });
    expect((await getUser(u.email))!.firstMonthOffer?.kind).toBe("partner");
    expect(await body(claim(u.email, b.code))).toMatchObject({ ok: false, error: "already_attributed" });
    const paid = await newUser("claimpaid");
    await saveUser({ ...(await getUser(paid.email))!, plan: "pro" });
    expect(await body(claim(paid.email, a.code))).toMatchObject({ ok: false, error: "already_paid" });
    expect(await body(claim(paid.email, "NOSUCH12"))).toMatchObject({ ok: false, error: "bad_partner_code" });
  });

  it("an account with the early-partner offer keeps that one offer when it takes a code", async () => {
    const a = await partner("cc");
    const u = await newUser("early");
    await saveUser({ ...(await getUser(u.email))!, firstMonthOffer: { kind: "early", pct: FIRST_MONTH_DISCOUNT_PCT, at: new Date().toISOString() } });
    expect(await status(claim(u.email, a.code))).toBe(200);
    const x = (await getUser(u.email))!;
    expect(x.firstMonthOffer?.kind).toBe("early");
    expect(x.referredBy?.partner).toBe(a.user.email);
  });

  it("a partner cannot take their own code; a member of the account cannot claim at all", async () => {
    const a = await partner("cd");
    expect(await body(claim(a.user.email, a.code))).toMatchObject({ ok: false, error: "self_referral" });
    const owner = await newUser("cdo");
    const m = await newMember(owner);
    expect(await status(claim(m.email, a.code))).toBe(403);
  });

  it("is throttled per account", async () => {
    const u = await newUser("cthrottle");
    for (let i = 0; i < 10; i++) await claim(u.email, "NOSUCH99");
    expect(await status(claim(u.email, "NOSUCH99"))).toBe(429);
  });
});

describe("rule 394: the trial's last day grants the early-partner offer, mail or not", () => {
  const trial = async (hoursLeft: number) => {
    const u = await newUser("eo");
    const x = { ...(await getUser(u.email))!, trialEnds: new Date(Date.now() + hoursLeft * 36e5).toISOString() };
    await saveUser(x);
    return x;
  };

  it("due exactly when the day-3 note is due; granted once", async () => {
    expect(earlyOfferDue(await trial(10))).toBe(true);
    expect(earlyOfferDue(await trial(30))).toBe(false);
    expect(earlyOfferDue(await trial(-5)), "the cron's window is the last day only").toBe(false);
    const u = await trial(10);
    expect(earlyOfferDue({ ...u, plan: "pro" })).toBe(false);
    expect(await grantEarlyOffer(u.email, (x) => earlyOfferDue(x))).toBe(true);
    expect(await grantEarlyOffer(u.email, (x) => earlyOfferDue(x))).toBe(false);
    expect((await getUser(u.email))!.firstMonthOffer).toMatchObject({ kind: "early", pct: FIRST_MONTH_DISCOUNT_PCT });
  });

  it("the daily cron grants it on the last day without any mail set up", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-partners");
    vi.stubEnv("RESEND_API_KEY", "");
    const u = await trial(12);
    const { GET } = await import("@/app/api/cron/daily/route");
    const report = (await (await GET(new Request("https://nashr.test/api/cron/daily", { headers: { authorization: "Bearer cron-secret-partners" } }))).json()) as { results: Record<string, string> };
    expect(report.results[u.email]).toMatch(/offer/);
    expect((await getUser(u.email))!.firstMonthOffer?.kind).toBe("early");
    vi.stubEnv("CRON_SECRET", "");
  });

  it("the billing page owes it to a trial in its last day or ended less than 3 days ago, never to one ended long before", async () => {
    expect(lastDayOfferOwed(await trial(-48))).toBe(true);
    expect(lastDayOfferOwed(await trial(5))).toBe(true);
    expect(lastDayOfferOwed(await trial(40))).toBe(false);
    expect(lastDayOfferOwed(await trial(-73)), "ended more than 3 days ago").toBe(false);
    expect(lastDayOfferOwed(await trial(-24 * 90)), "ended months ago").toBe(false);
  });

  it("the day-3 note names the 15% on the first month in both languages", () => {
    const src = readFileSync("src/lib/lifecycle.ts", "utf8");
    expect(src).toContain("شهرك الأول عليه خصم ${FIRST_MONTH_DISCOUNT_PCT}% (عرض الشركاء الأوائل، للشهر الأول فقط)");
    expect(src).toContain("your first month is ${FIRST_MONTH_DISCOUNT_PCT}% off (the early-partner offer, first month only)");
    expect(src).not.toContain("activate a month at the early-partner discount");
    expect(FIRST_MONTH_DISCOUNT_PCT).toBe(15);
  });
});

describe("rule 395: the billing page quotes the discounted first month and routes it to WhatsApp", () => {
  it("first-month prices come from the table: list price less 15%, to the nearest riyal", () => {
    for (const k of SELF_SERVE_PLANS) expect(firstMonthPriceSar(k), k).toBe(Math.round(PLAN_PRICE_SAR[k] * 0.85));
  });

  it("the owner with an offer sees the discounted price, a WhatsApp link for that amount, and the full-price link as a fallback", async () => {
    const LINK = "https://pay.test.example/starter";
    vi.stubEnv("PAY_LINK_STARTER", LINK);
    vi.stubEnv("SUPPORT_WHATSAPP", "966500000000");
    try {
      const a = await partner("bp");
      const { email } = await signupVia({ partnerCode: a.code });
      await signIn(email);
      const h = await html(BillingPage);
      const starter = h.split('data-tier="starter"')[1].split('data-tier="pro"')[0];
      expect(starter).toContain(`SAR ${firstMonthPriceSar("starter")} instead of ${PLAN_PRICE_SAR.starter}, plus VAT`);
      const wa = /href="(https:\/\/wa\.me\/966500000000\?text=[^"]+)"/.exec(starter)![1];
      expect(decodeURIComponent(wa.replace(/&amp;/g, "&"))).toContain(`(SAR ${firstMonthPriceSar("starter")} + VAT)`);
      expect(starter).toContain(`href="${LINK}"`);
      expect(h).toContain(`data-offer="partner"`);
      const ar = await html(BillingPage, "ar");
      expect(ar).toContain(`خصم ${FIRST_MONTH_DISCOUNT_PCT}% على شهرك الأول: ${firstMonthPriceSar("starter")} ريال بدل ${PLAN_PRICE_SAR.starter} + الضريبة`);
    } finally {
      vi.stubEnv("PAY_LINK_STARTER", "");
      vi.stubEnv("SUPPORT_WHATSAPP", "");
    }
  });

  it("a just-ended trial with no offer is granted the early-partner one when the owner opens billing; a member and a founder impersonating grant nothing", async () => {
    const u = await newUser("bend");
    await saveUser({ ...(await getUser(u.email))!, trialEnds: new Date(Date.now() - 2 * 864e5).toISOString() });
    await signIn(u.email, { imp: FOUNDER });
    await html(BillingPage);
    expect((await getUser(u.email))!.firstMonthOffer, "looking as the founder is not the customer's visit").toBeUndefined();
    const m = await newMember((await getUser(u.email))!);
    await signIn(m.email);
    expect(await html(BillingPage)).not.toContain("data-offer");
    expect((await getUser(u.email))!.firstMonthOffer).toBeUndefined();
    await signIn(u.email);
    expect(await html(BillingPage)).toContain(`data-offer="early"`);
    expect((await getUser(u.email))!.firstMonthOffer?.kind).toBe("early");
  });
});

describe("rule 396: a recorded payment pays 15% for the first 4 months when attributed in time", () => {
  it("money is counted in halalas", () => {
    expect(commissionSar(254)).toBe(38.1);
    expect(commissionSar(299)).toBe(44.85);
    expect(commissionSar(0.05)).toBe(0.01);
    expect(validAmount(254.15)).toBe(true);
    for (const bad of [0, -5, 1.234, Infinity, NaN, "100", 2_000_000]) expect(validAmount(bad), String(bad)).toBe(false);
  });

  it("the windows: first payment on or before attribution day + 30; payments before first + 4 months, clamped at month end", () => {
    expect(ATTRIBUTION_DAYS).toBe(30);
    expect(COMMISSION_MONTHS).toBe(4);
    expect(COMMISSION_PCT).toBe(15);
    expect(attributionDeadline("2026-10-01T10:00:00.000Z")).toBe("2026-10-31");
    expect(windowEnd("2026-10-15")).toBe("2027-02-15");
    expect(windowEnd("2026-10-31")).toBe("2027-02-28");
    const base = { customer: "c@test.example", attribution: { partner: "p@test.example", code: "PCODE", at: "2026-10-01T10:00:00.000Z", via: "code" as const }, partnerExists: true, sameTeam: false };
    expect(commissionDecision({ ...base, firstPaidOn: "2026-10-31", paymentDate: "2026-10-31" })).toEqual({ ok: true });
    expect(commissionDecision({ ...base, firstPaidOn: "2026-11-01", paymentDate: "2026-11-01" })).toEqual({ ok: false, reason: "lapsed" });
    expect(commissionDecision({ ...base, firstPaidOn: "2026-10-15", paymentDate: "2027-02-14" })).toEqual({ ok: true });
    expect(commissionDecision({ ...base, firstPaidOn: "2026-10-15", paymentDate: "2027-02-15" })).toEqual({ ok: false, reason: "window" });
    expect(commissionDecision({ ...base, customer: "p@test.example", firstPaidOn: "2026-10-15", paymentDate: "2026-10-15" })).toEqual({ ok: false, reason: "self" });
    expect(commissionDecision({ ...base, sameTeam: true, firstPaidOn: "2026-10-15", paymentDate: "2026-10-15" })).toEqual({ ok: false, reason: "team" });
    expect(commissionDecision({ ...base, partnerExists: false, firstPaidOn: "2026-10-15", paymentDate: "2026-10-15" })).toEqual({ ok: false, reason: "no_partner" });
  });

  it("the first payment uses the offer and earns 15%; later ones in the window earn 15%; one past 4 months earns nothing", async () => {
    const a = await partner("rp");
    const { email } = await signupVia({ partnerCode: a.code });
    const first = await body<{ ok: boolean; payment: { id: string; offer?: string; expectedSar?: number; commission?: { sar: number } } }>(record(email, { amountSar: firstMonthPriceSar("starter"), plan: "starter", date: day(), reference: "TRX-1" }));
    expect(first.payment).toMatchObject({ offer: "partner", expectedSar: firstMonthPriceSar("starter"), commission: { sar: commissionSar(firstMonthPriceSar("starter")) } });
    const u = (await getUser(email))!;
    expect(u.firstMonthOffer?.usedAt).toBeTruthy();
    expect(u.firstPaidOn).toBe(day());
    const second = await body<{ payment: { offer?: string; commission?: { sar: number } } }>(record(email, { amountSar: PLAN_PRICE_SAR.starter, plan: "starter", date: day() }));
    expect(second.payment.offer, "the discount is the first month's only").toBeUndefined();
    expect(second.payment.commission?.sar).toBe(commissionSar(PLAN_PRICE_SAR.starter));
    const b = balances(await ledger(a.user.email));
    expect(b.earned).toBe((Math.round(commissionSar(firstMonthPriceSar("starter")) * 100) + Math.round(commissionSar(PLAN_PRICE_SAR.starter) * 100)) / 100);
    // An account attributed 200 days ago that paid first 190 days ago (within its 30 days): that payment counts, and one
    // dated today is past the 4 months that started with it.
    const { email: old } = await signupVia({ partnerCode: a.code });
    const o = (await getUser(old))!;
    await saveUser({ ...o, referredBy: { ...o.referredBy!, at: new Date(Date.now() - 200 * 864e5).toISOString() } });
    expect((await body<{ payment: { commission?: { sar: number } } }>(record(old, { amountSar: 100, plan: "starter", date: day(-190) }))).payment.commission?.sar).toBe(15);
    expect((await body<{ payment: { notCounted?: string } }>(record(old, { amountSar: 100, plan: "starter", date: day() }))).payment.notCounted).toBe("window");
  });

  it("a referral whose first payment came more than 30 days after attribution lapses for every payment, and stays on record", async () => {
    const a = await partner("rl");
    const { email } = await signupVia({ partnerCode: a.code });
    const u = (await getUser(email))!;
    await saveUser({ ...u, referredBy: { ...u.referredBy!, at: new Date(Date.now() - 40 * 864e5).toISOString() } });
    expect((await body<{ payment: { notCounted?: string } }>(record(email, { amountSar: 299, plan: "starter", date: day() }))).payment.notCounted).toBe("lapsed");
    expect((await body<{ payment: { notCounted?: string } }>(record(email, { amountSar: 299, plan: "starter", date: day() }))).payment.notCounted).toBe("lapsed");
    expect((await getUser(email))!.referredBy, "kept, marked lapsed by its dates").toBeTruthy();
    expect(referralStatus((await getUser(email))!.referredBy!.at, day())).toBe("lapsed");
    expect(await ledger(a.user.email)).toEqual([]);
  });

  it("a partner on the customer's team is not counted", async () => {
    const a = await partner("rt");
    const { email } = await signupVia({ partnerCode: a.code });
    await db.sadd(`members:${email}`, a.user.email);
    expect((await body<{ payment: { notCounted?: string } }>(record(email, { amountSar: 299, plan: "starter", date: day() }))).payment.notCounted).toBe("team");
  });

  it("a retried payment id records once; bad amounts, plans, dates and ids are refused; only the founder records", async () => {
    const a = await partner("ri");
    const { email } = await signupVia({ partnerCode: a.code });
    const id = `pay_${randomBytes(9).toString("hex")}`;
    const once = await body<{ already?: boolean }>(record(email, { id, amountSar: 254, plan: "starter", date: day() }));
    const twice = await body<{ already?: boolean }>(record(email, { id, amountSar: 254, plan: "starter", date: day() }));
    expect(once.already).toBeUndefined();
    expect(twice.already).toBe(true);
    expect((await ledger(a.user.email)).length).toBe(1);
    for (const bad of [{ amountSar: 0 }, { amountSar: 1.234 }, { amountSar: "254" }, { plan: "trial" }, { plan: "gold" }, { date: day(5) }, { date: "2026-02-30" }, { id: "x" }]) {
      expect(await status(record(email, { amountSar: 254, plan: "starter", date: day(), ...bad })), JSON.stringify(bad)).toBe(400);
    }
    await signIn(email);
    expect(await status(adminPayments.POST(json("/api/admin/payments/x", "POST", { action: "record", amountSar: 1, plan: "pro", date: day() }), params({ email: encodeURIComponent(email) })))).toBe(401);
  });
});

describe("rule 397: voiding a payment voids its commission", () => {
  it("voiding the only payment voids the commission, clears the first payment day and reopens the offer", async () => {
    const a = await partner("va");
    const { email } = await signupVia({ partnerCode: a.code });
    const { payment } = await body<{ payment: { id: string } }>(record(email, { amountSar: 254, plan: "starter", date: day() }));
    expect(await status(voidPay(email, payment.id))).toBe(200);
    const rows = await ledger(a.user.email);
    expect(rows[0]).toMatchObject({ kind: "commission", voidedAt: expect.any(String) });
    expect(balances(rows).earned).toBe(0);
    const u = (await getUser(email))!;
    expect(u.firstPaidOn).toBeUndefined();
    expect(u.firstMonthOffer?.usedAt).toBeUndefined();
    expect(await status(voidPay(email, payment.id)), "idempotent").toBe(200);
  });

  it("voiding a later payment keeps the first one and its offer used", async () => {
    const a = await partner("vb");
    const { email } = await signupVia({ partnerCode: a.code });
    await record(email, { amountSar: 254, plan: "starter", date: day() });
    const { payment } = await body<{ payment: { id: string } }>(record(email, { amountSar: 299, plan: "starter", date: day() }));
    await voidPay(email, payment.id);
    expect(balances(await ledger(a.user.email)).earned).toBe(commissionSar(254));
    expect((await getUser(email))!.firstMonthOffer?.usedAt).toBeTruthy();
    expect(await status(voidPay(email, "pay_00000000"))).toBe(404);
  });
});

describe("rule 398: payouts pay down a payable balance only, atomically", () => {
  const payout = async (email: string, amountSar: unknown) => { await asFounder(); return adminPartners.POST(json("/api/admin/partners", "POST", { action: "payout", email, amountSar, date: day(), reference: "BANK-1" })); };
  const earn = async (partnerCode: string, amount: number) => {
    const { email } = await signupVia({ partnerCode });
    await record(email, { amountSar: amount, plan: "business", date: day() });
  };

  it("below SAR 200 nothing is payable; at 200 or more only up to the balance", async () => {
    const a = await partner("po");
    await bankReady(a.user.email);
    await earn(a.code, 1000); // 150 SAR commission
    expect(await body(payout(a.user.email, 100))).toMatchObject({ ok: false, error: "below_minimum" });
    await earn(a.code, 1000); // 300 SAR
    expect(balances(await ledger(a.user.email))).toMatchObject({ balance: 300, payable: 300, pending: 0 });
    expect(await body(payout(a.user.email, 300.01))).toMatchObject({ ok: false, error: "over_balance" });
    expect(await body(payout(a.user.email, 0))).toMatchObject({ ok: false, error: "bad_amount" });
    expect(await body(payout(a.user.email, 250))).toMatchObject({ ok: true });
    expect(balances(await ledger(a.user.email))).toMatchObject({ paid: 250, balance: 50, pending: 50, payable: 0 });
    expect(PAYOUT_MIN_SAR).toBe(200);
  });

  it("two payouts at once cannot both pay the same balance", async () => {
    const a = await partner("pc");
    await bankReady(a.user.email);
    await earn(a.code, 2000); // 300 SAR
    await asFounder();
    const send = () => adminPartners.POST(json("/api/admin/partners", "POST", { action: "payout", email: a.user.email, amountSar: 300, date: day() }));
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    expect(balances(await ledger(a.user.email)).paid).toBe(300);
  });

  it("the pure checks agree", () => {
    const c = (sar: number, voided = false): LedgerRow => ({ kind: "commission", id: randomBytes(4).toString("hex"), label: "C-1", paymentDate: day(), baseSar: sar, sar, at: new Date().toISOString(), ...(voided ? { voidedAt: "x" } : {}) });
    expect(payoutProblem([c(150)], 100)).toBe("below_minimum");
    expect(payoutProblem([c(150), c(100, true)], 100)).toBe("below_minimum");
    expect(payoutProblem([c(250)], 250)).toBeNull();
    expect(payoutProblem([c(250)], 251)).toBe("over_balance");
  });
});

describe("rule 399: the partner page shows no customer PII; bank details are the owner's, validated, masked and never logged", () => {
  it("Saudi IBANs are checked, including the checksum, and masked to the last four", () => {
    expect(saIban(VALID_IBAN)).toBe(VALID_IBAN);
    expect(saIban("sa03 8000 0000 6080 1016 7519")).toBe(VALID_IBAN);
    expect(saIban("SA0480000000608010167519"), "wrong check digits").toBeNull();
    expect(saIban("GB82WEST12345698765432")).toBeNull();
    expect(saIban("SA03800000006080101675")).toBeNull();
    expect(maskIban(VALID_IBAN)).toBe("SA•• •••• •••• •••• •••• 7519");
  });

  it("the partner saves bank details: answered masked, kept in full for the founder, absent from the audit log", async () => {
    const a = await partner("bk");
    await signIn(a.user.email);
    const bad = await partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Partner Name", iban: "SA0480000000608010167519" }));
    expect(bad.status).toBe(400);
    const res = await body<{ ok: boolean; bank: { iban: string } }>(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Partner Name", iban: VALID_IBAN })));
    expect(res.bank.iban).toBe(maskIban(VALID_IBAN));
    expect((await getPartner(a.user.email))!.bank).toMatchObject({ holder: "Partner Name", iban: VALID_IBAN });
    await asFounder();
    const list = await body<{ partners: { email: string; bank: { iban: string } | null }[] }>(adminPartners.GET(json("/api/admin/partners", "GET")));
    expect(list.partners.find((p) => p.email === a.user.email)!.bank!.iban).toBe(VALID_IBAN);
    expect((await db.lrange("admin:log", 0, -1)).join("\n")).not.toContain(VALID_IBAN);
    await signIn(a.user.email);
    const page = await html(PartnerPage);
    expect(page).toContain(maskIban(VALID_IBAN));
    expect(page).not.toContain(VALID_IBAN);
  });

  it("not a partner: 404; a member of the partner's account: 403; a founder impersonating: 403; throttled", async () => {
    const u = await newUser("np");
    await signIn(u.email);
    expect(await status(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Name", iban: VALID_IBAN })))).toBe(404);
    const a = await partner("bm");
    const m = await newMember(a.user, "admin");
    await signIn(m.email);
    expect(await status(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Name", iban: VALID_IBAN })))).toBe(403);
    await signIn(a.user.email, { imp: FOUNDER });
    expect(await status(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Name", iban: VALID_IBAN })))).toBe(403);
    await signIn(a.user.email);
    for (let i = 0; i < 10; i++) await partnerRoute.PUT(json("/api/partner", "PUT", { holder: "", iban: "" }));
    expect(await status(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Name", iban: VALID_IBAN })))).toBe(429);
  });

  it("referrals show a label, signup day, status and months counted, never the customer's name or email", async () => {
    const a = await partner("dash");
    const { email: paid } = await signupVia({ partnerCode: a.code });
    const { email: waiting } = await signupVia({ partnerCode: a.code });
    await record(paid, { amountSar: 254, plan: "starter", date: day() });
    const d = (await partnerDashboard(a.user.email))!;
    expect(d.referrals.map((r) => r.status).sort()).toEqual(["paid", "trial"]);
    const paidLabel = customerLabel((await getUser(paid))!);
    expect(d.referrals.find((r) => r.label === paidLabel)).toMatchObject({ status: "paid", months: 1 });
    const text = JSON.stringify(d);
    for (const e of [paid, waiting]) expect(text).not.toContain(e);
    expect(text).not.toContain("Customer");
    await signIn(a.user.email);
    const page = await html(PartnerPage);
    expect(page).toContain(a.code);
    expect(page).toContain(`/p/${a.code}`);
    for (const e of [paid, waiting]) expect(page).not.toContain(e);
  });

  it("the page and the bank write are the owner's: members are refused by the role table", async () => {
    const a = await partner("rolep");
    const m = await newMember(a.user, "admin");
    await signIn(m.email);
    const page = await html(PartnerPage);
    expect(page).not.toContain(a.code);
    const owner = { ...a.user, actor: { kind: "owner" as const, email: a.user.email, name: "P", lang: "en" as const, role: "owner" as const } };
    const founder = { ...owner, actor: { ...owner.actor, kind: "founder" as const, impersonating: FOUNDER } };
    expect(can(owner, "partner")).toBe(true);
    expect(can(owner, "partner.bank")).toBe(true);
    expect(can(founder, "partner.bank")).toBe(false);
  });
});

describe("rule 400: the founder console lists applications with ids, decisions and suggested codes", () => {
  it("a public application gets an id the founder can approve or reject by", async () => {
    const email = `apply-${randomBytes(4).toString("hex")}@test.example`;
    expect(await status(affiliates.POST(json("/api/affiliates", "POST", { name: "Reem Saleh", email, phone: "+966500000000", channel: "YouTube" }, { "x-real-ip": ip() })))).toBe(200);
    await asFounder();
    const { applications } = await body<{ applications: { id: string; email: string; suggested: string; decision: unknown }[] }>(adminPartners.GET(json("/api/admin/partners", "GET")));
    const app = applications.find((x) => x.email === email)!;
    expect(app).toMatchObject({ suggested: "REEM", decision: null });
    expect(app.id).toMatch(/^app_[a-f0-9]+$/);
    expect(await status(adminPartners.POST(json("/api/admin/partners", "POST", { action: "reject", appId: app.id })))).toBe(200);
    const after = await body<{ applications: { id: string; decision: { status: string } | null }[] }>(adminPartners.GET(json("/api/admin/partners", "GET")));
    expect(after.applications.find((x) => x.id === app.id)!.decision).toMatchObject({ status: "rejected" });
  });
});

describe("rule 401: deleting an account removes its partner-programme data", () => {
  it("a customer: payments go and it leaves its partner's referral set; a partner: record, bank, code and ledger go", async () => {
    const a = await partner("wipe");
    const { email } = await signupVia({ partnerCode: a.code });
    await record(email, { amountSar: 254, plan: "starter", date: day() });
    await wipeAccount(email);
    expect(await db.hgetall(`payments:${email}`)).toEqual({});
    expect(await db.sismember(`partner:refs:${a.user.email}`, email)).toBe(false);
    await signIn(a.user.email);
    await partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Name", iban: VALID_IBAN }));
    await wipeAccount(a.user.email);
    expect(await getPartner(a.user.email)).toBeNull();
    expect(await partnerByCode(a.code)).toBeNull();
    expect(await db.get(`partnercode:${a.code}`)).toBeNull();
    expect(await ledger(a.user.email)).toEqual([]);
    expect(await db.sismember("partners:all", a.user.email)).toBe(false);
  });
});

describe("rule 402: the public partner page states the founder's terms", () => {
  it("15% of each payment for 4 months, 15% off the first month, 30 days, SAR 200 monthly, no self-referral, voided on refund", async () => {
    const en = await html(AffiliatesPage, "en");
    const ar = await html(AffiliatesPage, "ar");
    expect(en).toContain(`Earn ${COMMISSION_PCT}% of every payment for ${COMMISSION_MONTHS} months`);
    expect(en).toContain(`${FIRST_MONTH_DISCOUNT_PCT}% off their first month`);
    expect(en).toContain(`within ${ATTRIBUTION_DAYS} days`);
    expect(en).toContain(`SAR ${PAYOUT_MIN_SAR}`);
    expect(en).toContain("No self-referral");
    expect(en).toContain("its commission is voided");
    expect(ar).toContain(`اكسب ${COMMISSION_PCT}% من كل دفعة لأول ${COMMISSION_MONTHS} أشهر`);
    expect(ar).toContain(`خصم ${FIRST_MONTH_DISCOUNT_PCT}% على شهره الأول`);
    expect(ar).toContain("لا إحالة ذاتية");
    for (const h of [en, ar]) expect(h).not.toMatch(/25%|60 (days|يوماً)|forever|for the life of|إلى الأبد|مدى حياة/);
  });

  it("the agencies page and the resources card no longer promise a recurring 25%", () => {
    for (const lang of ["ar", "en"] as const) {
      const agencies = JSON.stringify(INDUSTRY_PAGES[lang].find((p) => p.slug === "agencies"));
      expect(agencies, lang).toContain(`${COMMISSION_PCT}%`);
      expect(agencies, lang).toContain(lang === "ar" ? `لأول ${COMMISSION_MONTHS} أشهر` : `first ${COMMISSION_MONTHS} months`);
      expect(agencies, lang).not.toMatch(/25%|recurring|متكررة/);
    }
    expect(readFileSync("src/lib/site.ts", "utf8")).not.toContain("A commission on every customer you refer");
  });
});

describe("rule 403: the 30 days run from the click on the partner's link, else from signup with a typed code", () => {
  it("the cookie carries the click time; a future time is clamped, an old or missing one is ignored", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(partnerCookieValue("AHMED", now)).toBe(`AHMED.${now}`);
    expect(parsePartnerCookie(`ahmed.${now - 5 * 864e5}`, now)).toEqual({ code: "AHMED", clickMs: now - 5 * 864e5 });
    expect(parsePartnerCookie(`AHMED.${now + 864e5}`, now)).toEqual({ code: "AHMED", clickMs: now });
    expect(parsePartnerCookie(`AHMED.${now - 31 * 864e5}`, now)).toEqual({ code: "AHMED" });
    expect(parsePartnerCookie("AHMED", now)).toEqual({ code: "AHMED" });
    for (const bad of ["ADMIN.1700000000000", "a-b.1", "", undefined, 5]) expect(parsePartnerCookie(bad, now), String(bad)).toBeNull();
  });

  it("click on day 0, signup on day 29, first payment on day 31: lapsed", () => {
    const click = "2026-10-01T09:00:00.000Z";
    const attribution = { partner: "p@test.example", code: "PCODE", at: click, via: "link" as const };
    const base = { customer: "c@test.example", attribution, partnerExists: true, sameTeam: false };
    expect(commissionDecision({ ...base, firstPaidOn: "2026-11-01", paymentDate: "2026-11-01" })).toEqual({ ok: false, reason: "lapsed" });
    expect(commissionDecision({ ...base, firstPaidOn: "2026-10-31", paymentDate: "2026-10-31" })).toEqual({ ok: true });
  });

  it("a link visitor's code filled into the form is the link's: attributed at the click, by link", async () => {
    const a = await partner("clk");
    const clickMs = Date.now() - 29 * 864e5;
    const { res, email } = await signupVia({ partnerCode: a.code }, partnerCookieValue(a.code, clickMs));
    expect(await body(res)).toMatchObject({ ok: true, partner: true });
    const u = (await getUser(email))!;
    expect(u.referredBy).toMatchObject({ partner: a.user.email, via: "link", at: new Date(clickMs).toISOString() });
    expect(attributionDeadline(u.referredBy!.at), "30 days from the click, not from signup").toBe(ksaDay(clickMs + 30 * 864e5));
  });

  it("a code typed without that partner's cookie starts the 30 days at signup; a second click never restarts them", async () => {
    const a = await partner("clk2");
    const b = await partner("clk3");
    const { email } = await signupVia({ partnerCode: a.code }, partnerCookieValue(b.code, Date.now() - 20 * 864e5));
    const u = (await getUser(email))!;
    expect(u.referredBy).toMatchObject({ partner: a.user.email, via: "code" });
    expect(Date.now() - Date.parse(u.referredBy!.at)).toBeLessThan(60_000);
    jar().clear();
    const first = partnerCookieValue(a.code, Date.now() - 10 * 864e5);
    jar().set(PARTNER_COOKIE, first);
    await visit(a.code);
    expect(jar().get(PARTNER_COOKIE)).toBe(first);
  });
});

describe("rule 404: every payment's commission follows the first payment day; a payment before the referral never counts", () => {
  const attributedDaysAgo = async (prefix: string, days: number) => {
    const a = await partner(prefix);
    const { email } = await signupVia({ partnerCode: a.code });
    const u = (await getUser(email))!;
    await saveUser({ ...u, referredBy: { ...u.referredBy!, at: new Date(Date.now() - days * 864e5).toISOString() } });
    return { a, email };
  };
  type Rec = { payment: { id: string; commission?: { sar: number }; notCounted?: string }; reclassified?: string[] };

  it("a backdated first payment recorded later turns an earlier-recorded lapsed payment into a counted one", async () => {
    const { a, email } = await attributedDaysAgo("bd", 40); // deadline: 10 days ago
    const late = await body<Rec>(record(email, { amountSar: 299, plan: "starter", date: day(-5) }));
    expect(late.payment.notCounted).toBe("lapsed");
    const early = await body<Rec>(record(email, { amountSar: 254, plan: "starter", date: day(-20) }));
    expect(early.payment.commission?.sar).toBe(commissionSar(254));
    expect(early.reclassified).toEqual([late.payment.id]);
    const rows = (await ledger(a.user.email)).filter((r) => r.kind === "commission" && !r.voidedAt);
    expect(rows.length).toBe(2);
    expect(balances(await ledger(a.user.email)).earned).toBe((toH(commissionSar(254)) + toH(commissionSar(299))) / 100);
    expect((await getUser(email))!.firstPaidOn).toBe(day(-20));
  });

  it("voiding the first payment moves the first payment day: a later one past the 30 days loses its commission", async () => {
    const { a, email } = await attributedDaysAgo("vf", 40);
    const first = await body<Rec>(record(email, { amountSar: 254, plan: "starter", date: day(-20) }));
    const second = await body<Rec>(record(email, { amountSar: 299, plan: "starter", date: day(-5) }));
    expect(second.payment.commission).toBeTruthy();
    const v = await body<Rec>(voidPay(email, first.payment.id));
    expect(v.reclassified).toEqual([second.payment.id]);
    expect(balances(await ledger(a.user.email)).earned).toBe(0);
    const later = await body<Rec>(record(email, { amountSar: 299, plan: "starter", date: day() }));
    expect(later.payment.notCounted, "the same answer as the payment before it").toBe("lapsed");
  });

  it("a payment dated before the referral earns nothing and does not use the first-month offer", async () => {
    const a = await partner("pre");
    const u = await newUser("pre-cust");
    await signIn(u.email);
    expect(await status(codeRoute.POST(json("/api/partner/code", "POST", { code: a.code })))).toBe(200);
    const r = await body<{ payment: { notCounted?: string; offer?: string } }>(record(u.email, { amountSar: 299, plan: "starter", date: day(-3) }));
    expect(r.payment).toMatchObject({ notCounted: "before_attribution" });
    expect(r.payment.offer).toBeUndefined();
    expect(await ledger(a.user.email)).toEqual([]);
  });

  it("a ledger row lost halfway is restored by the next payment, and every ledger row has its payment", async () => {
    const a = await partner("heal");
    const { email } = await signupVia({ partnerCode: a.code });
    const { payment } = await body<Rec>(record(email, { amountSar: 254, plan: "starter", date: day() }));
    await db.hdel(`partner:ledger:${a.user.email}`, `c:${payment.id}`);
    await record(email, { amountSar: 299, plan: "starter", date: day() });
    const rows = await ledger(a.user.email);
    expect(rows.map((r) => r.id).sort()).toEqual(Object.keys(await db.hgetall(`payments:${email}`)).sort());
    expect(balances(rows).earned).toBe((toH(commissionSar(254)) + toH(commissionSar(299))) / 100);
  });
});

describe("rule 405: payouts record once, can be voided, and go only to bank details the founder confirmed", () => {
  const payout = async (email: string, extra: Record<string, unknown> = {}) => { await asFounder(); return adminPartners.POST(json("/api/admin/partners", "POST", { action: "payout", email, date: day(), ...extra })); };
  const earn = async (partnerCode: string, amount: number) => {
    const { email } = await signupVia({ partnerCode });
    await record(email, { amountSar: amount, plan: "business", date: day() });
  };

  it("a repeated payout id records one transfer; a mistaken payout is voided and its amount is back", async () => {
    const a = await partner("pid");
    await bankReady(a.user.email);
    await earn(a.code, 4000); // 600 SAR
    const id = `po_${randomBytes(9).toString("hex")}`;
    expect(await body(payout(a.user.email, { id, amountSar: 200 }))).toMatchObject({ ok: true });
    expect(await body(payout(a.user.email, { id, amountSar: 200 }))).toMatchObject({ ok: true, already: true });
    expect(balances(await ledger(a.user.email))).toMatchObject({ paid: 200, balance: 400 });
    expect(await status(payout(a.user.email, { id: "po_x", amountSar: 10 }))).toBe(400);
    await asFounder();
    expect(await status(adminPartners.POST(json("/api/admin/partners", "POST", { action: "void_payout", email: a.user.email, id, reason: "typed twice" })))).toBe(200);
    expect(balances(await ledger(a.user.email))).toMatchObject({ paid: 0, balance: 600 });
    const log = JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { actor: string; what: string; reason?: string };
    expect(log).toMatchObject({ actor: FOUNDER, what: `partner:payout ${id} void sar:200`, reason: "typed twice" });
    expect(await status(adminPartners.POST(json("/api/admin/partners", "POST", { action: "void_payout", email: a.user.email, id: "po_00000000" })))).toBe(404);
    const d = (await partnerDashboard(a.user.email))!;
    expect(d.payouts).toEqual([expect.objectContaining({ sar: 200, voided: true })]);
  });

  it("no payout before the founder confirms the bank details, nor after the partner changes them", async () => {
    const a = await partner("pbk");
    await earn(a.code, 2000); // 300 SAR
    expect(await body(payout(a.user.email, { amountSar: 100 }))).toMatchObject({ ok: false, error: "bank_unconfirmed" });
    await signIn(a.user.email);
    await partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Partner Name", iban: VALID_IBAN }));
    expect((await partnerDashboard(a.user.email))!.bank).toMatchObject({ confirmed: false });
    await asFounder();
    expect(await body(adminPartners.POST(json("/api/admin/partners", "POST", { action: "confirm_bank", email: a.user.email, savedAt: "2020-01-01T00:00:00.000Z" })))).toMatchObject({ ok: false, error: "changed" });
    expect(await body(payout(a.user.email, { amountSar: 200 }))).toMatchObject({ ok: false, error: "bank_unconfirmed" });
    await bankReady(a.user.email);
    expect(bankConfirmed((await getPartner(a.user.email))!.bank)).toBe(true);
    expect((await db.lrange("admin:log", 0, 0))[0]).toContain("partner:bank confirm");
    await signIn(a.user.email);
    await partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Someone Else", iban: VALID_IBAN }));
    expect(await body(payout(a.user.email, { amountSar: 200 })), "a change clears the confirmation").toMatchObject({ ok: false, error: "bank_unconfirmed" });
  });

  it("the console flags a partner whose account was created after the approval (the email's first claimant)", async () => {
    const email = `late2-${randomBytes(4).toString("hex")}@test.example`;
    expect(await status(approve(email, code()))).toBe(200);
    const before = (await listPartners()).find((p) => p.email === email)!;
    expect(before).toMatchObject({ hasAccount: false, accountAfterApproval: false });
    jar().clear();
    await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "Late", lang: "en" }, { "x-real-ip": ip() }));
    expect((await listPartners()).find((p) => p.email === email)).toMatchObject({ hasAccount: true, accountAfterApproval: true, bankConfirmed: false });
    const early = await partner("early-acct");
    expect((await listPartners()).find((p) => p.email === early.user.email)).toMatchObject({ accountAfterApproval: false });
  });

  it("applications sent before the new terms are marked for the founder", () => {
    expect(NEW_TERMS_FROM).toBe("2026-10-01");
    const src = readFileSync("src/components/app/PartnersPanel.tsx", "utf8");
    expect(src).toContain("a.at.slice(0, 10) < NEW_TERMS_FROM");
    expect(src).toContain("15% of each payment for the first 4 months, 30 days, SAR 200 minimum");
  });
});

describe("rule 406: programme days are Riyadh days", () => {
  it("a signup at 01:30 in Riyadh (22:30 UTC the day before) is attributed on the Riyadh day", () => {
    expect(ksaDay(Date.parse("2026-10-01T22:30:00Z"))).toBe("2026-10-02");
    expect(ksaDay(Date.parse("2026-10-01T20:59:00Z"))).toBe("2026-10-01");
    expect(attributionDeadline("2026-10-01T22:30:00Z")).toBe("2026-11-01");
    expect(referralStatus("2026-10-01T22:30:00Z", undefined, Date.parse("2026-10-31T22:00:00Z"))).toBe("trial");
    expect(referralStatus("2026-10-01T22:30:00Z", undefined, Date.parse("2026-11-01T21:00:00Z"))).toBe("lapsed");
  });

  it("the console's default dates are Riyadh's today", () => {
    for (const f of ["src/components/app/PaymentsPanel.tsx", "src/components/app/PartnersPanel.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("ksaDay()");
      expect(src, f).not.toContain("new Date().toISOString().slice(0, 10)");
    }
  });
});

describe("rule 407: a partner sees a random label, and the ledger never holds a customer's email", () => {
  it("the label comes from the attribution's random ref, not from the address", async () => {
    const a = await partner("lbl");
    const { email } = await signupVia({ partnerCode: a.code });
    const u = (await getUser(email))!;
    expect(u.referredBy!.ref).toMatch(/^[a-f0-9]{12}$/);
    expect(customerLabel(u)).toBe(`C-${u.referredBy!.ref!.slice(0, 6).toUpperCase()}`);
    expect(customerLabel({ ...u, referredBy: { ...u.referredBy!, ref: "abcdef000000" } })).not.toBe(customerLabel(u));
  });

  it("commission rows carry the label only; after the customer's account is deleted the console shows no address", async () => {
    const a = await partner("lbw");
    const { email } = await signupVia({ partnerCode: a.code });
    await record(email, { amountSar: 254, plan: "starter", date: day() });
    expect(JSON.stringify(await ledger(a.user.email))).not.toContain(email);
    expect((await listPartners()).find((p) => p.email === a.user.email)!.commissions[0].customer, "a current referral is shown to the founder").toBe(email);
    await wipeAccount(email);
    const after = (await listPartners()).find((p) => p.email === a.user.email)!;
    expect(after.commissions[0].customer).toBeNull();
    expect(JSON.stringify(after)).not.toContain(email);
    expect(after.earned, "the money stays on the ledger").toBe(commissionSar(254));
  });
});

describe("rule 408: the privacy policy covers the partner cookie, the partner's view and bank details", () => {
  it("in Arabic and English", () => {
    const en = JSON.stringify(LEGAL.en.privacy);
    const ar = JSON.stringify(LEGAL.ar.privacy);
    for (const t of ["nashr_partner", "30 days", "pseudonymous label", "IBAN", "Only the founder sees them in full", "deleted with your account"]) expect(en, t).toContain(t);
    for (const t of ["nashr_partner", "30 يوماً", "رمزاً مستعاراً", "الآيبان", "يراهما المؤسس وحده كاملين", "يُحذفان مع حسابك"]) expect(ar, t).toContain(t);
  });
});
