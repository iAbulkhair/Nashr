import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jar, json, markVerified, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { createUser, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { codeFor } from "@/lib/referral";
import { wipeAccount } from "@/lib/account";
import {
  ATTRIBUTION_DAYS, COMMISSION_MONTHS, COMMISSION_PCT, COUNTRY_CODES, EARLY_OFFER_DAYS, IBAN_LENGTHS, NEW_TERMS_FROM, PARTNER_COOKIE,
  PARTNER_TERMS_VERSION, PAYOUT_MIN_SAR, attributionDeadline, balances, bankConfirmed, codeProblem, commissionDecision, commissionSar,
  countryOptions, earlyOfferLastDay, ksaDay, maskIban, normalizeCode, optionalTax, parsePartnerCookie, partnerCookieValue, payoutProblem,
  referralStatus, suggestCode, taxField, taxFlags, taxNumberOf, taxTotals, trialLastDay, validAmount, validCountry, validIban, windowEnd, type LedgerRow,
} from "@/lib/partner-rules";
import {
  APPLICATIONS, customerLabel, earlyOfferDue, getPartner, grantEarlyOffer, lastDayOfferOwed, listPartners, offerLastDay, openOffer, partnerByCode,
  partnerDashboard,
} from "@/lib/partners";
import { PARTNER_TERMS } from "@/lib/partner-terms";
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
import PartnerTermsPage from "@/app/[lang]/affiliates/terms/page";

/**
 * The partner programme and the 15% first-month discounts (rules 390-419, docs/superpowers/specs/2026-10-01-affiliates-design.md):
 * own codes approved by the founder, 30-day attribution by link or code, 15% of each payment for the first 4 months,
 * monthly payouts from SAR 200, one first-month discount per account, and a partner page without customer PII; the
 * founder's follow-up decisions (409-417); and, after main's launch security (#233) came in, the console panels through
 * adminFetch (418) and the partner code checked only after Turnstile at signup (419).
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
/** A founder approval; the founder states the partner agreed to the terms outside the form unless `extra` says otherwise (rule 415). */
async function approve(email: string, c: string, extra: Record<string, unknown> = {}) {
  await asFounder();
  return adminPartners.POST(json("/api/admin/partners", "POST", { action: "approve", email, code: c, name: "Partner", consentOutOfBand: true, ...extra }));
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
  const res = await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "Customer", lang: "en", ...fields }, { "x-forwarded-for": ip() }));
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
async function bankReady(email: string, details: Record<string, unknown> = {}) {
  await signIn(email);
  expect(await status(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Partner Name", iban: VALID_IBAN, country: "SA", ...details })))).toBe(200);
  await asFounder();
  const savedAt = (await getPartner(email))!.bank!.savedAt;
  expect(await status(adminPartners.POST(json("/api/admin/partners", "POST", { action: "confirm_bank", email, savedAt })))).toBe(200);
}
const visit = (c: string, headers: Record<string, string> = {}, query = "") => plink.GET(new Request(`https://nashr.test/p/${c}${query}`, { headers: { "x-forwarded-for": ip(), ...headers } }), params({ code: c }));

beforeAll(async () => {
  vi.stubEnv("ADMIN_EMAILS", FOUNDER);
  vi.stubEnv("WAITLIST_ADMIN_KEY", "");
  if (!(await getUser(FOUNDER))) await markVerified((await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "en" })).email);
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
    expect(log).toMatchObject({ actor: FOUNDER, what: `partner:approve code:${c} terms:founder` });
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
    expect(await status(signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "Late", lang: "en" }, { "x-forwarded-for": ip() })))).toBe(200);
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
    for (let i = 0; i < 60; i++) await visit(c, { "x-forwarded-for": addr });
    jar().clear();
    await visit(c, { "x-forwarded-for": addr });
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
    const res = await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "Self", lang: "en", partnerCode: c }, { "x-forwarded-for": ip() }));
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

  it("an account with an unused early-partner offer still holds one offer when it takes a code: the code's", async () => {
    const a = await partner("cc");
    const u = await newUser("early");
    await saveUser({ ...(await getUser(u.email))!, firstMonthOffer: { kind: "early", pct: FIRST_MONTH_DISCOUNT_PCT, at: new Date().toISOString() } });
    expect(await status(claim(u.email, a.code))).toBe(200);
    const x = (await getUser(u.email))!;
    expect(x.firstMonthOffer, "replaced, never stacked").toMatchObject({ kind: "partner", pct: FIRST_MONTH_DISCOUNT_PCT });
    expect(x.firstMonthOffer?.usedAt).toBeUndefined();
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

  it("the billing page owes it from the trial's last day through the offer's last day (rule 410), never after", async () => {
    expect(lastDayOfferOwed(await trial(-48))).toBe(true);
    expect(lastDayOfferOwed(await trial(5))).toBe(true);
    expect(lastDayOfferOwed(await trial(40))).toBe(false);
    expect(lastDayOfferOwed(await trial(-73)), "ended 3 days ago: still within the 7 days").toBe(true);
    expect(lastDayOfferOwed(await trial(-24 * 6)), "ended 6 days ago").toBe(true);
    expect(lastDayOfferOwed(await trial(-24 * 8)), "ended 8 days ago: the offer would already be over").toBe(false);
    expect(lastDayOfferOwed(await trial(-24 * 90)), "ended months ago").toBe(false);
  });

  it("the day-3 note names the 15% on the first month in both languages", () => {
    const src = readFileSync("src/lib/lifecycle.ts", "utf8");
    expect(src).toContain("شهرك الأول عليه خصم ${FIRST_MONTH_DISCOUNT_PCT}% (عرض الشركاء الأوائل، للشهر الأول فقط، وينتهي العرض في ${earlyOfferLastDay(u.trialEnds)})");
    expect(src).toContain("your first month is ${FIRST_MONTH_DISCOUNT_PCT}% off (the early-partner offer, first month only, ending on ${earlyOfferLastDay(u.trialEnds)})");
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
      await markVerified(email);
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
  it("IBANs are checked, including the checksum, and masked to the last four (any country since rule 411)", () => {
    expect(validIban(VALID_IBAN)).toBe(VALID_IBAN);
    expect(validIban("sa03 8000 0000 6080 1016 7519")).toBe(VALID_IBAN);
    expect(validIban("SA0480000000608010167519"), "wrong check digits").toBeNull();
    expect(validIban("SA03800000006080101675")).toBeNull();
    expect(maskIban(VALID_IBAN)).toBe("SA•• •••• •••• •••• •••• 7519");
  });

  it("the partner saves bank details: answered masked, kept in full for the founder, absent from the audit log", async () => {
    const a = await partner("bk");
    await signIn(a.user.email);
    const bad = await partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Partner Name", iban: "SA0480000000608010167519", country: "SA" }));
    expect(bad.status).toBe(400);
    const res = await body<{ ok: boolean; bank: { iban: string } }>(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Partner Name", iban: VALID_IBAN, country: "SA" })));
    expect(res.bank.iban).toBe(maskIban(VALID_IBAN));
    expect((await getPartner(a.user.email))!.bank).toMatchObject({ holder: "Partner Name", iban: VALID_IBAN, country: "SA" });
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
    expect(await status(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Name", iban: VALID_IBAN, country: "SA" })))).toBe(404);
    const a = await partner("bm");
    const m = await newMember(a.user, "admin");
    await signIn(m.email);
    expect(await status(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Name", iban: VALID_IBAN, country: "SA" })))).toBe(403);
    await signIn(a.user.email, { imp: FOUNDER });
    expect(await status(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Name", iban: VALID_IBAN, country: "SA" })))).toBe(403);
    await signIn(a.user.email);
    for (let i = 0; i < 10; i++) await partnerRoute.PUT(json("/api/partner", "PUT", { holder: "", iban: "" }));
    expect(await status(partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Name", iban: VALID_IBAN, country: "SA" })))).toBe(429);
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
    expect(await status(affiliates.POST(json("/api/affiliates", "POST", { name: "Reem Saleh", email, phone: "+966500000000", channel: "YouTube", consent: true }, { "x-forwarded-for": ip() })))).toBe(200);
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
    await partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Name", iban: VALID_IBAN, country: "SA" }));
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
    await partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Partner Name", iban: VALID_IBAN, country: "SA" }));
    expect((await partnerDashboard(a.user.email))!.bank).toMatchObject({ confirmed: false });
    await asFounder();
    expect(await body(adminPartners.POST(json("/api/admin/partners", "POST", { action: "confirm_bank", email: a.user.email, savedAt: "2020-01-01T00:00:00.000Z" })))).toMatchObject({ ok: false, error: "changed" });
    expect(await body(payout(a.user.email, { amountSar: 200 }))).toMatchObject({ ok: false, error: "bank_unconfirmed" });
    await bankReady(a.user.email);
    expect(bankConfirmed((await getPartner(a.user.email))!.bank)).toBe(true);
    expect((await db.lrange("admin:log", 0, 0))[0]).toContain("partner:bank confirm");
    await signIn(a.user.email);
    await partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Someone Else", iban: VALID_IBAN, country: "SA" }));
    expect(await body(payout(a.user.email, { amountSar: 200 })), "a change clears the confirmation").toMatchObject({ ok: false, error: "bank_unconfirmed" });
  });

  it("the console flags a partner whose account was created after the approval (the email's first claimant)", async () => {
    const email = `late2-${randomBytes(4).toString("hex")}@test.example`;
    expect(await status(approve(email, code()))).toBe(200);
    const before = (await listPartners()).find((p) => p.email === email)!;
    expect(before).toMatchObject({ hasAccount: false, accountAfterApproval: false });
    jar().clear();
    await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "Late", lang: "en" }, { "x-forwarded-for": ip() }));
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
    // Since rules 411-414: the country, the tax number, the taxes paid with each transfer and the terms consent.
    for (const t of ["the country you live in", "your tax number", "withholding tax", "agreed to the partner programme terms"]) expect(en, t).toContain(t);
    for (const t of ["دولة إقامتك", "رقمك الضريبي", "ضريبة الاستقطاع", "موافقتك على شروط برنامج الشركاء"]) expect(ar, t).toContain(t);
  });
});

// ---- The founder's follow-up decisions of 2026-10-01 (rules 409-414) ----

describe("rule 409: the commission base and the first-month discount are taken before VAT", () => {
  it("15% of the amount excluding VAT; the first month is the list price excluding VAT less 15%", () => {
    expect(commissionSar(299)).toBe(44.85);
    expect(commissionSar(firstMonthPriceSar("starter"))).toBe(Math.round(firstMonthPriceSar("starter") * 15) / 100);
    for (const k of SELF_SERVE_PLANS) expect(firstMonthPriceSar(k), "VAT is computed on this, never inside it").toBe(Math.round(PLAN_PRICE_SAR[k] * 0.85));
  });

  it("the billing card says so in both languages, and so do the public pages", async () => {
    const a = await partner("vat");
    const { email } = await signupVia({ partnerCode: a.code });
    await markVerified(email);
    await signIn(email);
    expect(await html(BillingPage)).toContain("The discount comes off the price before VAT; VAT is then computed on the discounted price.");
    expect(await html(BillingPage, "ar")).toContain("الخصم على السعر قبل الضريبة، ثم تُحسب ضريبة القيمة المضافة على السعر بعد الخصم.");
    const terms = await html(PartnerTermsPage, "en");
    expect(terms).toContain(`${COMMISSION_PCT}% of each payment (before VAT)`);
    expect(terms).toContain("The discount comes off the price before VAT; VAT is then computed on the discounted price.");
    expect(await html(PartnerTermsPage, "ar")).toContain(`${COMMISSION_PCT}% من كل دفعة (قبل ضريبة القيمة المضافة)`);
    expect(await html(AffiliatesPage, "en")).toContain("Commission is on the payment before VAT");
  });
});

describe("rule 410: the early-partner offer ends 7 days after the trial's last day", () => {
  afterEach(() => vi.useRealTimers());
  // Far after any real run: sessions issued before an account existed are refused (`sessionsAfter`), and the founder's
  // account is created on the real clock, so every faked moment must come after it.
  const T0 = "2096-10-01T09:00:00.000Z"; // 12:00 in Riyadh: a 3-day trial ends 2096-10-04 at 12:00
  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  const view = async (email: string) => {
    await asFounder();
    return body<{ open: boolean; expired: boolean; until: string | null }>(adminPayments.GET(json(`/api/admin/payments/${encodeURIComponent(email)}`, "GET"), params({ email: encodeURIComponent(email) })));
  };

  it("the dates: the trial's last day in Riyadh, plus 7 days", () => {
    expect(EARLY_OFFER_DAYS).toBe(7);
    expect(trialLastDay("2026-10-04T15:00:00Z")).toBe("2026-10-04");
    expect(earlyOfferLastDay("2026-10-04T15:00:00Z")).toBe("2026-10-11");
    expect(trialLastDay("2026-10-04T21:00:00Z"), "ends at midnight in Riyadh: the last day is the day before").toBe("2026-10-04");
    expect(earlyOfferLastDay("2026-10-04T21:00:00Z")).toBe("2026-10-11");
    const u = { trialEnds: "2026-10-04T15:00:00Z", firstMonthOffer: { kind: "early" as const, pct: 15, at: "2026-10-04T10:00:00Z" } };
    expect(openOffer(u, Date.parse("2026-10-11T20:59:59Z")), "23:59 on the last day in Riyadh").not.toBeNull();
    expect(openOffer(u, Date.parse("2026-10-11T21:00:00Z")), "00:00 the day after").toBeNull();
    expect(offerLastDay(u, u.firstMonthOffer)).toBe("2026-10-11");
    const p = { ...u, firstMonthOffer: { ...u.firstMonthOffer, kind: "partner" as const } };
    expect(openOffer(p, Date.parse("2027-01-01T00:00:00Z")), "a partner code's offer has no end date").not.toBeNull();
    expect(offerLastDay(p, p.firstMonthOffer)).toBeNull();
    expect(openOffer({ ...u, firstMonthOffer: { ...u.firstMonthOffer, usedAt: "2026-10-05T00:00:00Z" } }, Date.parse("2026-10-05T00:00:00Z")), "used").toBeNull();
  });

  it("with a fake clock: shown with its end date until the last day, then neither shown nor granted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(T0);
    const u = await newUser("exp");
    expect(earlyOfferLastDay(u.trialEnds)).toBe("2096-10-11");
    at("2096-10-03T20:00:00.000Z"); // the trial's last 24 hours
    await signIn(u.email);
    const en = await html(BillingPage);
    expect(en).toContain(`data-offer="early"`);
    expect(en).toContain("The offer ends on 2096-10-11");
    expect(await html(BillingPage, "ar")).toContain("ينتهي العرض في 2096-10-11");
    at("2096-10-11T20:59:00.000Z"); // 23:59 on the offer's last day in Riyadh
    await signIn(u.email);
    expect(await html(BillingPage)).toContain("The offer ends on 2096-10-11");
    at("2096-10-11T21:00:00.000Z"); // 00:00 on 2096-10-12 in Riyadh
    await signIn(u.email);
    const after = await html(BillingPage);
    expect(after).not.toContain("data-offer");
    expect(after).not.toContain(`SAR ${firstMonthPriceSar("starter")} instead of`);
    expect(await view(u.email)).toMatchObject({ open: false, expired: true, until: "2096-10-11" });
  });

  it("a trial past the window is never granted it; one inside it is", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(T0);
    const late = await newUser("late");
    const inside = await newUser("inside");
    at("2096-10-12T09:00:00.000Z"); // the trial ended 8 days ago
    await signIn(late.email);
    expect(await html(BillingPage)).not.toContain("data-offer");
    expect((await getUser(late.email))!.firstMonthOffer, "no fallback for a trial past its last day").toBeUndefined();
    at("2096-10-10T09:00:00.000Z"); // ended 6 days ago: still within the 7 days
    await signIn(inside.email);
    expect(await html(BillingPage)).toContain(`data-offer="early"`);
    expect((await getUser(inside.email))!.firstMonthOffer?.kind).toBe("early");
  });

  it("a payment dated on or before the last day still uses it (consumed); one dated after does not", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(T0);
    const a = await newUser("used");
    const b = await newUser("missed");
    at("2096-10-04T05:00:00.000Z");
    for (const x of [a, b]) expect(await grantEarlyOffer(x.email, (y) => earlyOfferDue(y))).toBe(true);
    at("2096-10-13T09:00:00.000Z"); // after the offer's last day, the founder records what arrived
    const pa = await body<{ payment: { offer?: string } }>(record(a.email, { amountSar: firstMonthPriceSar("starter"), plan: "starter", date: "2096-10-11" }));
    expect(pa.payment.offer, "money that arrived on the last day").toBe("early");
    expect((await getUser(a.email))!.firstMonthOffer?.usedAt).toBeTruthy();
    expect(await view(a.email)).toMatchObject({ open: false, expired: false });
    const pb = await body<{ payment: { offer?: string } }>(record(b.email, { amountSar: PLAN_PRICE_SAR.starter, plan: "starter", date: "2096-10-12" }));
    expect(pb.payment.offer, "money that arrived after it ended").toBeUndefined();
    expect((await getUser(b.email))!.firstMonthOffer?.usedAt).toBeUndefined();
  });

  it("a partner code replaces an unused early offer, running or ended: one offer, the code's, with no end date", async () => {
    const a = await partner("eoc");
    vi.useFakeTimers({ toFake: ["Date"] });
    at(T0);
    const ended = await newUser("ended");
    const running = await newUser("running");
    at("2096-10-04T05:00:00.000Z");
    for (const x of [ended, running]) expect(await grantEarlyOffer(x.email, (y) => earlyOfferDue(y))).toBe(true);
    const claim = async (email: string) => { await signIn(email); return body(codeRoute.POST(json("/api/partner/code", "POST", { code: a.code }))); };
    at("2096-10-08T09:00:00.000Z"); // still inside the early offer's 7 days
    expect(await claim(running.email)).toMatchObject({ ok: true });
    expect((await getUser(running.email))!.firstMonthOffer?.kind, "the code's offer, not the early one").toBe("partner");
    let page = await html(BillingPage);
    expect(page).toContain(`data-offer="partner"`);
    expect(page, "a partner code's offer has no end date").not.toContain("The offer ends on");
    // Paid after the early offer would have ended, inside the code's 30 days: the customer still gets the discount the
    // partner earns on.
    at("2096-10-13T09:00:00.000Z");
    const paid = await body<{ payment: { offer?: string; commission?: { sar: number } } }>(record(running.email, { amountSar: firstMonthPriceSar("starter"), plan: "starter", date: "2096-10-13" }));
    expect(paid.payment.offer).toBe("partner");
    expect(paid.payment.commission?.sar).toBe(commissionSar(firstMonthPriceSar("starter")));
    at("2096-10-12T09:00:00.000Z"); // the early offer ended on 2096-10-11
    expect(await claim(ended.email)).toMatchObject({ ok: true });
    expect((await getUser(ended.email))!.firstMonthOffer?.kind).toBe("partner");
    page = await html(BillingPage);
    expect(page).toContain(`data-offer="partner"`);
    expect(page).not.toContain("The offer ends on");
  });

  it("the day-3 email names the early offer's end date only when the account holds or is about to get it", async () => {
    const { day3Offer, lifecycleTemplate } = await import("@/lib/lifecycle");
    const ctx = { pending: 1, approved: 2, trialEnds: "2096-10-04" };
    const base = { name: "N", email: "d3@test.example", lang: "en", trialEnds: "2096-10-04T09:00:00.000Z" } as User;
    const early = { ...base, firstMonthOffer: { kind: "early" as const, pct: FIRST_MONTH_DISCOUNT_PCT, at: "2096-10-03T09:00:00.000Z" } };
    const referred = {
      ...base, referredBy: { partner: "p@test.example", code: "RIYADH1", at: "2096-10-01T09:00:00.000Z", via: "code" as const, ref: "abcdef012345" },
      firstMonthOffer: { kind: "partner" as const, pct: FIRST_MONTH_DISCOUNT_PCT, at: "2096-10-01T09:00:00.000Z" },
    };
    const used = { ...early, firstMonthOffer: { ...early.firstMonthOffer, usedAt: "2096-10-04T08:00:00.000Z", paymentId: "pay_00000000" } };
    expect([day3Offer(base), day3Offer(early), day3Offer(referred), day3Offer(used), day3Offer({ ...base, firstPaidOn: "2096-10-02" })])
      .toEqual(["early", "early", "partner", null, null]);
    const last = earlyOfferLastDay(base.trialEnds);
    for (const u of [base, early]) {
      expect(lifecycleTemplate(u, "day3", ctx)!.body, "about to be granted, or held").toContain(`the early-partner offer, first month only, ending on ${last}`);
      expect(lifecycleTemplate({ ...u, lang: "ar" }, "day3", ctx)!.body).toContain(`ينتهي العرض في ${last}`);
    }
    for (const lang of ["en", "ar"] as const) {
      const b = lifecycleTemplate({ ...referred, lang }, "day3", ctx)!.body;
      expect(b, "a partner-referred trial: the code's discount").toContain("RIYADH1");
      expect(b).toContain(`${FIRST_MONTH_DISCOUNT_PCT}%`);
      expect(b, "no early-offer wording").not.toMatch(/early-partner|الشركاء الأوائل/);
      expect(b, "no end date that does not apply").not.toContain(last);
      const u = lifecycleTemplate({ ...used, lang }, "day3", ctx)!.body;
      expect(u, "a used offer is not promised again").not.toContain(`${FIRST_MONTH_DISCOUNT_PCT}%`);
      expect(u).not.toContain(last);
    }
  });
});

/** An IBAN with correct check digits, computed independently with BigInt (ISO 13616: 98 - (BBAN + country + "00") mod 97). */
const ibanFor = (cc: string, bban: string) => {
  const n = BigInt([...`${bban}${cc}00`].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join(""));
  return `${cc}${String(BigInt(98) - (n % BigInt(97))).padStart(2, "0")}${bban}`;
};
const digits = (n: number) => Array.from({ length: n }, (_, i) => String((i * 7 + 3) % 10)).join("");

describe("rule 411: partners from any country: a generic IBAN check, the country and an optional tax number", () => {
  it("every IBAN at its registry length passes, all GCC states included; a wrong length or check digit is refused", () => {
    expect(Object.fromEntries(["SA", "AE", "BH", "KW", "QA", "OM"].map((c) => [c, IBAN_LENGTHS[c]]))).toEqual({ SA: 24, AE: 23, BH: 22, KW: 30, QA: 29, OM: 23 });
    for (const [cc, len] of Object.entries(IBAN_LENGTHS)) {
      const good = ibanFor(cc, digits(len - 4));
      expect(validIban(good), cc).toBe(good);
      expect(validIban(ibanFor(cc, digits(len - 3))), `${cc} one character too long`).toBeNull();
      const bad = `${good.slice(0, 2)}${good[2] === "9" ? "1" : "9"}${good.slice(3)}`;
      expect(validIban(bad), `${cc} wrong check digits`).toBeNull();
    }
  });

  it("published examples pass; a country outside the table passes the generic check; a made-up country does not", () => {
    for (const x of ["GB82 WEST 1234 5698 7654 32", "DE89 3704 0044 0532 0130 00", "AE07 0331 2345 6789 0123 456", VALID_IBAN]) expect(validIban(x), x).toBe(x.replace(/\s/g, ""));
    expect(validIban("GB82WEST12345698765433")).toBeNull();
    const mu = ibanFor("MU", `BOMM${digits(22)}`); // Mauritius, not in the table: 15-34 characters and the checksum
    expect(IBAN_LENGTHS.MU).toBeUndefined();
    expect(validIban(mu)).toBe(mu);
    expect(validIban(ibanFor("ZZ", digits(20))), "not an ISO 3166 country").toBeNull();
    expect(validIban(ibanFor("MU", digits(9))), "shorter than any IBAN").toBeNull();
  });

  it("countries and tax numbers are checked; the select lists Saudi Arabia first and names the rest", () => {
    expect(COUNTRY_CODES).toHaveLength(250);
    expect(validCountry(" ae ")).toBe("AE");
    expect(validCountry("ZZ")).toBeNull();
    expect(validCountry("")).toBeNull();
    expect(taxNumberOf("")).toBeUndefined();
    expect(taxNumberOf(" 300000000000003 ")).toBe("300000000000003");
    expect(taxNumberOf("gb 123 4567 89")).toBe("GB 123 4567 89");
    expect(taxNumberOf("x")).toBe("bad");
    expect(taxNumberOf("<script>")).toBe("bad");
    const ar = countryOptions("ar");
    expect(ar[0][0]).toBe("SA");
    expect(ar).toHaveLength(250);
    expect(ar.find(([c]) => c === "AE")![1]).not.toBe("AE");
    expect(countryOptions("en").find(([c]) => c === "EG")![1]).toBe("Egypt");
  });

  it("a UAE partner saves a UAE IBAN, country and VAT number; a missing country or a bad tax number is refused", async () => {
    const a = await partner("ae");
    await signIn(a.user.email);
    const iban = ibanFor("AE", digits(19));
    const put = (b: Record<string, unknown>) => partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Partner Name", iban, ...b }));
    expect(await body(put({}))).toMatchObject({ ok: false, error: "bad_country" });
    expect(await body(put({ country: "ZZ" }))).toMatchObject({ ok: false, error: "bad_country" });
    expect(await body(put({ country: "AE", taxNumber: "x" }))).toMatchObject({ ok: false, error: "bad_tax_number" });
    const ok = await body<{ ok: boolean; bank: Record<string, unknown> }>(put({ country: "ae", taxNumber: "100123456700003" }));
    expect(ok).toMatchObject({ ok: true, bank: { iban: maskIban(iban), country: "AE", taxNumber: "100123456700003" } });
    expect((await getPartner(a.user.email))!.bank).toMatchObject({ iban, country: "AE", taxNumber: "100123456700003" });
    const page = await html(PartnerPage);
    expect(page).toContain(`<option value="AE"`);
    expect(page).toContain("so you receive the full 15%");
    expect(page).not.toContain(iban);
    expect((await db.lrange("admin:log", 0, -1)).join("\n")).not.toContain(iban);
  });
});

describe("rule 412: Thakeen bears the taxes: payouts record VAT on top and withholding borne, never touching the balance", () => {
  const payout = async (email: string, extra: Record<string, unknown>) => { await asFounder(); return adminPartners.POST(json("/api/admin/partners", "POST", { action: "payout", email, date: day(), reference: "BANK-T", ...extra })); };
  const earn = async (partnerCode: string, amount: number) => {
    const { email } = await signupVia({ partnerCode });
    await record(email, { amountSar: amount, plan: "business", date: day() });
  };

  it("the pure pieces: optional amounts, totals over payouts that stand, flags; the balance ignores them", () => {
    expect(optionalTax(undefined)).toEqual({ ok: true });
    expect(optionalTax("")).toEqual({ ok: true });
    expect(optionalTax(0)).toEqual({ ok: true });
    expect(optionalTax(12.34)).toEqual({ ok: true, sar: 12.34 });
    expect(optionalTax(-1)).toEqual({ ok: false });
    expect(optionalTax(1.234)).toEqual({ ok: false });
    expect(optionalTax("5")).toEqual({ ok: false });
    const rows: LedgerRow[] = [
      { kind: "commission", id: "c1", label: "C-1", paymentDate: day(), baseSar: 2000, sar: 300, at: "x" },
      { kind: "payout", id: "p1", sar: 300, vatSar: 45, whtSar: 15, date: day(), reference: "", at: "x", by: FOUNDER },
      { kind: "payout", id: "p2", sar: 50, vatSar: 7.5, date: day(), reference: "", at: "x", by: FOUNDER, voidedAt: "y" },
    ];
    expect(balances(rows)).toMatchObject({ earned: 300, paid: 300, balance: 0 });
    expect(taxTotals(rows)).toEqual({ vatPaid: 45, whtBorne: 15 });
    expect(taxFlags({ country: "SA" })).toEqual({ vatRegistered: false, outsideSaudi: false, noCountry: false });
    expect(taxFlags({ country: "SA", taxNumber: "300000000000003", vatRegistered: true })).toMatchObject({ vatRegistered: true, outsideSaudi: false });
    expect(taxFlags({ country: "EG" })).toMatchObject({ vatRegistered: false, outsideSaudi: true });
    expect(taxFlags({})).toMatchObject({ noCountry: true });
    expect(taxFlags(null)).toEqual({ vatRegistered: false, outsideSaudi: false, noCountry: false });
  });

  it("a VAT-registered partner outside Saudi Arabia: flagged, paid the full commission, the taxes recorded as entered", async () => {
    const a = await partner("tax");
    await bankReady(a.user.email, { iban: ibanFor("EG", digits(25)), country: "EG", taxNumber: "EG-123-456", vatRegistered: true });
    await earn(a.code, 2000); // 300 SAR commission
    expect(await body(payout(a.user.email, { amountSar: 300, vatSar: -5 }))).toMatchObject({ ok: false, error: "bad_vat" });
    expect(await body(payout(a.user.email, { amountSar: 300, whtSar: 1.234 }))).toMatchObject({ ok: false, error: "bad_wht" });
    expect(await body(payout(a.user.email, { amountSar: 300, vatSar: 12.34, whtSar: 9.87 }))).toMatchObject({ ok: true, payout: { sar: 300, vatSar: 12.34, whtSar: 9.87 } });
    expect(balances(await ledger(a.user.email)), "the partner received the full 300; the taxes are Thakeen's").toMatchObject({ paid: 300, balance: 0 });
    const row = (await listPartners()).find((p) => p.email === a.user.email)!;
    expect(row.tax).toEqual({ vatRegistered: true, outsideSaudi: true, noCountry: false, vatPaid: 12.34, whtBorne: 9.87 });
    expect(row.bank).toMatchObject({ country: "EG", taxNumber: "EG-123-456" });
    expect((await db.lrange("admin:log", 0, 0))[0]).toContain("sar:300 vat:12.34 wht:9.87");
    const d = (await partnerDashboard(a.user.email))!;
    expect(d.payouts[0]).toMatchObject({ sar: 300, vatSar: 12.34 });
    expect(JSON.stringify(d.payouts), "the withholding Thakeen bore is its own cost").not.toContain("wht");
  });

  it("a Saudi partner with no tax number carries no flags, and a payout without taxes records none", async () => {
    const a = await partner("sa");
    await bankReady(a.user.email);
    await earn(a.code, 2000);
    const res = await body<{ payout: Record<string, unknown> }>(payout(a.user.email, { amountSar: 250, vatSar: "", whtSar: 0 }));
    expect(res.payout).not.toHaveProperty("vatSar");
    expect(res.payout).not.toHaveProperty("whtSar");
    expect((await listPartners()).find((p) => p.email === a.user.email)!.tax).toEqual({ vatRegistered: false, outsideSaudi: false, noCountry: false, vatPaid: 0, whtBorne: 0 });
  });

  it("the console shows the flags and the optional tax fields, and codes no tax rate", () => {
    const src = readFileSync("src/components/app/PartnersPanel.tsx", "utf8");
    for (const t of ["VAT-registered: add VAT on payout", "Outside Saudi Arabia: withholding tax may apply — ask your accountant", "data-payout-vat", "data-payout-wht", "data-tax-totals"]) expect(src, t).toContain(t);
    for (const f of ["src/lib/partner-rules.ts", "src/lib/partners.ts", "src/components/app/PartnersPanel.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/VAT_RATE|WHT_RATE|vatRate|whtRate|\* ?0\.15|\* ?0\.05/);
    }
  });
});

describe("rule 413: the public programme terms, in Arabic and English, linked from /affiliates and the partner page", () => {
  it("states each of the founder's points with the last-updated date", async () => {
    expect(PARTNER_TERMS_VERSION).toBe("2026-10-02");
    const en = await html(PartnerTermsPage, "en");
    for (const t of [
      "Partner programme terms", "Last updated 2026-10-02", "18 or older", "One partner account per person", "A bank account (IBAN) in your name",
      `first ${COMMISSION_MONTHS} months of each customer you refer`, `within ${ATTRIBUTION_DAYS} days of using your link or code`,
      `${FIRST_MONTH_DISCOUNT_PCT}% off their first month`, "does not combine with other discounts", `payable balance reaches SAR ${PAYOUT_MIN_SAR}`,
      "Commission on a refunded or voided payment is cancelled", "Thakeen bears VAT on the commission", "withholding tax where it applies",
      "responsible for your own income tax", "Referring yourself or your own team", "Paid ads on the names ذكين / Thakeen", "Spam or unsolicited messages",
      "Promising results or discounts that do not exist", "Presenting yourself as Thakeen", "cancels the commission linked to it", "paid partnership",
      "Mawthooq licence", "30 days&#x27; notice", "your payable balance is paid", "Partners from any country can join",
    ]) expect(en, t).toContain(t);
    const ar = await html(PartnerTermsPage, "ar");
    for (const t of [
      "شروط برنامج الشركاء", "آخر تحديث: 2026-10-02", "18 سنة أو أكثر", "حساب شريك واحد لكل شخص", "حساب بنكي (آيبان) باسمك", `خلال أول ${COMMISSION_MONTHS} أشهر`,
      `خلال ${ATTRIBUTION_DAYS} يوماً`, `خصم ${FIRST_MONTH_DISCOUNT_PCT}% على شهره الأول`, "لا يجتمع مع خصومات أخرى", `رصيدك المستحق ${PAYOUT_MIN_SAR} ريال`,
      "تُلغى عمولتها", "يتحمّل ذكين ضريبة القيمة المضافة", "ضريبة الاستقطاع حيث تنطبق", "ضريبة الدخل الخاصة بك", "إحالة نفسك أو فريقك",
      "«ذكين» أو «Thakeen»", "الرسائل المزعجة", "الوعد بنتائج أو خصومات غير موجودة", "تقديم نفسك على أنك ذكين", "شراكة مدفوعة", "«موثوق»",
      "بإشعار قبل 30 يوماً", "يُصرف لك رصيدك المستحق",
    ]) expect(ar, t).toContain(t);
    for (const h of [en, ar]) expect(h).not.toMatch(/25%|guarantee|نضمن|مضمون/i);
    expect(PARTNER_TERMS.en.sections.map((s) => s.id)).toEqual(PARTNER_TERMS.ar.sections.map((s) => s.id));
  });

  it("/affiliates and the partner page link the terms; /affiliates is open to every country", async () => {
    for (const lang of ["en", "ar"] as const) {
      const page = await html(AffiliatesPage, lang);
      expect(page, lang).toContain(`href="/${lang}/affiliates/terms"`);
      expect(page, lang).not.toMatch(/Gulf agencies|في الخليج\. لك كود/);
    }
    const a = await partner("tl");
    await signIn(a.user.email);
    expect(await html(PartnerPage)).toContain(`href="/en/affiliates/terms"`);
    const u = await newUser("ntl");
    await signIn(u.email);
    expect(await html(PartnerPage, "ar"), "not a partner yet").toContain(`href="/ar/affiliates/terms"`);
    expect(readFileSync("src/app/sitemap.ts", "utf8")).toContain("/affiliates/terms");
  });
});

describe("rule 414: an application needs consent to the terms, and records when and which version", () => {
  const apply = (b: Record<string, unknown>) => affiliates.POST(json("/api/affiliates", "POST", { name: "Sara Ali", phone: "+971500000000", channel: "Newsletter", ...b }, { "x-forwarded-for": ip() }));
  const apps = async () => {
    await asFounder();
    return (await body<{ applications: { email: string; consentAt: string | null; termsVersion: string | null }[] }>(adminPartners.GET(json("/api/admin/partners", "GET")))).applications;
  };

  it("refused without consent and nothing is stored; stored with the date and version with it", async () => {
    const email = `consent-${randomBytes(4).toString("hex")}@test.example`;
    for (const consent of [undefined, false, "false", "yes", 1]) {
      const r = await apply({ email, consent });
      expect(r.status, String(consent)).toBe(400);
      expect(await body(r)).toMatchObject({ ok: false, error: "consent_required" });
    }
    expect((await apps()).some((a) => a.email === email)).toBe(false);
    expect(await status(apply({ email, consent: true }))).toBe(200);
    const row = (await apps()).find((a) => a.email === email)!;
    expect(row.termsVersion).toBe(PARTNER_TERMS_VERSION);
    expect(Date.now() - Date.parse(row.consentAt!)).toBeLessThan(60_000);
    const other = `consent-on-${randomBytes(4).toString("hex")}@test.example`;
    expect(await status(apply({ email: other, consent: "on" })), "a plain form post's checkbox").toBe(200);
  });

  it("an application sent before consent was asked shows none in the console", async () => {
    const email = `old-${randomBytes(4).toString("hex")}@test.example`;
    await db.lpush(APPLICATIONS, JSON.stringify({ id: `app_${randomBytes(8).toString("hex")}`, name: "Old", email, phone: "", channel: "", audience: "", lang: "en", at: "2026-09-20T10:00:00.000Z" }));
    expect((await apps()).find((a) => a.email === email)).toMatchObject({ consentAt: null, termsVersion: null });
    const src = readFileSync("src/components/app/PartnersPanel.tsx", "utf8");
    expect(src).toContain("data-consent");
    expect(src).toContain("data-no-consent");
  });

  it("the form has a required box linking the terms, in both languages", async () => {
    const en = await html(AffiliatesPage, "en");
    const box = /<input[^>]*name="consent"[^>]*>/.exec(en)?.[0] ?? "";
    expect(box).toContain(`type="checkbox"`);
    expect(box).toContain(`required=""`);
    expect(en).toContain("partner programme terms");
    const ar = await html(AffiliatesPage, "ar");
    expect(ar.replace(/<[^>]+>/g, "")).toContain("أوافق على شروط برنامج الشركاء");
    expect(ar).toContain(`href="/ar/affiliates/terms"`);
  });
});

describe("rule 415: no partner without a recorded agreement to the terms, carried onto the partner record", () => {
  const apply = (b: Record<string, unknown>) => affiliates.POST(json("/api/affiliates", "POST", { name: "Sara Ali", phone: "+971500000000", channel: "Newsletter", ...b }, { "x-forwarded-for": ip() }));
  const appOf = async (email: string) => {
    await asFounder();
    return (await body<{ applications: { id: string; email: string; consentAt: string | null }[] }>(adminPartners.GET(json("/api/admin/partners", "GET")))).applications.find((a) => a.email === email)!;
  };
  const row = async (email: string) => (await listPartners()).find((p) => p.email === email);
  const lastLog = async () => (JSON.parse((await db.lrange("admin:log", 0, 0))[0]) as { what: string }).what;

  it("an application that consented: the date and version move onto the partner, and the log says so", async () => {
    const email = `cons-${randomBytes(4).toString("hex")}@test.example`;
    expect(await status(apply({ email, consent: true }))).toBe(200);
    const app = await appOf(email);
    const c = code();
    expect(await status(approve(email, c, { appId: app.id, consentOutOfBand: undefined }))).toBe(200);
    expect((await getPartner(email))!.terms).toEqual({ at: app.consentAt, version: PARTNER_TERMS_VERSION, via: "application" });
    expect((await row(email))!.terms).toMatchObject({ via: "application", version: PARTNER_TERMS_VERSION });
    expect(await lastLog()).toBe(`partner:approve code:${c} terms:application`);
  });

  it("no consent on record is refused and nothing is written; the founder's explicit statement is recorded and logged", async () => {
    const email = `nocons-${randomBytes(4).toString("hex")}@test.example`;
    const id = `app_${randomBytes(8).toString("hex")}`;
    await db.lpush(APPLICATIONS, JSON.stringify({ id, name: "Old", email, phone: "", channel: "", audience: "", lang: "en", at: "2026-09-20T10:00:00.000Z" }));
    const c = code();
    for (const consentOutOfBand of [undefined, false, "true", 1]) {
      const r = await approve(email, c, { appId: id, consentOutOfBand });
      expect(r.status, String(consentOutOfBand)).toBe(400);
      expect(await body(r)).toMatchObject({ ok: false, error: "no_consent" });
    }
    expect(await partnerByCode(c)).toBeNull();
    expect(await getPartner(email)).toBeNull();
    expect(await body(approve(email, c, { consentOutOfBand: undefined })), "manual, no application").toMatchObject({ ok: false, error: "no_consent" });
    expect(await status(approve(email, c, { appId: id, consentOutOfBand: true }))).toBe(200);
    const terms = (await getPartner(email))!.terms!;
    expect(terms).toMatchObject({ version: PARTNER_TERMS_VERSION, via: "founder", by: FOUNDER });
    expect(Date.now() - Date.parse(terms.at)).toBeLessThan(60_000);
    expect(await lastLog()).toBe(`partner:approve code:${c} terms:founder`);
  });

  it("another applicant's consent does not count for a different email", async () => {
    const email = `consa-${randomBytes(4).toString("hex")}@test.example`;
    expect(await status(apply({ email, consent: true }))).toBe(200);
    const app = await appOf(email);
    const other = `consb-${randomBytes(4).toString("hex")}@test.example`;
    expect(await body(approve(other, code(), { appId: app.id, consentOutOfBand: undefined }))).toMatchObject({ ok: false, error: "no_consent" });
  });

  it("a partner record with no agreement shows none, and the console flags it and asks for the statement", async () => {
    const email = `legacy-${randomBytes(4).toString("hex")}@test.example`;
    const c = code();
    await Promise.all([
      db.set(`partner:${email}`, { email, name: "Legacy", code: c, approvedAt: new Date().toISOString(), approvedBy: FOUNDER }),
      db.set(`partnercode:${c}`, email), db.sadd("partners:all", email),
    ]);
    expect((await row(email))!.terms).toBeNull();
    const src = readFileSync("src/components/app/PartnersPanel.tsx", "utf8");
    for (const t of ["data-partner-no-consent", "data-partner-consent", "data-out-of-band", "consentOutOfBand"]) expect(src, t).toContain(t);
  });
});

describe("rule 416: VAT registration is the partner's own answer, separate from the tax number", () => {
  const put = (b: Record<string, unknown>) => partnerRoute.PUT(json("/api/partner", "PUT", { holder: "Partner Name", iban: VALID_IBAN, country: "EG", ...b }));
  const flags = async (email: string) => (await listPartners()).find((p) => p.email === email)!.tax;

  it("a tax number alone (an income-tax id) flags nothing; the box needs a number; only true counts", async () => {
    const a = await partner("vat");
    await signIn(a.user.email);
    expect(await body(put({ taxNumber: "TIN-998877" }))).toMatchObject({ ok: true, bank: { taxNumber: "TIN-998877", vatRegistered: false } });
    expect(await flags(a.user.email)).toMatchObject({ vatRegistered: false, outsideSaudi: true });
    await signIn(a.user.email);
    const r = await put({ vatRegistered: true });
    expect(r.status).toBe(400);
    expect(await body(r)).toMatchObject({ ok: false, error: "vat_number_required" });
    await signIn(a.user.email);
    expect(await body(put({ taxNumber: "EG-123-456", vatRegistered: "true" }))).toMatchObject({ ok: true, bank: { vatRegistered: false } });
    await signIn(a.user.email);
    expect(await body(put({ taxNumber: "EG-123-456", vatRegistered: true }))).toMatchObject({ ok: true, bank: { vatRegistered: true } });
    expect((await getPartner(a.user.email))!.bank).toMatchObject({ taxNumber: "EG-123-456", vatRegistered: true });
    expect(await flags(a.user.email)).toMatchObject({ vatRegistered: true });
    expect((await partnerDashboard(a.user.email))!.bank).toMatchObject({ vatRegistered: true });
    expect(taxFlags({ country: "EG", taxNumber: "TIN-1" })).toMatchObject({ vatRegistered: false });
    expect(taxFlags({ country: "EG", vatRegistered: true }), "no number, no flag").toMatchObject({ vatRegistered: false });
  });

  it("the bank form has the box in both languages and the tax note points to it", async () => {
    const a = await partner("vatform");
    await signIn(a.user.email);
    const en = await html(PartnerPage, "en");
    expect(en).toMatch(/<input[^>]*type="checkbox"[^>]*name="vatRegistered"/);
    expect(en).toContain("I am VAT-registered");
    expect(en).toContain("tick the box and enter your VAT number");
    expect((await html(PartnerPage, "ar")).replace(/<[^>]+>/g, "")).toContain("أنا مسجّل في ضريبة القيمة المضافة");
  });
});

describe("rule 417: a tax amount typed wrong on the payout form is refused, never dropped", () => {
  it("taxField keeps what is not a number as text, so the server refuses it after the JSON round trip", () => {
    expect(taxField("")).toBeUndefined();
    expect(taxField("  ")).toBeUndefined();
    expect(taxField(" 12.5 ")).toBe(12.5);
    expect(taxField("1,500")).toBe("1,500");
    expect(taxField("12,5")).toBe("12,5");
    const wire = (v: unknown) => (JSON.parse(JSON.stringify({ v })) as { v: unknown }).v;
    expect(optionalTax(wire(Number("1,500"))), "the old way: NaN became null and read as no amount").toEqual({ ok: true });
    expect(optionalTax(wire(taxField("1,500")))).toEqual({ ok: false });
    expect(optionalTax(wire(taxField("12.34")))).toEqual({ ok: true, sar: 12.34 });
  });

  it("the payout is refused with bad_vat or bad_wht and nothing is recorded; the console sends taxField", async () => {
    const a = await partner("typo");
    await bankReady(a.user.email);
    const { email } = await signupVia({ partnerCode: a.code });
    await record(email, { amountSar: 2000, plan: "business", date: day() });
    const payout = async (extra: Record<string, unknown>) => { await asFounder(); return adminPartners.POST(json("/api/admin/partners", "POST", { action: "payout", email: a.user.email, date: day(), amountSar: 300, ...extra })); };
    expect(await body(payout({ vatSar: taxField("1,500") }))).toMatchObject({ ok: false, error: "bad_vat" });
    expect(await body(payout({ whtSar: taxField("12,5") }))).toMatchObject({ ok: false, error: "bad_wht" });
    expect((await ledger(a.user.email)).filter((r) => r.kind === "payout")).toHaveLength(0);
    const src = readFileSync("src/components/app/PartnersPanel.tsx", "utf8");
    expect(src).toContain("vatSar: taxField(vat), whtSar: taxField(wht)");
  });
});

describe("rule 418: the Partners tab and the Payments panel make their admin calls through adminFetch, next to the Leads tab", () => {
  it("no direct fetch in either panel, both admin APIs through adminFetch, and the console keeps both new tabs", () => {
    for (const f of ["PartnersPanel", "PaymentsPanel"]) {
      const src = readFileSync(`src/components/app/${f}.tsx`, "utf8");
      expect(src, `${f}: a direct fetch would leave an empty panel when the key session ends (rule 436)`).not.toMatch(/(?<![A-Za-z])fetch\(/);
      expect(src, f).toContain('import { adminFetch } from "@/lib/admin-fetch";');
    }
    const partners = readFileSync("src/components/app/PartnersPanel.tsx", "utf8");
    expect(partners).toContain('adminFetch("/api/admin/partners").then(');
    expect(partners).toContain('adminFetch("/api/admin/partners", { method: "POST"');
    const payments = readFileSync("src/components/app/PaymentsPanel.tsx", "utf8");
    expect(payments).toContain("adminFetch(`/api/admin/payments/${who}`).then(");
    expect(payments).toContain("adminFetch(`/api/admin/payments/${who}`, { method: \"POST\"");
    // The sections moved to their own pages under /{lang}/admin on 2026-10-09 (rule 871): src/lib/admin-gate.ts lists them.
    expect(readFileSync("src/lib/admin-gate.ts", "utf8")).toMatch(/ADMIN_SECTIONS = \[[^\]]*"leads"[^\]]*"partners"[^\]]*\] as const/);
    expect(readFileSync("src/app/[lang]/admin/partners/page.tsx", "utf8")).toContain("<PartnersPanel lang={lang} />");
    expect(readFileSync("src/app/[lang]/admin/leads/page.tsx", "utf8")).toContain("<LeadsPanel lang={lang} />");
    expect(readFileSync("src/components/app/LeadsPanel.tsx", "utf8")).toContain("window.dispatchEvent(new Event(ADMIN_LEADS_SEEN))");
    expect(readFileSync("src/components/admin/AdminNav.tsx", "utf8")).toMatch(/partners: "Partners"/);
    expect(readFileSync("src/components/admin/AdminNav.tsx", "utf8")).toMatch(/partners: "الشركاء"/);
  });
});

describe("rule 419: signup looks up a partner code only after Turnstile", () => {
  const on = () => { vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAAAAAApartnersite"); vi.stubEnv("TURNSTILE_SECRET_KEY", "0x4AAAAAAApartnersecret"); };
  afterEach(() => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.restoreAllMocks();
  });
  const codeLookups = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([k]) => String(k).startsWith("partnercode:")).length;

  it("without a passed check a wrong code and a partner's code get the same captcha_failed, and no code is looked up", async () => {
    const a = await partner("tsa");
    on();
    const get = vi.spyOn(db, "get");
    const wrong = await signupVia({ partnerCode: "NOSUCHCODE9" });
    const right = await signupVia({ partnerCode: a.code });
    expect([wrong.res.status, (await body(wrong.res)).error]).toEqual([400, "captcha_failed"]);
    expect([right.res.status, (await body(right.res)).error]).toEqual([400, "captcha_failed"]);
    expect(codeLookups(get), "a script cannot learn which codes exist without passing Turnstile").toBe(0);
    expect(await getUser(wrong.email)).toBeNull();
    expect(await getUser(right.email)).toBeNull();
  });

  it("after a passed check a wrong code is still refused before the account exists, and a partner's code attributes", async () => {
    const a = await partner("tsb");
    on();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const wrong = await signupVia({ partnerCode: "NOSUCHCODE9", turnstile: "good-token" });
    expect([wrong.res.status, (await body(wrong.res)).error]).toEqual([400, "bad_partner_code"]);
    expect(await getUser(wrong.email)).toBeNull();
    const right = await signupVia({ partnerCode: a.code, turnstile: "good-token" });
    expect(await body(right.res)).toMatchObject({ ok: true, partner: true });
    expect((await getUser(right.email))!.referredBy).toMatchObject({ partner: a.user.email, code: a.code, via: "code" });
  });

  it("the route checks Turnstile before the partner code", () => {
    const src = readFileSync("src/app/api/auth/signup/route.ts", "utf8");
    expect(src.indexOf("captchaRefusal(req, b.turnstile)")).toBeGreaterThan(0);
    expect(src.indexOf("captchaRefusal(req, b.turnstile)")).toBeLessThan(src.indexOf("signupPartner(b.partnerCode)"));
  });
});
