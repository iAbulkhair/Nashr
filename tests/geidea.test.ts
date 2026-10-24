import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, randomUUID } from "crypto";
import { readFileSync } from "fs";
import { jar, json, newUser, signIn } from "./helpers/session";
import { acct, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { ksaDay } from "@/lib/partner-rules";
import type { Payment } from "@/lib/partners";
import {
  GEIDEA_API, GEIDEA_HPP, callbackSignText, geideaConfig, geideaTimestamp, parseOrder, sessionBody, sessionSignText, signGeidea, toHalalas, toRiyals, verifyCallback,
} from "@/lib/geidea";
import { activeProvider, paymentProvider } from "@/lib/payments";
import { lastCheckout, paymentIdFor, reconcileOpenCheckouts, refundPaymobPayment, renewPaymob, setRenewal, type PayIntent } from "@/lib/billing";
import { wipeAccount } from "@/lib/account";
import { INTEGRATIONS } from "@/lib/integration-status";
import { LEGAL } from "@/lib/legal";
import { HELP } from "@/lib/help";
import * as checkout from "@/app/api/billing/checkout/route";
import * as webhook from "@/app/api/billing/geidea/webhook/route";
import * as paymobHook from "@/app/api/billing/paymob/webhook/route";

/**
 * Geidea KSA billing (spec docs/superpowers/specs/2026-10-18-geidea-payment-provider-design.md, rules 3900-3917 in
 * docs/system/tests/3900-geidea.md). Geidea is faked at `fetch` on its one host: the session, the saved-card pay call,
 * the refund and the order lookup answer in the shapes the spec takes from Geidea's guide; callbacks are signed with the
 * test API password exactly as the spec says Geidea signs them. Every shape marked UNVERIFIED there is still to be
 * proven against Geidea's test environment.
 */

const ENV = { GEIDEA_PUBLIC_KEY: "pk-test-fake-geidea-public", GEIDEA_API_PASSWORD: "fake-geidea-api-password-for-tests" };
const PAYMOB_VARS = ["PAYMOB_SECRET_KEY", "PAYMOB_PUBLIC_KEY", "PAYMOB_HMAC_SECRET", "PAYMOB_INTEGRATION_ID_CARD", "PAYMOB_INTEGRATION_ID_MOTO", "PAYMOB_LIVE"];
const on = (extra: Record<string, string> = {}) => {
  for (const k of PAYMOB_VARS) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries({ ...ENV, GEIDEA_LIVE: "", GEIDEA_MIT: "", ...extra })) vi.stubEnv(k, v);
};

type Session = { id: string; body: Record<string, unknown>; auth: string | null };
type Fake = {
  sessions: Session[]; paths: string[]; refunds: Record<string, unknown>[];
  pay: (s: Session) => { status: number; body: unknown }; refundStatus: number; orders: Map<string, unknown>;
};
let fake: Fake;
function installFake() {
  fake = { sessions: [], paths: [], refunds: [], pay: () => ({ status: 500, body: {} }), refundStatus: 200, orders: new Map() };
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== GEIDEA_API) throw new Error(`unexpected fetch ${u.origin}`);
    fake.paths.push(u.pathname);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    if (u.pathname === "/payment-intent/api/v2/direct/session") {
      const s = { id: `sess-${randomUUID()}`, body, auth };
      fake.sessions.push(s);
      return Response.json({ responseCode: "000", detailedResponseCode: "000", session: { id: s.id } });
    }
    if (u.pathname === "/pgw/api/v2/direct/pay/token") {
      const s = fake.sessions.find((x) => x.id === body.sessionId)!;
      const r = fake.pay(s);
      return Response.json(r.body, { status: r.status });
    }
    if (u.pathname === "/pgw/api/v2/direct/refund") {
      fake.refunds.push(body);
      return Response.json({ responseCode: fake.refundStatus === 200 ? "000" : "999" }, { status: fake.refundStatus });
    }
    if (u.pathname === "/pgw/api/v1/direct/order") {
      const o = fake.orders.get(String(u.searchParams.get("MerchantReferenceId")));
      return o ? Response.json({ responseCode: "000", order: o }) : Response.json({}, { status: 404 });
    }
    return Response.json({}, { status: 404 });
  });
}

beforeEach(() => { on(); installFake(); jar().clear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const today = () => ksaDay();
/** An order as the spec reads Geidea's callback and answers (G7, G8): paid unless told otherwise. */
function order(o: { ref: string; amount: unknown; orderId?: string; status?: string; detailed?: string; codes?: [string, string]; isTest?: boolean; agreementId?: string | null; tokenId?: string | null; refunded?: number }) {
  const [rc, dc] = o.codes ?? ["000", "000"];
  return {
    orderId: o.orderId ?? randomUUID(), amount: o.amount, currency: "SAR", status: o.status ?? "Success", detailedStatus: o.detailed ?? "Paid",
    merchantReferenceId: o.ref, isTest: o.isTest ?? true, totalRefundedAmount: o.refunded ?? 0,
    ...(o.tokenId === null ? {} : { tokenId: o.tokenId ?? randomUUID() }),
    ...(o.agreementId === null || o.agreementId === undefined ? {} : { agreementId: o.agreementId }),
    paymentMethod: { maskedCardNumber: "512345******2346", brand: "Mastercard", expiryDate: { month: 1, year: 38 } },
    transactions: [{ type: "Pay", codes: { responseCode: rc, detailedResponseCode: dc } }],
  };
}
const envelope = (ord: Record<string, unknown>, password = ENV.GEIDEA_API_PASSWORD) => {
  const timeStamp = geideaTimestamp();
  return { order: ord, timeStamp, signature: signGeidea(callbackSignText(ENV.GEIDEA_PUBLIC_KEY, ord, timeStamp)!, password) };
};
let ipSeq = 0;
const ip = () => ({ "x-forwarded-for": `10.39.${++ipSeq % 250}.${(ipSeq * 7) % 250}` });
const hook = (body: unknown) => webhook.POST(json("/api/billing/geidea/webhook", "POST", body, ip()));
const result = async (r: Response) => ((await r.json()) as { result?: string }).result;
const pay = (body: Record<string, unknown>) => checkout.POST(json("/api/billing/checkout", "POST", body));
const payments = async (u: User) => Object.values(await db.hgetall<Payment>(`payments:${acct(u)}`));
const logRows = async (u: User, what: string) => (await db.lrange("admin:log", 0, 200)).map(String).filter((l) => l.includes(acct(u)) && l.includes(what));

async function owner(prefix = "gd"): Promise<User> {
  const u = await newUser(prefix);
  await signIn(u.email);
  return (await getUser(u.email))!;
}
/** A checkout through the route; answers the session Geidea saw. */
async function started(body: Record<string, unknown> = { kind: "plan", plan: "starter" }) {
  const res = await pay(body);
  expect(res.status).toBe(200);
  const s = fake.sessions.at(-1)!;
  return { s, ref: String(s.body.merchantReferenceId), amount: s.body.amount, agreementId: (s.body.cofAgreement as { id?: string } | undefined)?.id };
}
/** A paid starter plan with its saved card, through the real checkout and callback. */
async function subscribed(extra: Record<string, string> = {}) {
  on(extra);
  const u = await owner("gdsub");
  const st = await started();
  const ord = order({ ref: st.ref, amount: st.amount, agreementId: st.agreementId });
  expect(await result(await hook(envelope(ord)))).toBe("paid");
  return { u: (await getUser(u.email))!, st, ord };
}

describe("rule 3900: the gate, the live guard and the choice of provider", () => {
  it("off without both variables: checkout and the callback answer 404, nothing reaches Geidea", async () => {
    vi.stubEnv("GEIDEA_API_PASSWORD", "");
    const u = await owner();
    expect(geideaConfig()).toBeNull();
    expect(paymentProvider()).toBeNull();
    expect((await pay({ kind: "plan", plan: "starter" })).status).toBe(404);
    expect((await hook(envelope(order({ ref: randomUUID(), amount: 1 })))).status).toBe(404);
    expect(fake.paths).toHaveLength(0);
    expect((await getUser(u.email))!.plan).toBe("trial");
  });
  it("GEIDEA_LIVE=1 is honoured only on the production deploy, never on staging; refused, the gate closes", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(geideaConfig()).toMatchObject({ live: false, mit: false });
    vi.stubEnv("GEIDEA_LIVE", "1");
    expect(geideaConfig()).toBeNull();
    vi.stubEnv("APP_ENV", "staging");
    expect(geideaConfig()).toBeNull();
    vi.stubEnv("APP_ENV", "production");
    expect(geideaConfig()).toMatchObject({ live: true });
    vi.stubEnv("GEIDEA_MIT", "1");
    expect(geideaConfig()).toMatchObject({ mit: true });
    err.mockRestore();
  });
  it("a value that cannot be a Basic-auth pair keeps the gate closed", () => {
    vi.stubEnv("GEIDEA_PUBLIC_KEY", "has:colon-in-it");
    expect(geideaConfig()).toBeNull();
    vi.stubEnv("GEIDEA_PUBLIC_KEY", "short");
    expect(geideaConfig()).toBeNull();
  });
  it("with Geidea and Paymob both configured Geidea is chosen; without Geidea, Paymob exactly as before", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [k, v] of Object.entries({ PAYMOB_SECRET_KEY: "sk_test_x", PAYMOB_PUBLIC_KEY: "pk_test_x", PAYMOB_HMAC_SECRET: "hmac-x", PAYMOB_INTEGRATION_ID_CARD: "111111" })) vi.stubEnv(k, v);
    expect(activeProvider()).toBe("geidea");
    vi.stubEnv("GEIDEA_PUBLIC_KEY", "");
    expect(activeProvider()).toBe("paymob");
    err.mockRestore();
    const src = readFileSync("src/lib/payments/index.ts", "utf8");
    expect(src).toContain('log.error("payment_provider_both_set');
  });
  it("with Geidea chosen the Paymob callback answers 404", async () => {
    const r = await paymobHook.POST(json("/api/billing/paymob/webhook?hmac=" + "a".repeat(128), "POST", { type: "TRANSACTION", obj: {} }, ip()));
    expect(r.status).toBe(404);
  });
});

describe("rule 3901: money is halalas in our code and riyals with 2 decimals on the wire", () => {
  it("converts exactly, both ways", () => {
    expect(toRiyals(34385)).toBe("343.85");
    expect(toRiyals(5)).toBe("0.05");
    expect(toRiyals(0)).toBe("0.00");
    expect(toHalalas("343.85")).toBe(34385);
    expect(toHalalas(343.85)).toBe(34385);
    expect(toHalalas(343.8)).toBe(34380);
    expect(toHalalas("12")).toBe(1200);
  });
  it("refuses anything that is not a plain amount", () => {
    for (const bad of ["1.234", "-1", -1, "1e3", 1e21, NaN, Infinity, "", null, undefined, {}, "12,5"]) expect(toHalalas(bad), String(bad)).toBeNull();
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) expect(() => toRiyals(bad)).toThrow();
  });
});

describe("rule 3902: the session we create, and its signature", () => {
  it("a plan: our price, our reference, a new agreement, no phone, no wallets, our return and callback addresses", async () => {
    await owner();
    const res = await pay({ kind: "plan", plan: "starter" });
    expect(res.status).toBe(200);
    const s = fake.sessions.at(-1)!;
    const { url } = (await res.json()) as { url: string };
    expect(url).toBe(`${GEIDEA_HPP}?${s.id}`);
    expect(s.body).toMatchObject({ amount: 343.85, currency: "SAR", paymentOperation: "Pay", hideWallets: true, initiatedBy: "Internet", cardOnFile: true });
    expect(String(s.body.merchantReferenceId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((s.body.cofAgreement as { id: string; type: string }).type).toBe("Unscheduled");
    expect(JSON.stringify(s.body.customer)).not.toMatch(/phone/i);
    expect(String(s.body.callbackUrl)).toMatch(/\/api\/billing\/geidea\/webhook$/);
    expect(String(s.body.returnUrl)).toContain("/billing?pay=return");
    expect(s.auth).toBe(`Basic ${Buffer.from(`${ENV.GEIDEA_PUBLIC_KEY}:${ENV.GEIDEA_API_PASSWORD}`).toString("base64")}`);
    const text = `${ENV.GEIDEA_PUBLIC_KEY}343.85SAR${s.body.merchantReferenceId}${s.body.timestamp}`;
    expect(s.body.signature).toBe(createHmac("sha256", ENV.GEIDEA_API_PASSWORD).update(text).digest("base64"));
    // The intent is ours, stored before the call, and waits in the reconciliation set.
    const intent = (await db.get<PayIntent>(globalKey.payIntent(String(s.body.merchantReferenceId))))!;
    expect(intent).toMatchObject({ provider: "geidea", status: "open", amountCents: 34385, agreementId: (s.body.cofAgreement as { id: string }).id });
    const open = await db.zrangeByScore(globalKey.payOpen(), Date.now() + 1000, 1000);
    expect(open.map((r) => r.member)).toContain(intent.ref);
  });
  it("a pack saves no card: no agreement and no card on file", () => {
    const cfg = geideaConfig()!;
    const b = sessionBody(cfg, { amountCents: 1000, item: { name: "x", description: "x" }, billing: { firstName: "a", lastName: "b", email: "a@b.co", phone: "" }, reference: randomUUID(), notificationUrl: "https://x/a", redirectionUrl: "https://x/b", expirationS: 3600 }, "2026/10/24 10:00:00");
    expect(b).not.toHaveProperty("cofAgreement");
    expect(b).not.toHaveProperty("cardOnFile");
    expect(b.signature).toBe(signGeidea(sessionSignText(cfg.publicKey, 1000, "SAR", String(b.merchantReferenceId), "2026/10/24 10:00:00"), cfg.apiPassword));
  });
  it("Geidea refusing the session fails the intent and answers provider_error (502)", async () => {
    await owner();
    vi.stubGlobal("fetch", async () => Response.json({ responseCode: "999", detailedResponseCode: "999.1" }));
    const res = await pay({ kind: "plan", plan: "starter" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "provider_error" });
  });
});

describe("rule 3903: the callback signature is checked first, in constant time", () => {
  const ord = order({ ref: randomUUID(), amount: "343.85" });
  it("only our HMAC over the documented fields verifies", () => {
    const e = envelope(ord);
    expect(verifyCallback(e, ENV.GEIDEA_PUBLIC_KEY, ENV.GEIDEA_API_PASSWORD)).toBe(true);
    expect(verifyCallback(envelope(ord, "another-password"), ENV.GEIDEA_PUBLIC_KEY, ENV.GEIDEA_API_PASSWORD)).toBe(false);
    expect(verifyCallback({ ...e, order: { ...ord, amount: "1.00" } }, ENV.GEIDEA_PUBLIC_KEY, ENV.GEIDEA_API_PASSWORD)).toBe(false);
    expect(verifyCallback({ ...e, order: { ...ord, merchantReferenceId: randomUUID() } }, ENV.GEIDEA_PUBLIC_KEY, ENV.GEIDEA_API_PASSWORD)).toBe(false);
    expect(verifyCallback({ ...e, timeStamp: "2020/01/01 00:00:00" }, ENV.GEIDEA_PUBLIC_KEY, ENV.GEIDEA_API_PASSWORD)).toBe(false);
    for (const bad of [null, "", e.signature.slice(0, 40), "z".repeat(44), 42]) expect(verifyCallback({ ...e, signature: bad }, ENV.GEIDEA_PUBLIC_KEY, ENV.GEIDEA_API_PASSWORD), String(bad)).toBe(false);
  });
  it("a bad signature is 401 and changes nothing", async () => {
    const u = await owner();
    const st = await started();
    const r = await hook(envelope(order({ ref: st.ref, amount: st.amount, agreementId: st.agreementId }), "wrong-password-123"));
    expect(r.status).toBe(401);
    expect((await getUser(u.email))!.plan).toBe("trial");
  });
  it("the comparison is sameSecret, never ===", () => {
    const src = readFileSync("src/lib/geidea.ts", "utf8");
    const verify = src.slice(src.indexOf("export function verifyCallback"), src.indexOf("// ---- HTTP"));
    expect(verify).toContain("sameSecret(signGeidea(text, apiPassword), body.signature)");
    expect(verify).not.toMatch(/===\s*body\.signature|body\.signature\s*===/);
  });
});

describe("rule 3904: an order is paid only on Success, Paid and the 000 codes", () => {
  const ref = randomUUID();
  it("paid, with the card it saved", () => {
    const t = parseOrder(order({ ref, amount: 343.85, agreementId: randomUUID() }))!;
    expect(t).toMatchObject({ success: true, amountCents: 34385, ref, currency: "SAR", isLive: false, pending: false, isRefunded: false });
    expect(t.card).toMatchObject({ last4: "2346", brand: "Mastercard", expMonth: "01", expYear: "38" });
  });
  it("000.004 is paid without a saved card", () => {
    const t = parseOrder(order({ ref, amount: 1, codes: ["000", "000.004"] }))!;
    expect(t.success).toBe(true);
    expect(t.card).toBeUndefined();
  });
  it("anything else is not paid", () => {
    expect(parseOrder(order({ ref, amount: 1, status: "Failed", detailed: "Failed" }))!.success).toBe(false);
    expect(parseOrder(order({ ref, amount: 1, detailed: "Cancelled By User" }))!.success).toBe(false);
    expect(parseOrder(order({ ref, amount: 1, codes: ["000", "210"] }))!.success).toBe(false);
    expect(parseOrder(order({ ref, amount: 1, status: "InProgress", detailed: "Initiated" }))!).toMatchObject({ success: false, pending: true });
    expect(parseOrder({ ...order({ ref, amount: 1 }), responseCode: "999" })!.success).toBe(false);
  });
  it("refunded, live, and shapes that are not an order", () => {
    expect(parseOrder(order({ ref, amount: 1, refunded: 1 }))!.isRefunded).toBe(true);
    const { isTest: _drop, ...noFlag } = order({ ref, amount: 1 });
    expect(parseOrder(noFlag)!.isLive).toBe(true);
    expect(parseOrder({ ...order({ ref, amount: 1 }), orderId: "12345" })).toBeNull();
    expect(parseOrder(order({ ref, amount: "1.234" }))).toBeNull();
    expect(parseOrder(null)).toBeNull();
  });
});

describe("rule 3905: the callback route, in order: provider, rate, size, JSON, signature", () => {
  it("413 for a large body, 400 for bad JSON or a body that is not a callback", async () => {
    expect((await webhook.POST(new Request("http://localhost/api/billing/geidea/webhook", { method: "POST", body: "x".repeat(70 * 1024), headers: ip() }))).status).toBe(413);
    expect((await webhook.POST(new Request("http://localhost/api/billing/geidea/webhook", { method: "POST", body: "{nope", headers: ip() }))).status).toBe(400);
    expect((await hook({ order: "x" })).status).toBe(400);
  });
  it("the source checks the provider, then the per-IP limit, then the size, before the signature", () => {
    const src = readFileSync("src/app/api/billing/geidea/webhook/route.ts", "utf8");
    const at = (s: string) => src.indexOf(s);
    expect(at('activeProvider() !== "geidea"')).toBeGreaterThan(0);
    expect(at('allow("geideahook:" + clientIp(req), HOOK_PER_IP.max, HOOK_PER_IP.windowS)')).toBeGreaterThan(at('activeProvider() !== "geidea"'));
    expect(at("readCapped(req, MAX_BODY_BYTES)")).toBeGreaterThan(at('allow("geideahook:"'));
    expect(at("handleGeideaCallback(body)")).toBeGreaterThan(at("readCapped(req, MAX_BODY_BYTES)"));
    expect(src).toContain("const HOOK_PER_IP = { max: 240, windowS: 60 };");
    expect(src).not.toMatch(/cookies\(|currentUser\(/);
  });
});

describe("rule 3906: a paid order is applied exactly once and saves its card", () => {
  it("the plan, one payment, the card and renewal on; a retry answers already", async () => {
    const { u, ord } = await subscribed();
    expect(u.plan).toBe("starter");
    expect(u.billing).toMatchObject({ provider: "geidea", plan: "starter", status: "active", autoRenew: true, card: { last4: "2346" }, txns: [ord.orderId] });
    expect(await result(await hook(envelope(ord)))).toBe("already");
    const paid = await payments(u);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ id: paymentIdFor(ord.orderId, "geidea"), reference: `geidea:${ord.orderId}` });
    const card = await db.get<{ token: string; agreementId: string; provider: string }>(`pay:card:${acct(u)}`);
    expect(card).toMatchObject({ token: ord.tokenId, agreementId: ord.agreementId, provider: "geidea" });
    expect(await db.get(`paymob:card:${acct(u)}`)).toBeNull();
    expect(await db.get(globalKey.payDone("geidea", ord.orderId))).toBe("paid");
    expect(JSON.stringify(await db.lrange("admin:log", 0, 200))).not.toContain(String(ord.tokenId));
  });
});

describe("rule 3907: what does not match our intent is never applied", () => {
  const cases: [string, (st: Awaited<ReturnType<typeof started>>) => Record<string, unknown>][] = [
    ["a lower amount", (st) => order({ ref: st.ref, amount: 1, agreementId: st.agreementId })],
    ["a live order on test keys", (st) => order({ ref: st.ref, amount: st.amount, agreementId: st.agreementId, isTest: false })],
    ["another agreement", (st) => order({ ref: st.ref, amount: st.amount, agreementId: randomUUID() })],
    ["another currency", (st) => ({ ...order({ ref: st.ref, amount: st.amount, agreementId: st.agreementId }), currency: "USD" })],
  ];
  for (const [name, make] of cases) {
    it(`${name}: mismatch, logged, the plan unchanged`, async () => {
      const u = await owner();
      const st = await started();
      expect(await result(await hook(envelope(make(st))))).toBe("mismatch");
      expect((await getUser(u.email))!.plan).toBe("trial");
      expect(await db.get<PayIntent>(globalKey.payIntent(st.ref))).toMatchObject({ status: "mismatch" });
      expect(await logRows(u, "geidea_mismatch")).not.toHaveLength(0);
    });
  }
  it("a reference that is not ours, or a Paymob one, is ignored", async () => {
    expect(await result(await hook(envelope(order({ ref: randomUUID(), amount: 1 }))))).toBe("ignored");
    expect(await result(await hook(envelope(order({ ref: "pmi_" + "a".repeat(24), amount: 1 }))))).toBe("ignored");
  });
  it("a second paid order for a paid checkout is not applied twice: logged for the founder, the intent stays paid", async () => {
    const { u, st } = await subscribed();
    const second = order({ ref: st.ref, amount: st.amount, agreementId: st.agreementId });
    expect(await result(await hook(envelope(second)))).toBe("mismatch");
    expect(await payments(u)).toHaveLength(1);
    expect(await db.get<PayIntent>(globalKey.payIntent(st.ref))).toMatchObject({ status: "paid" });
    expect(await logRows(u, "geidea_second_order")).not.toHaveLength(0);
  });
});

describe("rule 3908: a credit pack", () => {
  it("adds its credits once and saves no card", async () => {
    const { u } = await subscribed();
    await signIn(u.email);
    const before = (await getUser(u.email))!;
    const st = await started({ kind: "topup", credits: 300 });
    expect(st.agreementId).toBeUndefined();
    const ord = order({ ref: st.ref, amount: st.amount, tokenId: null });
    expect(await result(await hook(envelope(ord)))).toBe("paid");
    expect(await result(await hook(envelope(ord)))).toBe("already");
    const after = (await getUser(u.email))!;
    expect(await payments(after)).toHaveLength(2);
    expect(after.plan).toBe(before.plan);
  });
});

describe("rule 3909: open checkouts are asked of Geidea (the callback has no published retry)", () => {
  it("the daily sweep applies an order Geidea holds for a checkout whose callback never came", async () => {
    const u = await owner();
    const st = await started();
    const old = Date.now() - 30 * 60_000;
    const intent = (await db.get<PayIntent>(globalKey.payIntent(st.ref)))!;
    await Promise.all([db.set(globalKey.payIntent(st.ref), { ...intent, createdAt: new Date(old).toISOString() }), db.zadd(globalKey.payOpen(), old, st.ref)]);
    fake.orders.set(st.ref, order({ ref: st.ref, amount: st.amount, agreementId: st.agreementId }));
    const r = await reconcileOpenCheckouts();
    expect(r.checked).toBeGreaterThan(0);
    expect((await getUser(u.email))!.plan).toBe("starter");
    const left = await db.zrangeByScore(globalKey.payOpen(), Date.now() + 1000, 1000);
    expect(left.map((x) => x.member)).not.toContain(st.ref);
  });
  it("references older than two days leave the set without a call", async () => {
    const ref = randomUUID();
    await db.zadd(globalKey.payOpen(), Date.now() - 3 * 86400_000, ref);
    await reconcileOpenCheckouts();
    const left = await db.zrangeByScore(globalKey.payOpen(), Date.now() + 1000, 1000);
    expect(left.map((x) => x.member)).not.toContain(ref);
    expect(fake.paths.filter((p) => p === "/pgw/api/v1/direct/order")).toHaveLength(0);
  });
  it("the return page asks Geidea about a checkout a minute old, at most once per 20 s", async () => {
    const u = await owner();
    const st = await started();
    const intent = (await db.get<PayIntent>(globalKey.payIntent(st.ref)))!;
    await db.set(globalKey.payIntent(st.ref), { ...intent, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });
    expect((await lastCheckout(acct(u))).state).toBe("pending");
    fake.orders.set(st.ref, order({ ref: st.ref, amount: st.amount, agreementId: st.agreementId }));
    expect((await lastCheckout(acct(u))).state).toBe("pending");
    expect(fake.paths.filter((p) => p === "/pgw/api/v1/direct/order")).toHaveLength(1);
  });
  it("nothing while Geidea is not the chosen provider", async () => {
    vi.stubEnv("GEIDEA_PUBLIC_KEY", "");
    expect(await reconcileOpenCheckouts()).toEqual({ checked: 0, dropped: 0 });
  });
});

describe("rule 3910: saved-card renewals (MIT) only with GEIDEA_MIT=1, only on the card Geidea saved", () => {
  const due = async (u: User) => saveUser({ ...(await getUser(u.email))!, billing: { ...(await getUser(u.email))!.billing!, paidThrough: today() } });
  it("renews through a Merchant session and pay/token, under the saved agreement", async () => {
    const { u, ord } = await subscribed({ GEIDEA_MIT: "1" });
    await due(u);
    fake.pay = (s) => ({ status: 200, body: { responseCode: "000", order: order({ ref: String(s.body.merchantReferenceId), amount: s.body.amount, agreementId: String(ord.agreementId) }) } });
    expect(await renewPaymob(acct(u))).toBe("geidea_renewed");
    const s = fake.sessions.at(-1)!;
    expect(s.body).toMatchObject({ initiatedBy: "Merchant", cardOnFile: true, tokenId: ord.tokenId, agreementId: ord.agreementId });
    expect((await getUser(u.email))!.billing).toMatchObject({ status: "active" });
    expect(await payments(u)).toHaveLength(2);
  });
  it("without GEIDEA_MIT the due month goes past due for the owner to pay; nothing is charged", async () => {
    const { u } = await subscribed();
    await due(u);
    expect(await renewPaymob(acct(u))).toBe("geidea_due");
    expect(fake.paths).not.toContain("/pgw/api/v2/direct/pay/token");
    expect((await getUser(u.email))!.billing).toMatchObject({ status: "past_due" });
  });
  it("a Paymob subscription is never charged by Geidea", async () => {
    const { u } = await subscribed({ GEIDEA_MIT: "1" });
    await saveUser({ ...(await getUser(u.email))!, billing: { ...(await getUser(u.email))!.billing!, provider: "paymob", paidThrough: today() } });
    expect(await renewPaymob(acct(u))).toBe("geidea_due");
    expect(fake.paths).not.toContain("/pgw/api/v2/direct/pay/token");
  });
});

describe("rule 3911: declines", () => {
  it("750.005 (agreement mismatch) is a decline: the card goes and renewal turns off", async () => {
    const { u } = await subscribed({ GEIDEA_MIT: "1" });
    await saveUser({ ...(await getUser(u.email))!, billing: { ...(await getUser(u.email))!.billing!, paidThrough: today() } });
    fake.pay = () => ({ status: 400, body: { responseCode: "999", detailedResponseCode: "750.005" } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await renewPaymob(acct(u))).toBe("geidea_declined");
    err.mockRestore();
    const after = (await getUser(u.email))!;
    expect(after.billing).toMatchObject({ status: "past_due", autoRenew: false });
    expect(after.billing!.card).toBeUndefined();
    expect(await db.get(`pay:card:${acct(u)}`)).toBeNull();
  });
  it("a declined attempt marks nothing done: a later paid attempt in the same order still pays", async () => {
    const u = await owner();
    const st = await started();
    const orderId = randomUUID();
    const failed = order({ ref: st.ref, amount: st.amount, agreementId: st.agreementId, orderId, status: "Failed", detailed: "Failed", codes: ["999", "210"] });
    expect(await result(await hook(envelope(failed)))).toBe("declined");
    expect(await db.get<PayIntent>(globalKey.payIntent(st.ref))).toMatchObject({ status: "failed" });
    expect(await db.get(globalKey.payDone("geidea", orderId))).toBeNull();
    expect(await result(await hook(envelope(order({ ref: st.ref, amount: st.amount, agreementId: st.agreementId, orderId }))))).toBe("paid");
    expect((await getUser(u.email))!.plan).toBe("starter");
  });
});

describe("rule 3912: the founder's refund", () => {
  it("refunds the whole order at Geidea, ends the plan and deletes the card; its own callback is not logged as external", async () => {
    const { u, ord } = await subscribed();
    const id = paymentIdFor(ord.orderId, "geidea");
    const r = await refundPaymobPayment(acct(u), id, "founder@thakeen.test", "test");
    expect(r).toMatchObject({ ok: true, alreadyRefunded: false, planEnded: true });
    expect(fake.refunds.at(-1)).toMatchObject({ orderId: ord.orderId, refundAmount: 343.85 });
    expect(await db.get(`pay:card:${acct(u)}`)).toBeNull();
    expect(await refundPaymobPayment(acct(u), id, "founder@thakeen.test", "test")).toMatchObject({ ok: true, alreadyRefunded: true });
    expect(fake.refunds).toHaveLength(1);
    expect(await result(await hook(envelope({ ...ord, detailedStatus: "Refunded", totalRefundedAmount: ord.amount })))).toBe("ignored");
    expect(await logRows(u, "geidea_external_refund")).toHaveLength(0);
  });
  it("Geidea refusing the refund records nothing", async () => {
    const { u, ord } = await subscribed();
    fake.refundStatus = 400;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await refundPaymobPayment(acct(u), paymentIdFor(ord.orderId, "geidea"), "founder@thakeen.test", "")).toEqual({ ok: false, error: "paymob_refund_failed" });
    err.mockRestore();
    expect((await getUser(u.email))!.plan).toBe("starter");
  });
});

describe("rule 3913: a refund made in Geidea's dashboard", () => {
  it("is logged for the founder and changes nothing on the account", async () => {
    const { u, ord } = await subscribed();
    expect(await result(await hook(envelope({ ...ord, detailedStatus: "Refunded", totalRefundedAmount: ord.amount })))).toBe("ignored");
    expect(await logRows(u, "geidea_external_refund")).not.toHaveLength(0);
    expect((await getUser(u.email))!.plan).toBe("starter");
  });
});

describe("rule 3914: the Geidea card goes with the account and with remove_card", () => {
  it("remove_card deletes it and turns renewal off", async () => {
    const { u } = await subscribed();
    expect(await setRenewal(acct(u), "remove_card")).toMatchObject({ ok: true });
    expect(await db.get(`pay:card:${acct(u)}`)).toBeNull();
    expect((await getUser(u.email))!.billing).toMatchObject({ autoRenew: false });
  });
  it("deleting the account deletes the card and the latest checkout pointer", async () => {
    const { u } = await subscribed();
    await wipeAccount(acct(u));
    expect(await db.get(`pay:card:${acct(u)}`)).toBeNull();
    expect(await db.get(`pay:last:${acct(u)}`)).toBeNull();
  });
});

describe("rule 3915: Paymob's stored values do not change", () => {
  it("a Paymob payment id hashes exactly as before", () => {
    const golden = `pay_${createHash("sha256").update("paymob:12345").digest("hex").slice(0, 24)}`;
    expect(paymentIdFor(12345)).toBe(golden);
    expect(paymentIdFor(12345, "paymob")).toBe(golden);
    expect(paymentIdFor("12345", "geidea")).not.toBe(golden);
  });
});

describe("rule 3916: the new key families", () => {
  it("live under pay:, keyed by provider and id", () => {
    const id = randomUUID();
    expect(globalKey.payIntent(id)).toBe(`pay:intent:${id}`);
    expect(globalKey.payDone("geidea", id)).toBe(`pay:done:geidea:${id}`);
    expect(globalKey.payOpen()).toBe("pay:open");
  });
});

describe("rule 3917: the console's integration row and the variable names", () => {
  it("needs the public key and the API password; the live and MIT switches are optional", () => {
    const row = INTEGRATIONS.find((r) => r.id === "geidea")!;
    expect(row.optional).toEqual(["GEIDEA_MIT", "GEIDEA_LIVE"]);
    expect(JSON.stringify(row.need)).toContain("GEIDEA_PUBLIC_KEY");
    expect(JSON.stringify(row.need)).toContain("GEIDEA_API_PASSWORD");
    const vars = readFileSync("docs/system/variables.md", "utf8");
    for (const v of ["GEIDEA_PUBLIC_KEY", "GEIDEA_API_PASSWORD", "GEIDEA_MIT", "GEIDEA_LIVE"]) expect(vars).toContain(`\`${v}\``);
    expect(readFileSync(".env.example", "utf8")).toMatch(/^GEIDEA_API_PASSWORD=$/m);
  });
});

describe("rule 3918: the privacy policy and the help name Geidea for card payments, and only what the code sends and keeps", () => {
  const privacy = (lang: "ar" | "en") => LEGAL[lang].privacy.sections.flatMap((s) => s.p).join(" ");
  const processors = HELP.flatMap((t) => t.items).find((i) => i.slug === "processors")!.a;
  it("names Geidea before Paymob, with name, email and amount sent, the card entered on Geidea's page, and a token kept", () => {
    expect(privacy("en")).toContain("Geidea processes card payments when online payment is offered: we send it your name, email and the order amount, you enter your card details on Geidea's page, not on Thakeen, and we keep only a token that does not reveal the card number, with the card's last four digits, brand and expiry, to renew the subscription; Paymob does this instead if we switch it on.");
    expect(privacy("ar")).toContain("وGeidea لمعالجة الدفع بالبطاقة حين يُتاح الدفع الإلكتروني: نرسل إليها اسمك وبريدك وقيمة الطلب، وتُدخل بيانات بطاقتك في صفحة Geidea لا في ذكين، ونحفظ منها رمزاً لا يكشف رقم البطاقة مع آخر أربعة أرقام ونوعها وتاريخ انتهائها لتجديد الاشتراك؛ وPaymob بدلاً منها إن شغّلناها.");
    expect(processors.en).toContain("Geidea (or Paymob)");
    expect(processors.ar).toContain("Geidea (أو Paymob)");
    expect(LEGAL.en.privacy.updated).toBe("Last updated: 2026-10-24");
  });
  it("matches the code: the session sends name and email and no phone (F4)", () => {
    const src = readFileSync("src/lib/geidea.ts", "utf8");
    expect(src).toContain("customer: { email: i.billing.email, firstName: i.billing.firstName, lastName: i.billing.lastName }");
    expect(src).not.toMatch(/phoneNumber|customerPhone/);
  });
});
