import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "crypto";
import { readFileSync } from "fs";
import { jar, json, newUser, signIn } from "./helpers/session";
import { acct, currentUser, getUser, saveUser, seatLimit, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, globalKey } from "@/lib/keys";
import { ksaDay } from "@/lib/partner-rules";
import { addMonths, seatMonthsLeft } from "@/lib/billing-state";
import { callbackSignText, geideaTimestamp, GEIDEA_API, signGeidea, toRiyals } from "@/lib/geidea";
import type { Payment } from "@/lib/partners";
import { paymentIdFor, priceFor, refundPaymobPayment, renewPaymob, seatCharge, setRenewal, type PayIntent } from "@/lib/billing";
import { createInvite, listInvites, teamView } from "@/lib/team";
import * as checkout from "@/app/api/billing/checkout/route";
import * as webhook from "@/app/api/billing/geidea/webhook/route";

vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async () => true }));

import * as inviteRoute from "@/app/api/team/invite/route";

/**
 * A seat bought mid-year on a yearly subscription (rules 4040-4059, docs/system/tests/4040-yearly-seat-charge.md,
 * docs/system/flows.md sections 110 and 121): the months left of the paid year are charged now on the saved card, before
 * the seat exists; a monthly plan keeps rule 3370 (usable now, charged from the next renewal). Geidea is faked at
 * `fetch` like tests/geidea.test.ts, with saved-card charges on (`GEIDEA_MIT=1`); the pay call may run code first, to
 * change the account while the card is being charged.
 */

const ENV = { GEIDEA_PUBLIC_KEY: "pk-test-fake-geidea-public", GEIDEA_API_PASSWORD: "fake-geidea-api-password-for-tests" };
const PAYMOB_VARS = ["PAYMOB_SECRET_KEY", "PAYMOB_PUBLIC_KEY", "PAYMOB_HMAC_SECRET", "PAYMOB_INTEGRATION_ID_CARD", "PAYMOB_INTEGRATION_ID_MOTO", "PAYMOB_LIVE"];
const on = (extra: Record<string, string> = {}) => {
  for (const k of PAYMOB_VARS) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries({ ...ENV, GEIDEA_LIVE: "", GEIDEA_MIT: "1", ...extra })) vi.stubEnv(k, v);
};

type Session = { id: string; body: Record<string, unknown> };
type Fake = { sessions: Session[]; paths: string[]; refunds: Record<string, unknown>[]; pay: (s: Session) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown } };
let fake: Fake;
function installFake() {
  fake = { sessions: [], paths: [], refunds: [], pay: () => ({ status: 500, body: {} }) };
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== GEIDEA_API) throw new Error(`unexpected fetch ${u.origin}`);
    fake.paths.push(u.pathname);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.pathname === "/payment-intent/api/v2/direct/session") {
      const s = { id: `sess-${randomUUID()}`, body };
      fake.sessions.push(s);
      return Response.json({ responseCode: "000", detailedResponseCode: "000", session: { id: s.id } });
    }
    if (u.pathname === "/pgw/api/v2/direct/pay/token") {
      const r = await fake.pay(fake.sessions.find((x) => x.id === body.sessionId)!);
      return Response.json(r.body, { status: r.status });
    }
    if (u.pathname === "/pgw/api/v2/direct/refund") {
      fake.refunds.push(body);
      return Response.json({ responseCode: "000" });
    }
    return Response.json({}, { status: 404 });
  });
}

beforeEach(() => { on(); installFake(); jar().clear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function order(o: { ref: string; amount: unknown; agreementId?: string; orderId?: string }) {
  return {
    orderId: o.orderId ?? randomUUID(), amount: o.amount, currency: "SAR", status: "Success", detailedStatus: "Paid", merchantReferenceId: o.ref, isTest: true, totalRefundedAmount: 0,
    tokenId: randomUUID(), ...(o.agreementId ? { agreementId: o.agreementId } : {}),
    paymentMethod: { maskedCardNumber: "512345******2346", brand: "Mastercard", expiryDate: { month: 1, year: 38 } },
    transactions: [{ type: "Pay", codes: { responseCode: "000", detailedResponseCode: "000" } }],
  };
}
const envelope = (ord: Record<string, unknown>) => {
  const timeStamp = geideaTimestamp();
  return { order: ord, timeStamp, signature: signGeidea(callbackSignText(ENV.GEIDEA_PUBLIC_KEY, ord, timeStamp)!, ENV.GEIDEA_API_PASSWORD) };
};
let ipSeq = 0;
const ip = () => ({ "x-forwarded-for": `10.40.${++ipSeq % 250}.${(ipSeq * 7) % 250}` });
const hook = async (body: unknown) => ((await (await webhook.POST(json("/api/billing/geidea/webhook", "POST", body, ip()))).json()) as { result?: string }).result;
const payments = async (u: User) => Object.values(await db.hgetall<Payment>(`payments:${acct(u)}`));
const stored = async (u: User) => (await getUser(acct(u)))!;
const freshEmail = () => `yseat-${randomBytes(4).toString("hex")}@test.example`;
const today = () => ksaDay();
/** The saved-card pay call answers paid, under the agreement the checkout saved. */
const paysOk = (agreementId: string, before?: () => Promise<void>) => async (s: Session) => {
  await before?.();
  return { status: 200, body: { responseCode: "000", order: order({ ref: String(s.body.merchantReferenceId), amount: s.body.amount, agreementId }) } };
};

/** A starter owner (1 included seat) paid by `interval` through the real checkout and callback, signed in with its actor. */
async function subscribed(interval: "month" | "year" = "year") {
  const fresh = await newUser("yseat");
  await signIn(fresh.email);
  const res = await checkout.POST(json("/api/billing/checkout", "POST", { kind: "plan", plan: "starter", ...(interval === "year" ? { interval } : {}) }));
  expect(res.status).toBe(200);
  const s = fake.sessions.at(-1)!;
  const agreementId = String((s.body.cofAgreement as { id?: string }).id);
  expect(await hook(envelope(order({ ref: String(s.body.merchantReferenceId), amount: s.body.amount, agreementId })))).toBe("paid");
  fake.paths.length = 0;
  return { u: (await currentUser())!, agreementId };
}
const invite = (u: User, opts: { addSeat?: boolean; seatHalalas?: number } = {}, to = freshEmail(), role = "member") => createInvite(u, u.actor!, to, role, "en", {}, opts);
/** 12 × 25 SAR + 15% VAT: a seat bought on the day a year was paid. */
const YEAR_SEAT = { months: 12, baseHalalas: 30000, totalHalalas: 34500 };

describe("rule 4041: the months left of the paid year", () => {
  it("a started month counts in full; on the anchor day the month ending that day does not", () => {
    const b = { paidThrough: "2027-03-15", anchor: 15 };
    expect(seatMonthsLeft(b, "2026-10-14")).toBe(6);
    expect(seatMonthsLeft(b, "2026-10-15")).toBe(5);
    expect(seatMonthsLeft(b, "2026-10-16")).toBe(5);
    expect(seatMonthsLeft(b, "2027-03-14")).toBe(1);
    expect(seatMonthsLeft(b, "2027-03-15")).toBe(0);
    expect(seatMonthsLeft(b, "2027-04-01")).toBe(0);
  });
  it("on the subscription's own anchor, clamped to short months", () => {
    const b = { paidThrough: "2027-02-28", anchor: 31 };
    expect(seatMonthsLeft(b, "2027-01-30")).toBe(2);
    expect(seatMonthsLeft(b, "2027-01-31")).toBe(1);
    expect(seatMonthsLeft({ paidThrough: addMonths("2026-10-24", 12), anchor: 24 }, "2026-10-24")).toBe(12);
  });
});

describe("rule 4042: a seat's price is priced in code, from src/lib/pricing.ts only", () => {
  it("months × the seat price, VAT on the sum, for a plan that sells seats", () => {
    expect(priceFor("seat", { plan: "starter", extraSeats: 1, seatMonths: 5 })).toEqual({ baseHalalas: 12500, vatHalalas: 1875, amountCents: 14375 });
    expect(priceFor("seat", { plan: "pro", extraSeats: 1, seatMonths: 12 })).toEqual({ baseHalalas: 30000, vatHalalas: 4500, amountCents: 34500 });
  });
  it("null for anything else: an offer, an interval, no months, too many, a fraction, a plan without seats", () => {
    for (const bad of [
      [{ plan: "starter", extraSeats: 1, seatMonths: 5 }, true],
      [{ plan: "starter", extraSeats: 1, seatMonths: 5, interval: "year" }, false],
      [{ plan: "starter", extraSeats: 1 }, false],
      [{ plan: "starter", extraSeats: 1, seatMonths: 0 }, false],
      [{ plan: "starter", extraSeats: 1, seatMonths: 37 }, false],
      [{ plan: "starter", extraSeats: 1, seatMonths: 1.5 }, false],
      [{ plan: "starter", extraSeats: 0, seatMonths: 5 }, false],
      [{ plan: "agency", extraSeats: 1, seatMonths: 5 }, false],
      [{ plan: "trial", extraSeats: 1, seatMonths: 5 }, false],
    ] as const) expect(priceFor("seat", bad[0], bad[1])).toBeNull();
  });
});

describe("rule 4040: a monthly plan is unchanged", () => {
  it("the seat is usable now and charged from the next renewal: no charge now (rule 3370)", async () => {
    const { u } = await subscribed("month");
    expect(await seatCharge(u)).toEqual({ mode: "renewal" });
    expect(await invite(u, { addSeat: true })).toMatchObject({ ok: true, seatAdded: true });
    expect(fake.paths).not.toContain("/pgw/api/v2/direct/pay/token");
    expect((await stored(u)).extraSeats).toBe(1);
  });
  it("a yearly subscription already due behaves like a monthly one: the renewal charges the year", async () => {
    const { u } = await subscribed();
    await saveUser({ ...(await stored(u)), billing: { ...(await stored(u)).billing!, paidThrough: today() } });
    expect(await seatCharge(await stored(u))).toEqual({ mode: "renewal" });
  });
});

describe("rules 4043, 4048, 4050: yearly, a seat is charged now for the months left, then the invite is made", () => {
  it("the 409 states the amount; the confirm with that amount charges it, grants the seat and records the payment", async () => {
    const { u, agreementId } = await subscribed();
    const before = await stored(u);
    expect(await invite(u)).toMatchObject({ ok: false, error: "seats", canBuy: true, charge: YEAR_SEAT });
    // Rule 4050: the flag without the amount the dialog showed charges nothing and answers today's amount again.
    expect(await invite(u, { addSeat: true })).toMatchObject({ ok: false, error: "seats", canBuy: true, charge: YEAR_SEAT });
    expect(await invite(u, { addSeat: true, seatHalalas: 100 })).toMatchObject({ ok: false, error: "seats", charge: YEAR_SEAT });
    expect(fake.paths).not.toContain("/pgw/api/v2/direct/pay/token");
    fake.pay = paysOk(agreementId);
    const to = freshEmail();
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas }, to)).toMatchObject({ ok: true, seatAdded: true });
    const s = fake.sessions.at(-1)!;
    expect(s.body).toMatchObject({ initiatedBy: "Merchant", cardOnFile: true, agreementId, amount: Number(toRiyals(YEAR_SEAT.totalHalalas)) });
    expect(await db.get<PayIntent>(globalKey.payIntent(String(s.body.merchantReferenceId)))).toMatchObject({ kind: "seat", status: "paid", extraSeats: 1, seatMonths: 12, seatThrough: before.billing!.paidThrough });
    const after = await stored(u);
    expect(after.extraSeats).toBe(1);
    expect(seatLimit(after)).toBe(2);
    expect((await listInvites(acct(u))).map((i) => i.email)).toEqual([to]);
    // A seat payment never moves the plan, the paid period, the anchor or the credits.
    expect(after).toMatchObject({ plan: before.plan, credits: before.credits, billing: { plan: "starter", interval: "year", paidThrough: before.billing!.paidThrough, anchor: before.billing!.anchor, status: "active" } });
    const seat = (await payments(u)).find((p) => p.amountSar === 300);
    expect(seat).toMatchObject({ plan: "starter", reference: expect.stringMatching(/^geidea:/) });
  });
  it("the team view gives the owner the amount; the route answers it and takes the confirm", async () => {
    const { u, agreementId } = await subscribed();
    expect((await teamView(u))!.seats).toMatchObject({ canBuy: true, charge: YEAR_SEAT });
    const post = (b: Record<string, unknown>) => inviteRoute.POST(json("/api/team/invite", "POST", { role: "member", ...b }, ip()));
    const to = freshEmail();
    const first = await post({ email: to });
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: "seats", canBuy: true, charge: YEAR_SEAT });
    fake.pay = paysOk(agreementId);
    const ok = await post({ email: to, addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, seatAdded: true });
  });
  it("the next yearly renewal still charges the seat for twelve months (rule 3372)", async () => {
    const { u, agreementId } = await subscribed();
    fake.pay = paysOk(agreementId);
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas })).toMatchObject({ ok: true });
    await saveUser({ ...(await stored(u)), billing: { ...(await stored(u)).billing!, paidThrough: today() } });
    expect(await renewPaymob(acct(u))).toBe("geidea_renewed");
    // (2,990 + 12 × 25) × 1.15
    expect(fake.sessions.at(-1)!.body.amount).toBe(Number(toRiyals(378350)));
  });
});

describe("rule 4044: one charge per click, never two", () => {
  it("a retried confirm after a paid seat charges nothing: the invite exists, the address is taken", async () => {
    const { u, agreementId } = await subscribed();
    fake.pay = paysOk(agreementId);
    const to = freshEmail();
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas }, to)).toMatchObject({ ok: true });
    const sessions = fake.sessions.length;
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas }, to)).toEqual({ ok: false, error: "unavailable" });
    expect(fake.sessions).toHaveLength(sessions);
    expect((await stored(u)).extraSeats).toBe(1);
  });
  it("a seat charge already running for the account answers seat_busy and sends nothing", async () => {
    const { u } = await subscribed();
    await db.lock(accountKey.paySeatLock(acct(u)), 60);
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas })).toEqual({ ok: false, error: "seat_busy" });
    expect(fake.sessions).toHaveLength(1);
    await db.unlock(accountKey.paySeatLock(acct(u)));
  });
});

describe("rule 4045: no seat without a paid charge", () => {
  it("declined: no seat, no invite, a 402 on the route", async () => {
    const { u } = await subscribed();
    fake.pay = () => ({ status: 400, body: { responseCode: "999", detailedResponseCode: "210" } });
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas })).toEqual({ ok: false, error: "seat_declined" });
    expect((await stored(u)).extraSeats).toBeUndefined();
    expect(await listInvites(acct(u))).toHaveLength(0);
    expect(await db.get(accountKey.paySeatWait(acct(u)))).toBeNull();
    const r = await inviteRoute.POST(json("/api/team/invite", "POST", { email: freshEmail(), role: "member", addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas }, ip()));
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual({ error: "seat_declined" });
  });
  it("no answer: pending, no second charge meanwhile; the late callback grants the seat, and the invite then costs nothing", async () => {
    const { u, agreementId } = await subscribed();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.pay = () => ({ status: 502, body: {} });
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas })).toEqual({ ok: false, error: "seat_pending" });
    const s = fake.sessions.at(-1)!;
    const ref = String(s.body.merchantReferenceId);
    expect(await db.get(accountKey.paySeatWait(acct(u)))).toBe(ref);
    expect((await stored(u)).extraSeats).toBeUndefined();
    const sessions = fake.sessions.length;
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas })).toEqual({ ok: false, error: "seat_pending" });
    expect(fake.sessions).toHaveLength(sessions);
    err.mockRestore();
    // The charge went through after all: the callback grants the seat (money always means a seat, rule 4043).
    expect(await hook(envelope(order({ ref, amount: s.body.amount, agreementId })))).toBe("paid");
    expect((await stored(u)).extraSeats).toBe(1);
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas })).toMatchObject({ ok: true });
    expect(fake.sessions).toHaveLength(sessions);
  });
  it("a tampered seat intent is never applied: the amount is recomputed", async () => {
    const { u, agreementId } = await subscribed();
    const ref = randomUUID();
    const b = (await stored(u)).billing!;
    await db.set(globalKey.payIntent(ref), { ref, email: acct(u), acct: acct(u), billingEmail: u.email, kind: "seat", plan: "starter", extraSeats: 1, seatMonths: 12, seatThrough: b.paidThrough, baseHalalas: 100, vatHalalas: 0, amountCents: 100, currency: "SAR", offer: false, createdAt: new Date().toISOString(), status: "open", provider: "geidea" });
    expect(await hook(envelope(order({ ref, amount: 1, agreementId })))).not.toBe("paid");
    expect((await stored(u)).extraSeats).toBeUndefined();
  });
});

describe("rules 4046-4047: a paid seat that cannot be used is refunded", () => {
  it("the subscription moved while the card was charged: refunded, voided, no seat", async () => {
    const { u, agreementId } = await subscribed();
    fake.pay = paysOk(agreementId, async () => {
      await saveUser({ ...(await stored(u)), billing: { ...(await stored(u)).billing!, paidThrough: addMonths((await stored(u)).billing!.paidThrough, 12) } });
    });
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas })).toEqual({ ok: false, error: "seat_changed" });
    expect(fake.refunds).toHaveLength(1);
    expect(fake.refunds[0]).toMatchObject({ refundAmount: 345 });
    expect((await stored(u)).extraSeats).toBeUndefined();
    expect(await listInvites(acct(u))).toHaveLength(0);
    expect((await payments(u)).filter((p) => p.amountSar === 300 && !p.voidedAt)).toHaveLength(0);
  });
  it("the address was invited elsewhere meanwhile: the seat goes back, the charge is refunded, the answer says so", async () => {
    const { u, agreementId } = await subscribed();
    const to = freshEmail();
    // A free viewer invite for the same address lands while the card is charged (no lock is held then).
    fake.pay = paysOk(agreementId, async () => { expect(await invite(u, {}, to, "viewer")).toMatchObject({ ok: true }); });
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas }, to)).toEqual({ ok: false, error: "unavailable", refunded: true });
    expect(fake.refunds).toHaveLength(1);
    expect((await stored(u)).extraSeats).toBeUndefined();
    expect((await payments(u)).filter((p) => p.amountSar === 300 && !p.voidedAt)).toHaveLength(0);
  });
});

describe("rule 4049: no saved-card charge, no seat sold online on a yearly plan", () => {
  it("Geidea without GEIDEA_MIT: canBuy false, blocked no_saved_charge, the flag charges nothing", async () => {
    on({ GEIDEA_MIT: "" });
    const { u } = await subscribed();
    expect((await teamView(u))!.seats).toMatchObject({ canBuy: false, blocked: "no_saved_charge" });
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas })).toMatchObject({ ok: false, error: "seats", canBuy: false, blocked: "no_saved_charge" });
    expect(fake.paths).not.toContain("/pgw/api/v2/direct/pay/token");
    expect((await stored(u)).extraSeats).toBeUndefined();
  });
  it("renewal turned off: blocked no_card", async () => {
    const { u } = await subscribed();
    expect(await setRenewal(acct(u), "cancel")).toMatchObject({ ok: true });
    expect(await invite(await currentUser() as User, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas })).toMatchObject({ ok: false, error: "seats", canBuy: false, blocked: "no_card" });
    expect(fake.sessions).toHaveLength(1);
  });
  it("a subscription of another provider: blocked no_saved_charge", async () => {
    const { u } = await subscribed();
    await saveUser({ ...(await stored(u)), billing: { ...(await stored(u)).billing!, provider: "paymob" } });
    expect(await seatCharge(await stored(u))).toEqual({ mode: "blocked", reason: "no_saved_charge" });
  });
});

describe("rule 4051: the founder's refund of a seat payment never ends the plan", () => {
  it("refunds the seat's order only; the plan, the card and the seat stay", async () => {
    const { u, agreementId } = await subscribed();
    const orderId = randomUUID();
    fake.pay = async (s) => ({ status: 200, body: { responseCode: "000", order: order({ ref: String(s.body.merchantReferenceId), amount: s.body.amount, agreementId, orderId }) } });
    expect(await invite(u, { addSeat: true, seatHalalas: YEAR_SEAT.totalHalalas })).toMatchObject({ ok: true });
    const r = await refundPaymobPayment(acct(u), paymentIdFor(orderId, "geidea"), "founder@thakeen.test", "test");
    expect(r).toMatchObject({ ok: true, alreadyRefunded: false, planEnded: false });
    expect(fake.refunds.at(-1)).toMatchObject({ orderId, refundAmount: 345 });
    const after = await stored(u);
    expect(after).toMatchObject({ plan: "starter", extraSeats: 1, billing: { status: "active", autoRenew: true } });
    expect(await db.get(`pay:card:${acct(u)}`)).not.toBeNull();
  });
});

describe("rule 4052: docs, keys and the release step", () => {
  it("the two new keys are the account's own", () => {
    expect(accountKey.paySeatLock("a_x")).toBe("pay:seatlock:a_x");
    expect(accountKey.paySeatWait("a_x")).toBe("pay:seatwait:a_x");
  });
  it("the rule file names every rule and the expand step; flows.md says the yearly seat is charged now", () => {
    const doc = readFileSync("docs/system/tests/4040-yearly-seat-charge.md", "utf8");
    for (let n = 4040; n <= 4052; n++) expect(doc, String(n)).toContain(String(n));
    expect(doc).toMatch(/expand/i);
    const flows = readFileSync("docs/system/flows.md", "utf8");
    expect(flows).toContain("rule 4043");
  });
});
