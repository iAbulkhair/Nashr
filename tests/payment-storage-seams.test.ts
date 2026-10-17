import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { json, newUser, signIn, jar } from "./helpers/session";
import { mediaEnv, noNetwork, resetMediaCounters } from "./helpers/media";
import { getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import type { Payment } from "@/lib/partners";
import { PaymentError, paymentProvider, paymentsEnabled, type PaymentProvider } from "@/lib/payments";
import { PaymobError, TOKEN_HMAC_FIELDS, TXN_HMAC_FIELDS, hmacString, signHmac } from "@/lib/paymob";
import { applyTransaction } from "@/lib/billing";
import { storage } from "@/lib/media/storage";
import { MEDIA_KEYS, writeToStore, type MediaEntry } from "@/lib/media/store";
import { mediaDir, mediaOrigin } from "@/lib/media/config";
import { isOurMediaUrl } from "@/lib/media-catalog";
import { StoreError } from "@/lib/media/types";
import * as checkout from "@/app/api/billing/checkout/route";
import * as webhook from "@/app/api/billing/paymob/webhook/route";

/**
 * Wave 2c (rules 2050-2063, docs/system/tests/2050-payment-storage-seams.md, flows.md section 85): billing reaches
 * Paymob only through the PaymentProvider type, and the media store reaches the disk only through the StorageAdapter
 * type. No behaviour changed: every safety we had is pinned again here, through the new interfaces. Paymob is faked at
 * `fetch` as in tests/paymob.test.ts; the store writes to a temporary MEDIA_DIR.
 */

const read = (f: string) => readFileSync(f, "utf8");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [path.join(dir, d.name)] : []));

// ---------------------------------------------------------------- payments

const ENV = {
  PAYMOB_SECRET_KEY: "sk_test_seam_secret_for_unit_tests",
  PAYMOB_PUBLIC_KEY: "pk_test_seam_public_for_unit_tests",
  PAYMOB_HMAC_SECRET: "seam-hmac-secret-for-unit-tests",
  PAYMOB_INTEGRATION_ID_CARD: "111111",
  PAYMOB_INTEGRATION_ID_MOTO: "222222",
};
const paymobOn = () => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); vi.stubEnv("PAYMOB_LIVE", ""); };

type Call = { path: string; body: Record<string, unknown>; auth: string | null };
let calls: Call[] = [];
let intents: { orderId: number; ref: string; amount: number }[] = [];
let refundStatus = 200;
let nextOrder = 800000 + Math.floor(Math.random() * 100000);
function fakePaymob() {
  calls = [];
  intents = [];
  refundStatus = 200;
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== "https://ksa.paymob.com") throw new Error(`unexpected fetch ${u.origin}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: u.pathname, body, auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null });
    if (u.pathname === "/v1/intention/") {
      const orderId = ++nextOrder;
      intents.push({ orderId, ref: String(body.special_reference), amount: Number(body.amount) });
      return Response.json({ id: `pi_${orderId}`, client_secret: `csk_${orderId}`, intention_order_id: orderId, payment_keys: [{ key: `paykey_${orderId}` }] }, { status: 201 });
    }
    if (u.pathname === "/api/acceptance/payments/pay") return Response.json({ id: 1, amount_cents: 100, success: true, pending: false, currency: "SAR", order: { id: intents.at(-1)?.orderId } });
    if (u.pathname === "/api/acceptance/void_refund/refund") return Response.json({}, { status: refundStatus });
    return Response.json({}, { status: 404 });
  });
}

let txnSeq = 70000000 + Math.floor(Math.random() * 1000000);
function txnObj(o: { amount: number; orderId: number; ref: string; id?: number; currency?: string; live?: boolean }) {
  return {
    id: o.id ?? ++txnSeq, pending: false, amount_cents: o.amount, success: true, is_auth: false, is_capture: false, is_standalone_payment: true,
    is_voided: false, is_refunded: false, is_3d_secure: true, integration_id: 111111, has_parent_transaction: false, owner: 1053928,
    created_at: "2026-10-17T10:00:00.000000", currency: o.currency ?? "SAR", error_occured: false, is_live: o.live ?? false,
    source_data: { pan: "2346", type: "card", sub_type: "MasterCard" }, order: { id: o.orderId, merchant_order_id: o.ref },
  };
}
const sign = (obj: Record<string, unknown>, fields: readonly string[] = TXN_HMAC_FIELDS) => signHmac(hmacString(obj, fields), ENV.PAYMOB_HMAC_SECRET);
let ip = 0;
const hook = (obj: Record<string, unknown>, hmac = sign(obj)) =>
  webhook.POST(json(`/api/billing/paymob/webhook?hmac=${hmac}`, "POST", { type: "TRANSACTION", obj }, { "x-forwarded-for": `10.20.${++ip % 250}.${ip % 250}` }));
const payments = async (email: string) => Object.values(await db.hgetall<Payment>(`payments:${email}`));

async function owner(): Promise<User> {
  const u = await newUser("seam");
  await saveUser({ ...(await getUser(u.email))!, phone: "+966500000123" });
  await signIn(u.email);
  return (await getUser(u.email))!;
}
/** A checkout through the route, and the intention Paymob saw for it. */
async function started() {
  const u = await owner();
  const r = await checkout.POST(json("/api/billing/checkout", "POST", { kind: "plan", plan: "starter" }));
  expect(r.status).toBe(200);
  return { u, it: intents.at(-1)! };
}
const provider = (): PaymentProvider => {
  const p = paymentProvider();
  if (!p) throw new Error("payments off in a test that needs them");
  return p;
};

describe("payments", () => {
  beforeEach(() => { paymobOn(); fakePaymob(); jar().clear(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  describe("rule 2050: one provider type, Paymob its only implementation, chosen in one place and gated off as before", () => {
    it("paymentProvider() is null unless every required PAYMOB_* variable is set, and live keys still need PAYMOB_LIVE=1", () => {
      expect(provider()).toMatchObject({ name: "paymob", live: false });
      expect(paymentsEnabled()).toBe(true);
      for (const k of ["PAYMOB_SECRET_KEY", "PAYMOB_PUBLIC_KEY", "PAYMOB_HMAC_SECRET", "PAYMOB_INTEGRATION_ID_CARD"]) {
        paymobOn();
        vi.stubEnv(k, "");
        expect(paymentProvider(), k).toBeNull();
        expect(paymentsEnabled(), k).toBe(false);
      }
      paymobOn();
      vi.stubEnv("PAYMOB_SECRET_KEY", "sk_live_seam");
      vi.stubEnv("PAYMOB_PUBLIC_KEY", "pk_live_seam");
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(paymentProvider()).toBeNull();
      vi.stubEnv("PAYMOB_LIVE", "1");
      expect(provider().live).toBe(true);
      err.mockRestore();
    });
    it("with no PAYMOB_* set at all, every payment route still answers as off and Paymob is never called", async () => {
      for (const k of Object.keys(ENV)) vi.stubEnv(k, "");
      await owner();
      expect((await checkout.POST(json("/api/billing/checkout", "POST", { kind: "plan", plan: "starter" }))).status).toBe(404);
      expect((await hook(txnObj({ amount: 1, orderId: 1, ref: "pmi_" + "a".repeat(24) }))).status).toBe(404);
      expect(calls).toHaveLength(0);
    });
    it("nothing outside src/lib/payments and src/lib/paymob.ts imports the Paymob module or reads its gate", () => {
      const offenders = walk("src").filter((f) => !f.startsWith(path.join("src", "lib", "payments")) && f !== path.join("src", "lib", "paymob.ts"))
        .filter((f) => /from "(?:@\/lib\/|\.\.?\/)(?:\.\.\/)*paymob"|paymobConfig\(/.test(read(f)));
      expect(offenders).toEqual([]);
      expect(read("src/lib/billing.ts")).toMatch(/from "\.\/payments";/);
      expect(read("src/lib/payments/index.ts")).toMatch(/export function paymentProvider\(\): PaymentProvider \| null \{\n {2}return paymobProvider\(\);\n\}/);
    });
    it("the provider object carries no key: nothing that logs or returns it can leak a secret", () => {
      const p = provider();
      const text = JSON.stringify(p) + Object.values(p).filter((v) => typeof v === "string").join("");
      for (const v of [ENV.PAYMOB_SECRET_KEY, ENV.PAYMOB_PUBLIC_KEY, ENV.PAYMOB_HMAC_SECRET]) expect(text).not.toContain(v);
    });
  });

  describe("rule 2051: the amount is checked against our own price, not the provider's word", () => {
    it("a verified callback for another amount, currency or live flag is a mismatch and applies nothing", async () => {
      const { u, it } = await started();
      const r = await hook(txnObj({ amount: it.amount - 1, orderId: it.orderId, ref: it.ref }));
      expect(await r.json()).toMatchObject({ result: "mismatch" });
      expect((await getUser(u.email))!.plan).toBe("trial");
      expect(await payments(u.email)).toHaveLength(0);
      const p = provider();
      for (const variant of [{ currency: "EGP" }, { live: true }]) {
        const s = await started();
        const t = p.parseTransaction(txnObj({ amount: s.it.amount, orderId: s.it.orderId, ref: s.it.ref, ...variant }))!;
        expect(await applyTransaction(p, t), JSON.stringify(variant)).toEqual({ status: 200, result: "mismatch" });
        expect((await getUser(s.u.email))!.plan).toBe("trial");
        expect(await payments(s.u.email)).toHaveLength(0);
      }
    });
    it("through the interface directly: a transaction parsed by the provider with the right reference but a lower amount is refused", async () => {
      const { u, it } = await started();
      const p = provider();
      const low = p.parseTransaction(txnObj({ amount: 1, orderId: it.orderId, ref: it.ref }))!;
      expect(await applyTransaction(p, low)).toEqual({ status: 200, result: "mismatch" });
      expect(await db.get<{ status: string }>(`paymob:intent:${it.ref}`)).toMatchObject({ status: "mismatch" });
      expect((await getUser(u.email))!.plan).toBe("trial");
      expect(read("src/lib/billing.ts")).toMatch(/const expected = priceFor\(intent\.kind, intent, intent\.offer, intent\.lockedBaseHalalas\);/);
    });
  });

  describe("rule 2052: the webhook is idempotent on retry", () => {
    it("the same verified callback twice pays once; a third application through the interface answers already", async () => {
      const { u, it } = await started();
      const obj = txnObj({ amount: it.amount, orderId: it.orderId, ref: it.ref });
      expect(await (await hook(obj)).json()).toMatchObject({ result: "paid" });
      expect(await (await hook(obj)).json()).toMatchObject({ result: "already" });
      const p = provider();
      expect((await applyTransaction(p, p.parseTransaction(obj)!)).result).toBe("already");
      expect(await payments(u.email)).toHaveLength(1);
      expect((await getUser(u.email))!.billing).toMatchObject({ provider: "paymob", plan: "starter", txns: [String(obj.id)] });
    });
  });

  describe("rule 2053: the callback signature is compared in constant time (sameSecret)", () => {
    const sample = txnObj({ amount: 100, orderId: 4778239, ref: "pmi_" + "b".repeat(24), id: 2556706 });
    it("verifyWebhook accepts only a 128-hex HMAC of the event under our secret", () => {
      const p = provider();
      const e = p.parseEvent({ type: "TRANSACTION", obj: sample })!;
      const mac = sign(sample);
      expect(p.verifyWebhook(e, mac)).toBe(true);
      expect(p.verifyWebhook(e, mac.toUpperCase())).toBe(true);
      expect(p.verifyWebhook(e, signHmac(hmacString(sample, TXN_HMAC_FIELDS), "another-secret"))).toBe(false);
      for (const bad of [null, undefined, "", mac.slice(0, 64), "z".repeat(128), 42]) expect(p.verifyWebhook(e, bad), String(bad)).toBe(false);
      expect(p.verifyWebhook({ ...e, obj: { ...sample, amount_cents: 1 } }, mac)).toBe(false);
    });
    it("the comparison is sameSecret, never ===, and the provider's verifyWebhook goes through it", () => {
      const src = read("src/lib/paymob.ts");
      const verify = src.slice(src.indexOf("export function verifyHmac"), src.indexOf("// ---- The provider"));
      expect(verify).toMatch(/return sameSecret\(signHmac\(hmacString\(obj, fields\), secret\), received\.toLowerCase\(\)\);/);
      expect(verify).not.toMatch(/===\s*received|received\s*===/);
      expect(src).toMatch(/verifyWebhook: \(e, signature\) => verifyHmac\(e\.obj, e\.kind === "card_token" \? TOKEN_HMAC_FIELDS : TXN_HMAC_FIELDS, signature, cfg\.hmacSecret\)/);
    });
  });

  describe("rule 2054: Paymob's documented field order (20 for a transaction, 8 for a card token), through the interface", () => {
    const doc = {
      amount_cents: 100, created_at: "2020-03-25T18:39:44.719228", currency: "EGP", error_occured: false, has_parent_transaction: false,
      id: 2556706, integration_id: 6741, is_3d_secure: true, is_auth: false, is_capture: false, is_refunded: false, is_standalone_payment: true,
      is_voided: false, order: { id: 4778239 }, owner: 4705, pending: false, source_data: { pan: "2346", sub_type: "MasterCard", type: "card" }, success: true,
    };
    const DOC_STRING = "1002020-03-25T18:39:44.719228EGPfalsefalse25567066741truefalsefalsefalsetruefalse47782394705false2346MasterCardcardtrue";
    it("the HMAC of the documented concatenation verifies whatever the JSON key order; two values swapped do not", () => {
      expect(TXN_HMAC_FIELDS).toHaveLength(20);
      const p = provider();
      const mac = signHmac(DOC_STRING, ENV.PAYMOB_HMAC_SECRET);
      const reordered = Object.fromEntries(Object.entries(doc).reverse());
      expect(p.verifyWebhook(p.parseEvent({ type: "TRANSACTION", obj: reordered })!, mac)).toBe(true);
      // `pending` (false) and `success` (true) swapped: the same values, another order, so another string.
      expect(p.verifyWebhook({ kind: "transaction", obj: { ...doc, pending: true, success: false } }, mac)).toBe(false);
      // The transaction's HMAC never passes as a card token's.
      expect(p.verifyWebhook({ kind: "card_token", obj: doc }, mac)).toBe(false);
    });
    it("a card token is signed over its 8 documented fields", () => {
      expect(TOKEN_HMAC_FIELDS).toEqual(["card_subtype", "created_at", "email", "id", "masked_pan", "merchant_id", "order_id", "token"]);
      const token = { id: 15978654, token: "3f22ce8a4e77125c70f0bc69830e34c36df469351e2fa6be76428be4", masked_pan: "xxxx-xxxx-xxxx-2346", merchant_id: 1053928, card_subtype: "MasterCard", created_at: "2026-08-24T13:28:31.015314", email: "card@test.example", order_id: "593881581" };
      const p = provider();
      const e = p.parseEvent({ type: "TOKEN", obj: token })!;
      expect(e.kind).toBe("card_token");
      expect(p.verifyWebhook(e, sign(token, TOKEN_HMAC_FIELDS))).toBe(true);
      expect(p.parseCardToken(token)).toEqual({ orderId: 593881581, token: token.token, email: token.email, last4: "2346", brand: "MasterCard", expMonth: "", expYear: "" });
      expect(p.parseCardToken({ ...token, token: "short" })).toBeNull();
      expect(p.parseCardToken({ ...token, order_id: "12x" })).toBeNull();
    });
    it("parseEvent answers null for anything that is not a callback envelope", () => {
      const p = provider();
      for (const b of [null, "x", [], {}, { type: "OTHER", obj: {} }, { type: "TRANSACTION" }, { type: "TRANSACTION", obj: [] }]) expect(p.parseEvent(b), JSON.stringify(b)).toBeNull();
    });
  });

  describe("rule 2055: the saved-card charge is present only with the Moto integration", () => {
    it("savedCard is null without PAYMOB_INTEGRATION_ID_MOTO; with it, prepare uses the Moto integration and charge sends the token", async () => {
      vi.stubEnv("PAYMOB_INTEGRATION_ID_MOTO", "");
      expect(provider().savedCard).toBeNull();
      paymobOn();
      const saved = provider().savedCard!;
      const it = await saved.prepare({ amountCents: 34385, item: { name: "n", description: "d" }, billing: { firstName: "A", lastName: "B", email: "a@test.example", phone: "+966500000123" }, reference: "pmi_" + "c".repeat(24), notificationUrl: "https://x/h", redirectionUrl: "https://x/r", expirationS: 3600 });
      expect(it.paymentKey).toBe(`paykey_${it.orderId}`);
      expect(calls.at(-1)).toMatchObject({ path: "/v1/intention/", auth: `Token ${ENV.PAYMOB_SECRET_KEY}`, body: { amount: 34385, currency: "SAR", payment_methods: [222222] } });
      const txn = await saved.charge(it.paymentKey!, "tok_saved_card_for_test_0001");
      expect(txn).toMatchObject({ id: 1, success: true, orderId: it.orderId });
      expect(calls.at(-1)).toEqual({ path: "/api/acceptance/payments/pay", auth: null, body: { source: { identifier: "tok_saved_card_for_test_0001", subtype: "TOKEN" }, payment_token: it.paymentKey } });
    });
    it("a checkout goes on the card integration and answers the unified checkout page", async () => {
      const c = await provider().createCheckout({ amountCents: 100, item: { name: "n", description: "d" }, billing: { firstName: "A", lastName: "B", email: "a@test.example", phone: "+966500000123" }, reference: "pmi_" + "d".repeat(24), notificationUrl: "https://x/h", redirectionUrl: "https://x/r", expirationS: 3600 });
      expect(calls.at(-1)!.body).toMatchObject({ payment_methods: [111111], special_reference: "pmi_" + "d".repeat(24) });
      expect(c.url).toBe(`https://ksa.checkout.paymob.com/?publicKey=${ENV.PAYMOB_PUBLIC_KEY}&clientSecret=csk_${c.orderId}`);
    });
  });

  describe("rule 2056: refunds go through the provider", () => {
    it("refund posts the transaction and amount with Token auth; a refusal throws a PaymentError with a short code only", async () => {
      const p = provider();
      await p.refund(123456, 34385);
      expect(calls.at(-1)).toEqual({ path: "/api/acceptance/void_refund/refund", auth: `Token ${ENV.PAYMOB_SECRET_KEY}`, body: { transaction_id: 123456, amount_cents: 34385 } });
      refundStatus = 400;
      const e = await p.refund(123456, 34385).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(PaymentError);
      expect((e as Error).message).toBe("paymob_refund_failed:400");
      expect((e as Error).message).not.toContain(ENV.PAYMOB_SECRET_KEY);
    });
  });

  describe("rule 2057: provider errors keep their messages", () => {
    it("PaymobError is a PaymentError, named and worded as before; billing logs only a PaymentError's message", () => {
      const e = new PaymobError("intention_failed", 502);
      expect(e).toBeInstanceOf(PaymentError);
      expect(e.name).toBe("PaymobError");
      expect(e.message).toBe("paymob_intention_failed:502");
      expect(new PaymentError("paymob", "renewal_off").message).toBe("paymob_renewal_off");
      const billing = read("src/lib/billing.ts");
      expect(billing.match(/e(?:rr)? instanceof PaymentError \? e(?:rr)?\.message : "error"/g)).toHaveLength(3);
      expect(billing).not.toMatch(/PaymobError|paymobConfig|createIntention|payWithToken|refundTxn|verifyHmac/);
    });
  });
});

// ---------------------------------------------------------------- storage

const NAME = (c: string) => `${c.repeat(32)}.jpg`;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
function clearIndex() {
  const mem = (globalThis as unknown as { __nashrMem?: { kv: Map<string, unknown>; sets: Map<string, Set<string>> } }).__nashrMem;
  for (const m of [mem?.kv, mem?.sets]) for (const k of [...(m?.keys() ?? [])]) if (k.startsWith("mfile")) m!.delete(k);
}

describe("storage", () => {
  let net: ReturnType<typeof noNetwork>;
  beforeEach(() => { resetMediaCounters(); clearIndex(); mediaEnv({ store: true }); net = noNetwork(); });
  afterEach(() => { net.restore(); vi.unstubAllEnvs(); });

  describe("rule 2058: one adapter type, the disk its only implementation, chosen in one place", () => {
    it("storage() is the disk adapter, configured exactly when MEDIA_DIR is", () => {
      expect(storage().name).toBe("disk");
      expect(storage().configured()).toBe(true);
      vi.stubEnv("MEDIA_DIR", "relative/media");
      expect(storage().configured()).toBe(false);
    });
    it("only the disk adapter touches the filesystem: the store and the /m/ route import no node:fs", () => {
      for (const f of ["src/lib/media/store.ts", "src/app/m/[name]/route.ts"]) expect(read(f), f).not.toMatch(/from "node:fs"|from "fs"/);
      expect(read("src/lib/media/disk.ts")).toMatch(/from "node:fs"/);
      expect(read("src/lib/media/storage.ts")).toMatch(/export function storage\(\): StorageAdapter \{\n {2}return diskStorage;\n\}/);
    });
  });

  describe("rule 2059: the store's checks run before the adapter keeps anything, and the adapter never sees a tenant", () => {
    it("too large, no room and no store all refuse with nothing written", async () => {
      vi.stubEnv("MEDIA_MAX_FILE_BYTES", "10");
      await expect(writeToStore(JPEG, "image", { scope: "a@test.example", taskId: "t" })).rejects.toMatchObject({ code: "too_large" });
      vi.stubEnv("MEDIA_MAX_FILE_BYTES", "");
      vi.stubEnv("MEDIA_MAX_FILES", "1");
      await expect(writeToStore(JPEG, "image", { scope: "a@test.example", taskId: "t" })).rejects.toBeInstanceOf(StoreError);
      expect(readdirSync(mediaDir()!)).toEqual([]);
      vi.stubEnv("MEDIA_DIR", "");
      await expect(writeToStore(JPEG, "image", { scope: "a@test.example", taskId: "t" })).rejects.toMatchObject({ code: "no_store" });
    });
    it("a write is indexed under the caller's scope only; the adapter's methods take a name and bytes, never a scope", async () => {
      const out = await writeToStore(JPEG, "image", { scope: "a@test.example", taskId: "t1" });
      const name = out.url.slice(out.url.lastIndexOf("/") + 1);
      expect(await db.get<MediaEntry>(MEDIA_KEYS.entry("a@test.example", name))).toMatchObject({ taskId: "t1", kind: "image", bytes: JPEG.length });
      expect(await db.get(MEDIA_KEYS.entry("b@test.example", name))).toBeNull();
      const iface = read("src/lib/media/storage.ts");
      const body = iface.slice(iface.indexOf("export interface StorageAdapter"), iface.indexOf("/** The one place"));
      expect(body).not.toMatch(/scope|email|owner/i);
    });
  });

  describe("rule 2060: put keeps owner-only files and never overwrites", () => {
    it("a second put of the same name fails and leaves the first bytes; no .part file is left behind", async () => {
      const s = storage();
      await s.put(NAME("a"), JPEG);
      const file = path.join(mediaDir()!, "aa", NAME("a"));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      await expect(s.put(NAME("a"), Buffer.from("other"))).rejects.toBeTruthy();
      expect(await s.get(NAME("a"))).toEqual(JPEG);
      expect(readdirSync(path.join(mediaDir()!, ".tmp"))).toEqual([]);
    });
    it("a name that is not one of ours never becomes a path", async () => {
      const s = storage();
      for (const bad of ["../x.jpg", NAME("A"), "a".repeat(32) + ".png", `${NAME("a")}/x`, ""]) {
        await expect(s.put(bad, JPEG), bad).rejects.toBeTruthy();
        expect(await s.head(bad), bad).toBeNull();
        expect(await s.get(bad), bad).toBeNull();
        expect(await s.delete(bad), bad).toBe("missing");
        expect(() => s.stream(bad), bad).toThrow();
      }
      expect(existsSync(path.join(mediaDir()!, "..", "x.jpg"))).toBe(false);
    });
  });

  describe("rule 2061: get, stream, head and delete through the adapter", () => {
    it("head says size and type, stream serves a range, delete answers deleted then missing", async () => {
      const s = storage();
      const mp4 = `${"b".repeat(32)}.mp4`;
      await Promise.all([s.put(NAME("c"), JPEG), s.put(mp4, Buffer.from("0123456789"))]);
      expect(await s.head(NAME("c"))).toMatchObject({ size: JPEG.length, contentType: "image/jpeg" });
      expect(await s.head(mp4)).toMatchObject({ size: 10, contentType: "video/mp4" });
      const chunks: Buffer[] = [];
      for await (const c of s.stream(mp4, { start: 2, end: 5 })) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe("2345");
      expect(await s.delete(mp4)).toBe("deleted");
      expect(await s.delete(mp4)).toBe("missing");
      expect(await s.head(mp4)).toBeNull();
      expect(await s.get(mp4)).toBeNull();
    });
    it("the probe writes, reads back and deletes through the adapter, and reports no store without MEDIA_DIR", async () => {
      expect((await storage().probe()).status).toBe("ok");
      vi.stubEnv("MEDIA_DIR", "");
      expect(await storage().probe()).toEqual({ status: "error:no_store", survivedBuilds: null, freeBytes: null });
    });
  });

  describe("rule 2062: the served URL comes from the adapter and the /m/ route reads through it", () => {
    it("url(name) is our private /m/ URL, and writeToStore answers exactly it", async () => {
      const out = await writeToStore(JPEG, "image", { scope: "a@test.example", taskId: "t2" });
      const name = out.url.slice(out.url.lastIndexOf("/") + 1);
      expect(out.url).toBe(storage().url(name));
      expect(out.url).toBe(`${mediaOrigin()}/m/${name}`);
      expect(isOurMediaUrl(out.url)).toBe(true);
    });
    it("the route checks the member or the share link before it asks the adapter for anything", () => {
      const src = read("src/app/m/[name]/route.ts");
      const check = src.indexOf("shareValid(name");
      expect(check).toBeGreaterThan(0);
      expect(src.indexOf("db.get(MEDIA_KEYS.entry(sc(u), name))")).toBeGreaterThan(0);
      expect(src.indexOf("st.head(name)")).toBeGreaterThan(src.indexOf("db.get(MEDIA_KEYS.entry(sc(u), name))"));
      expect(src).toMatch(/const stream = st\.stream\(name, \{ start, end \}\);/);
    });
  });
});

describe("rule 2063: stored keys and shapes are unchanged by both seams", () => {
  it("media index keys and Paymob keys keep their exact names", () => {
    expect([MEDIA_KEYS.entry("s", "n"), MEDIA_KEYS.names("s"), MEDIA_KEYS.bytes(), MEDIA_KEYS.count()]).toEqual(["mfile:s:n", "mfiles:s", "mfiles:bytes", "mfiles:count"]);
    const billing = read("src/lib/billing.ts");
    for (const k of ["paymob:intent:${ref}", "paymob:order:${orderId}", "paymob:txn:${txnId}", "paymob:done:${txnId}", "paymob:txlock:${txnId}", "paymob:refunded:${txnId}", "paymob:refundlock:${txnId}", "paymob:attempt:${email}:${day}", "paymob:card:${email}", "paymob:last:${email}"]) expect(billing, k).toContain("`" + k + "`");
    expect(billing).toMatch(/provider: "paymob", plan, status: "active"/);
  });
});
