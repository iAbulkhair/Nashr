import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { jar, json, newMember, newUser, signIn } from "./helpers/session";
import { acct, currentUser, getUser, saveUser, seatLimit, type Actor, type User } from "@/lib/auth";
import { can, IMPERSONATION_BLOCKED } from "@/lib/roles";
import { cancelInvite, createInvite, listInvites, removeMember, seatCount, settleExtraSeats, teamView } from "@/lib/team";
import { billableExtraSeats, EXTRA_SEAT_MONTHLY_SAR, extraSeatsLine, extraSeatsSold, includedSeats, monthlyTotal, paidExtraSeats, vatHalalasOf } from "@/lib/pricing";
import { cardKey, priceFor, renewPaymob } from "@/lib/billing";
import { monthKey } from "@/lib/credits";
import { ksaDay } from "@/lib/partner-rules";
import type { Billing } from "@/lib/billing-state";
import { db } from "@/lib/db";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SeatsBillingCard from "@/components/app/settings/SeatsBillingCard";

const sent: string[] = [];
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async (...a: unknown[]) => { sent.push(String(typeof a[0] === "string" ? a[0] : (a[0] as { to: string }).to)); return true; } }));

import * as invite from "@/app/api/team/invite/route";

/**
 * Paid extra seats (rules 3360-3379, docs/system/flows.md section 121, spec docs/superpowers/specs/2026-10-23-paid-seats.md):
 * 25 SAR a month before VAT for each seat above the plan's included seats, bought by the owner's own session with an explicit
 * confirm, usable at once, charged from the next renewal, trimmed at renewal when the team shrank.
 */

const ENV = {
  PAYMOB_SECRET_KEY: "sk_test_fake_secret_for_unit_tests",
  PAYMOB_PUBLIC_KEY: "pk_test_fake_public_for_unit_tests",
  PAYMOB_HMAC_SECRET: "fake-hmac-secret-for-unit-tests",
  PAYMOB_INTEGRATION_ID_CARD: "111111",
  PAYMOB_INTEGRATION_ID_MOTO: "222222",
};

type Call = { path: string; body: Record<string, unknown> };
let calls: Call[] = [];
let payAmount = 0;
let nextOrder = 900000 + Math.floor(Math.random() * 50000);
let txnSeq = 80000000 + Math.floor(Math.random() * 1000000);
const intents: { orderId: number; ref: string }[] = [];
function installFake() {
  calls = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== "https://ksa.paymob.com") throw new Error(`unexpected fetch ${u.origin}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: u.pathname, body });
    if (u.pathname === "/v1/intention/") {
      const orderId = ++nextOrder;
      intents.push({ orderId, ref: String(body.special_reference) });
      return Response.json({ id: `pi_test_${orderId}`, client_secret: `csk_test_${orderId}`, intention_order_id: orderId, payment_keys: [{ integration: (body.payment_methods as number[])[0], key: `paykey_${orderId}` }] }, { status: 201 });
    }
    if (u.pathname === "/api/acceptance/payments/pay") {
      const last = intents.at(-1)!;
      return Response.json({
        id: ++txnSeq, pending: false, amount_cents: payAmount, success: true, is_auth: false, is_capture: false, is_standalone_payment: true, is_voided: false,
        is_refunded: false, is_3d_secure: false, integration_id: 222222, has_parent_transaction: false, owner: 1053928, created_at: "2026-10-23T10:00:00.000000",
        currency: "SAR", error_occured: false, is_live: false, source_data: { pan: "2346", type: "card", sub_type: "MasterCard" }, order: { id: last.orderId, merchant_order_id: last.ref },
      });
    }
    return Response.json({}, { status: 404 });
  });
}

beforeEach(() => {
  sent.length = 0;
  jar().clear();
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("MAIL_FROM", "Noor <noor@mail.nashr.test>");
  installFake();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const freshEmail = (p = "seat") => `${p}-${randomBytes(4).toString("hex")}@test.example`;
let ipN = 0;
const ip = () => { ipN++; return { "x-forwarded-for": `198.19.${Math.floor(ipN / 250)}.${ipN % 250}` }; };

/** An owner on `plan`, signed in, resolved with its owner actor. */
async function owner(plan: User["plan"], extra: Partial<User> = {}): Promise<User> {
  const u = await newUser("seat");
  await saveUser({ ...(await getUser(u.email))!, plan, ...extra });
  await signIn(u.email);
  return (await currentUser())!;
}
const me = async (email: string) => { await signIn(email); return (await currentUser())!; };
const stored = async (u: User) => (await getUser(u.email))!;
const inviteOne = (u: User, opts: { addSeat?: boolean } = {}, actor: Actor = u.actor!, role = "member") => createInvite(u, actor, freshEmail(), role, "en", {}, opts);
const inviteViewer = (u: User, opts: { addSeat?: boolean } = {}) => inviteOne(u, opts, u.actor!, "viewer");

describe("the price (rules 3360-3362)", () => {
  it("25 SAR a month before VAT, defined once, in src/lib/pricing.ts", () => {
    expect(EXTRA_SEAT_MONTHLY_SAR).toBe(25);
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
    walk(join(process.cwd(), "src"));
    const defining = files.filter((f) => /EXTRA_SEAT_MONTHLY_SAR\s*=/.test(readFileSync(f, "utf8")));
    expect(defining.map((f) => f.slice(process.cwd().length + 1))).toEqual(["src/lib/pricing.ts"]);
    // No copy types the number: the team and billing copy fill it from the constant.
    for (const f of ["src/lib/app-i18n-team.ts", "src/components/app/TeamPanel.tsx", "src/components/app/settings/SeatsBillingCard.tsx", "src/components/admin/users-copy.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(/\b25\s*(SAR|ريال)/);
    }
  });
  it("VAT is 15% on the seat line, rounded to the halala like a plan (rule 3361)", () => {
    expect(vatHalalasOf(2500)).toBe(375);
    expect(extraSeatsLine(2)).toEqual({ seats: 2, unitSar: 25, baseHalalas: 5000, vatHalalas: 750, totalHalalas: 5750 });
    expect(extraSeatsLine(0)).toMatchObject({ baseHalalas: 0, vatHalalas: 0, totalHalalas: 0 });
    // The monthly total: plan + seats, VAT on the sum.
    expect(monthlyTotal({ plan: "pro", extraSeats: 2 })).toEqual({ planHalalas: 49900, seatsHalalas: 5000, baseHalalas: 54900, vatHalalas: 8235, totalHalalas: 63135 });
    expect(monthlyTotal({ plan: "starter" })).toEqual({ planHalalas: 29900, seatsHalalas: 0, baseHalalas: 29900, vatHalalas: 4485, totalHalalas: 34385 });
  });
  it("a renewal is priced plan + seats × 25, VAT on the sum; a checkout never adds seats (rule 3372)", () => {
    expect(priceFor("renewal", { plan: "starter", extraSeats: 2 })).toEqual({ baseHalalas: 34900, vatHalalas: 5235, amountCents: 40135 });
    expect(priceFor("renewal", { plan: "starter" })).toEqual({ baseHalalas: 29900, vatHalalas: 4485, amountCents: 34385 });
    expect(priceFor("plan", { plan: "starter", extraSeats: 2 })).toEqual({ baseHalalas: 29900, vatHalalas: 4485, amountCents: 34385 });
    // A price lock lowers the plan part only.
    expect(priceFor("renewal", { plan: "pro", extraSeats: 1 }, false, 29900)).toEqual({ baseHalalas: 32400, vatHalalas: 4860, amountCents: 37260 });
    // Junk on an intent counts as no seats.
    for (const bad of ["2", -1, 0, 1.5, null, NaN]) expect(priceFor("renewal", { plan: "starter", extraSeats: bad })!.amountCents).toBe(34385);
    // Capped like the founder's seat override.
    expect(priceFor("renewal", { plan: "starter", extraSeats: 501 })).toEqual(priceFor("renewal", { plan: "starter", extraSeats: 500 }));
  });
});

describe("the seat count (rules 3363-3364)", () => {
  it("an old record without extraSeats reads as 0 extra; the limit is the included seats", () => {
    expect(paidExtraSeats({ plan: "pro" })).toBe(0);
    expect(seatLimit({ plan: "pro" })).toBe(3);
    expect(includedSeats({ plan: "starter" })).toBe(1);
    for (const bad of ["2", -1, 0, NaN, Infinity] as unknown[]) expect(paidExtraSeats({ plan: "pro", extraSeats: bad as number })).toBe(0);
    expect(paidExtraSeats({ plan: "pro", extraSeats: 2.7 })).toBe(2);
  });
  it("only starter, pro and business sell seats; a trial or Agency reads 0 extra whatever is stored", () => {
    expect(["starter", "pro", "business"].every((p) => extraSeatsSold(p as User["plan"]))).toBe(true);
    expect(extraSeatsSold("trial")).toBe(false);
    expect(extraSeatsSold("agency")).toBe(false);
    expect(paidExtraSeats({ plan: "trial", extraSeats: 3 })).toBe(0);
    expect(seatLimit({ plan: "trial", extraSeats: 3 })).toBe(3);
  });
  it("the founder's seats override still sets the included seats; paid seats sit on top", () => {
    expect(seatLimit({ plan: "business", seats: 10 })).toBe(10);
    expect(seatLimit({ plan: "business", seats: 10, extraSeats: 2 })).toBe(12);
    expect(includedSeats({ plan: "business", seats: 10, extraSeats: 2 } as { plan: "business"; seats: number })).toBe(10);
  });
  it("one seat count: M3's seatCount (owner + paid roles + pending invites, free viewers aside), and no other module recomputes it", () => {
    expect(seatCount([], [])).toBe(1);
    expect(seatCount([{}, { disabled: "seats" }, {}], [{}, {}])).toBe(5);
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
    walk(join(process.cwd(), "src"));
    const rel = (f: string) => f.slice(process.cwd().length + 1);
    // Defined once, in src/lib/team.ts (rule 3753), with its formula written once.
    expect(files.filter((f) => /function seatCount\(/.test(readFileSync(f, "utf8"))).map(rel)).toEqual(["src/lib/team.ts"]);
    const team = readFileSync(join(process.cwd(), "src/lib/team.ts"), "utf8");
    expect(team.match(/function seatCount\(/g)).toHaveLength(1);
    expect(team.match(/return 1 \+ paid \+ Math\.max\(0, viewers - FREE_VIEWERS\)/g)).toHaveLength(1);
    // The pre-M3 inline count (owner + every active member) is gone everywhere: it would bill free viewers.
    expect(files.filter((f) => /1 \+ \w+\.filter\(\(\w\) => !\w\.disabled\)\.length/.test(readFileSync(f, "utf8"))).map(rel)).toEqual([]);
  });
  it("billable = max(0, used − included), pending invites included in used", () => {
    expect(billableExtraSeats(1, 3)).toBe(0);
    expect(billableExtraSeats(5, 3)).toBe(2);
  });
});

describe("free viewers are never billed (rules 3364, 3753)", () => {
  it("3 viewers = 0 extra seats, the 4th viewer = 1", () => {
    const v = { role: "viewer" };
    expect(billableExtraSeats(seatCount([v, v], [v]), 1)).toBe(0);
    expect(billableExtraSeats(seatCount([v, v], [v, v]), 1)).toBe(1);
    expect(billableExtraSeats(seatCount([v, v, v, v], []), 1)).toBe(1);
  });
  it("on Starter (1 seat), 3 viewer invites need no seat; the 4th asks to pay and with the confirm buys exactly 1", async () => {
    const u = await owner("starter");
    for (let i = 0; i < 3; i++) {
      const r = await inviteViewer(await me(u.email));
      expect(r.ok && "seatAdded" in r).toBe(false);
      expect(r.ok).toBe(true);
    }
    expect((await stored(u)).extraSeats).toBeUndefined();
    expect((await teamView(await me(u.email)))!.seats).toMatchObject({ used: 1, limit: 1, extra: 0, freeViewersLeft: 0, canBuy: true });
    expect(await inviteViewer(await me(u.email))).toMatchObject({ ok: false, error: "seats", used: 1, limit: 1, canBuy: true });
    expect(await inviteViewer(await me(u.email), { addSeat: true })).toMatchObject({ ok: true, seatAdded: true });
    expect((await stored(u)).extraSeats).toBe(1);
    // The renewal settle bills the same count: 1 seat, not 4.
    expect(await settleExtraSeats(acct(u))).toBe(1);
  });
  it("the settle drops a seat that only free viewers would fill", async () => {
    const u = await owner("starter");
    await saveUser({ ...(await stored(u)), extraSeats: 2 });
    for (let i = 0; i < 3; i++) expect((await inviteViewer(await me(u.email))).ok).toBe(true);
    expect(await settleExtraSeats(acct(u))).toBe(0);
  });
});

describe("who may buy (rules 3366-3368)", () => {
  it("billing.seats is the owner's own session only: never an admin, the founder or a token", async () => {
    const u = await owner("pro");
    const a = u.actor!;
    expect(can(u, "billing.seats")).toBe(true);
    expect(can({ ...u, actor: { ...a, kind: "founder" } }, "billing.seats")).toBe(false);
    expect(can({ ...u, actor: { ...a, kind: "token" } }, "billing.seats")).toBe(false);
    expect(can({ ...u, actor: { ...a, kind: "member", role: "admin" } }, "billing.seats")).toBe(false);
    expect(IMPERSONATION_BLOCKED.has("billing.seats")).toBe(true);
  });
  it("over the limit without the confirm flag: refused with what the confirm step shows", async () => {
    const u = await owner("starter");
    expect(await inviteOne(u)).toEqual({ ok: false, error: "seats", used: 1, limit: 1, included: 1, extra: 0, unitSar: 25, canBuy: true });
    expect((await stored(u)).extraSeats).toBeUndefined();
    expect(await listInvites(acct(u))).toHaveLength(0);
  });
  it("with the owner's confirm: one seat is added and the invite is made (rule 3369)", async () => {
    const u = await owner("starter");
    const r = await inviteOne(u, { addSeat: true });
    expect(r).toMatchObject({ ok: true, seatAdded: true });
    expect((await stored(u)).extraSeats).toBe(1);
    expect(seatLimit(await stored(u))).toBe(2);
    // A seat with room left is never bought: the flag on an invite that fits buys nothing.
    const pro = await owner("pro");
    const fits = await inviteOne(pro, { addSeat: true });
    expect(fits.ok && "seatAdded" in fits).toBe(false);
    expect((await stored(pro)).extraSeats).toBeUndefined();
  });
  it("an admin cannot buy, even with the flag", async () => {
    const o = await owner("pro");
    const m = await newMember(o, "admin");
    expect((await inviteOne(o)).ok).toBe(true); // owner + admin + 1 invite = 3 = the limit
    const admin = await me(m.email);
    expect(admin.actor!.kind).toBe("member");
    expect(await inviteOne(admin, { addSeat: true })).toMatchObject({ ok: false, error: "seats", canBuy: false });
    expect((await stored(o)).extraSeats).toBeUndefined();
  });
  it("the founder (impersonating) and a token cannot buy", async () => {
    const u = await owner("starter");
    for (const kind of ["founder", "token"] as const) {
      const r = await inviteOne(u, { addSeat: true }, { ...u.actor!, kind });
      expect(r.ok).toBe(false);
    }
    expect((await stored(u)).extraSeats).toBeUndefined();
  });
  it("a trial cannot buy (rule 3363)", async () => {
    const u = await owner("trial");
    expect((await inviteOne(u)).ok).toBe(true);
    expect((await inviteOne(u)).ok).toBe(true);
    expect(await inviteOne(u, { addSeat: true })).toMatchObject({ ok: false, error: "seats", used: 3, limit: 3, canBuy: false });
    expect((await stored(u)).extraSeats).toBeUndefined();
  });
  it("Agency and a locked bill cannot buy", async () => {
    const ag = await owner("agency", { seats: 1 });
    expect(await inviteOne(ag, { addSeat: true })).toMatchObject({ ok: false, error: "seats", canBuy: false });
    const lockedBilling: Billing = { provider: "paymob", plan: "starter", status: "locked", paidThrough: ksaDay(), anchor: 1, autoRenew: false, failures: 0, txns: [] };
    const locked = await owner("starter", { billing: lockedBilling });
    expect(await inviteOne(locked, { addSeat: true })).toMatchObject({ ok: false, error: "seats", canBuy: false });
    expect((await stored(locked)).extraSeats).toBeUndefined();
  });
  it("the team view tells the owner the price and that they can buy; an admin is told they cannot", async () => {
    const o = await owner("starter");
    expect((await teamView(o))!.seats).toMatchObject({ included: 1, extra: 0, unitSar: 25, canBuy: true });
    await inviteOne(o, { addSeat: true });
    const m = await newMember(o, "admin");
    void m;
    expect((await teamView(await me(o.email)))!.seats).toMatchObject({ extra: 1 });
  });
});

describe("exactly one seat short (rule 3367)", () => {
  it("a team already over its limit (a downgrade) is never fitted by buying seats behind one click", async () => {
    const u = await owner("pro");
    expect((await inviteOne(u)).ok).toBe(true);
    expect((await inviteOne(await me(u.email))).ok).toBe(true);
    await saveUser({ ...(await stored(u)), plan: "starter" }); // 3 used, 1 included
    expect(await inviteOne(await me(u.email), { addSeat: true })).toMatchObject({ ok: false, error: "seats", used: 3, limit: 1, canBuy: false });
    // The Members page does not offer it either.
    expect((await teamView(await me(u.email)))!.seats).toMatchObject({ used: 3, limit: 1, canBuy: false });
    expect((await stored(u)).extraSeats).toBeUndefined();
  });
});

describe("the billing page card (rule 3365)", () => {
  it("shows included, extra, the per-seat price and plan + seats + VAT = total, in both languages", () => {
    const en = renderToStaticMarkup(createElement(SeatsBillingCard, { lang: "en", user: { plan: "pro", extraSeats: 2 }, used: 5 }));
    for (const s of ["Seats included in the plan", "Paid extra seats", "25 SAR/month + VAT", "499.00 SAR", "50.00 SAR", "82.35 SAR", "631.35 SAR", "5 / 5"]) expect(en, s).toContain(s);
    const ar = renderToStaticMarkup(createElement(SeatsBillingCard, { lang: "ar", user: { plan: "pro", extraSeats: 2 }, used: 5 }));
    for (const s of ["مقاعد مشمولة في الخطة", "25 ريال شهرياً", "631.35 ريال"]) expect(ar, s).toContain(s);
  });
});

describe("concurrent invites cannot oversell (rule 3373)", () => {
  it("two invites at once on a full team, one confirmed: exactly one invite and one seat", async () => {
    const u = await owner("starter");
    const [a, b] = await Promise.all([inviteOne(u, { addSeat: true }), inviteOne(u)]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect((await stored(u)).extraSeats).toBe(1);
    expect(await listInvites(acct(u))).toHaveLength(1);
  });
  it("several confirmed invites at once: the seats bought equal the seats used above the plan, never more", async () => {
    const u = await owner("starter");
    const rs = await Promise.all([inviteOne(u, { addSeat: true }), inviteOne(u, { addSeat: true }), inviteOne(u, { addSeat: true })]);
    const ok = rs.filter((r) => r.ok).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    const after = await stored(u);
    const used = 1 + (await listInvites(acct(u))).length;
    expect(paidExtraSeats(after)).toBe(ok);
    expect(paidExtraSeats(after)).toBe(billableExtraSeats(used, includedSeats(after)));
  });
});

describe("leaving and renewal (rules 3370-3372)", () => {
  it("a cancelled invite or a removed member keeps the seat until the renewal settles it", async () => {
    const u = await owner("starter");
    const r1 = await inviteOne(u, { addSeat: true });
    const r2 = await inviteOne(await me(u.email), { addSeat: true });
    expect(r1.ok && r2.ok).toBe(true);
    expect((await stored(u)).extraSeats).toBe(2);
    const fresh = await me(u.email);
    expect(await cancelInvite(fresh, fresh.actor!, (r1 as { id: string }).id)).toEqual({ ok: true });
    // No mid-period change: the seat stays paid for this month.
    expect((await stored(u)).extraSeats).toBe(2);
    expect(await settleExtraSeats(acct(u))).toBe(1);
    expect((await stored(u)).extraSeats).toBe(1);
    // A member who joined on a paid seat and was removed: the next settle drops it to 0 and the field goes.
    const m = await newMember(await stored(u), "member");
    const again = await me(u.email);
    expect(await cancelInvite(again, again.actor!, (r2 as { id: string }).id)).toEqual({ ok: true });
    expect(await removeMember(again, again.actor!, m.email)).toEqual({ ok: true });
    expect(await settleExtraSeats(acct(u))).toBe(0);
    expect("extraSeats" in (await stored(u))).toBe(false);
  });
  it("settle never raises the count, and an old record writes nothing", async () => {
    const u = await owner("pro");
    expect(await settleExtraSeats(acct(u))).toBe(0);
    expect("extraSeats" in (await stored(u))).toBe(false);
  });
  async function subscribedStarter(): Promise<User> {
    const billing: Billing = { provider: "paymob", plan: "starter", status: "active", paidThrough: ksaDay(), anchor: Number(ksaDay().slice(8, 10)), autoRenew: true, failures: 0, txns: [], card: { brand: "MasterCard", last4: "2346" } };
    const u = await owner("starter", { phone: "+966500000123", renewedAt: monthKey(), billing });
    await db.set(cardKey(u.email), { token: "tok_" + randomBytes(16).toString("hex"), last4: "2346", brand: "MasterCard", expMonth: "01", expYear: "38", savedAt: new Date().toISOString(), orderId: 1 });
    return u;
  }
  it("the renewal charges plan + seats × 25 + VAT on the saved card", async () => {
    const u = await subscribedStarter();
    expect((await inviteOne(u, { addSeat: true })).ok).toBe(true);
    expect((await inviteOne(await me(u.email), { addSeat: true })).ok).toBe(true);
    payAmount = 40135;
    expect(await renewPaymob(u.email)).toBe("paymob_renewed");
    const intention = calls.find((c) => c.path === "/v1/intention/")!;
    expect(intention.body).toMatchObject({ amount: 40135 });
    expect((await stored(u)).extraSeats).toBe(2);
  });
  it("after a leave, the renewal trims the seat first and charges only what is still used", async () => {
    const u = await subscribedStarter();
    const r1 = await inviteOne(u, { addSeat: true });
    expect((await inviteOne(await me(u.email), { addSeat: true })).ok).toBe(true);
    const fresh = await me(u.email);
    await cancelInvite(fresh, fresh.actor!, (r1 as { id: string }).id);
    payAmount = 37260; // (29900 + 2500) × 1.15
    expect(await renewPaymob(u.email)).toBe("paymob_renewed");
    expect(calls.find((c) => c.path === "/v1/intention/")!.body).toMatchObject({ amount: 37260 });
    expect((await stored(u)).extraSeats).toBe(1);
  });
  it("an account with no seats renews at the plan price, as before", async () => {
    const u = await subscribedStarter();
    payAmount = 34385;
    expect(await renewPaymob(u.email)).toBe("paymob_renewed");
    expect(calls.find((c) => c.path === "/v1/intention/")!.body).toMatchObject({ amount: 34385 });
  });
});

describe("tenant scope (rule 3374)", () => {
  it("a seat bought on one account never touches another, and settling one leaves the other alone", async () => {
    const a = await owner("starter");
    const b = await owner("starter");
    expect((await inviteOne(await me(a.email), { addSeat: true })).ok).toBe(true);
    expect((await stored(a)).extraSeats).toBe(1);
    expect((await stored(b)).extraSeats).toBeUndefined();
    await saveUser({ ...(await stored(b)), extraSeats: 1 });
    expect(await settleExtraSeats(acct(a))).toBe(1);
    expect((await stored(b)).extraSeats).toBe(1);
  });
});

describe("the route (rules 3366, 3369)", () => {
  it("POST /api/team/invite answers 409 with the confirm data, then adds the seat with addSeat:true", async () => {
    const u = await owner("starter");
    const to = freshEmail();
    const first = await invite.POST(json("/api/team/invite", "POST", { email: to, role: "member", lang: "en" }, ip()));
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: "seats", used: 1, limit: 1, included: 1, extra: 0, unitSar: 25, canBuy: true });
    // A truthy value that is not `true` is not a confirm.
    const sloppy = await invite.POST(json("/api/team/invite", "POST", { email: to, role: "member", lang: "en", addSeat: "true" }, ip()));
    expect(sloppy.status).toBe(409);
    const ok = await invite.POST(json("/api/team/invite", "POST", { email: to, role: "member", lang: "en", addSeat: true }, ip()));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, seatAdded: true });
    expect((await stored(u)).extraSeats).toBe(1);
    expect(sent).toContain(to);
  });
});
