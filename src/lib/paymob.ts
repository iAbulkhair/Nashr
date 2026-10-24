import { createHmac } from "node:crypto";
import { sameSecret } from "./rate";
import { log } from "./log";
import { PaymentError, type CardTokenEvent, type PaymentProvider, type PaymentTxn, type WebhookEvent } from "./payments/provider";

/**
 * Paymob KSA adapter (spec docs/superpowers/specs/2026-10-08-paymob-billing-design.md section 2): the configuration gate,
 * the four HTTP calls we make (create intention, pay with a saved card, refund, void) and the callback HMACs, offered to
 * billing as the only `PaymentProvider` (`paymobProvider`, src/lib/payments/provider.ts, rule 2050). Plain
 * `fetch` and `node:crypto`, no SDK. The hosts are constants, never user input. No secret is ever logged, put in a URL
 * or put in an error: errors carry a short code and the HTTP status only.
 */

export const PAYMOB_API = "https://ksa.paymob.com";
export const PAYMOB_CHECKOUT = "https://ksa.checkout.paymob.com";
const TIMEOUT_MS = 15_000;

export type PaymobConfig = {
  secretKey: string;
  publicKey: string;
  hmacSecret: string;
  cardIntegration: number;
  /** The Moto integration for saved-card renewals; null when not set (renewals then go through checkout by hand). */
  motoIntegration: number | null;
  /** Live keys (allowed only with PAYMOB_LIVE=1). */
  live: boolean;
};

const integrationId = (v: string | undefined): number | null => (v && /^\d{1,12}$/.test(v.trim()) ? Number(v.trim()) : null);
/** Paymob keys may carry a region prefix (`egy_sk_test_…`); test keys say `sk_test_` / `pk_test_`. */
const isTestKey = (key: string, kind: "sk" | "pk") => new RegExp(`^(?:[a-z]{2,4}_)?${kind}_test_`).test(key);

let warnedLive = false;
/**
 * The gate: Paymob is on only when the secret key, public key, HMAC secret and card integration id are all set. Live keys
 * (anything that is not a test key) also need PAYMOB_LIVE=1, so a branch or preview deploy cannot take real money by
 * accident. Read per call, so tests and a variable added in the host take effect without a restart of this module.
 */
export function paymobConfig(): PaymobConfig | null {
  const secretKey = (process.env.PAYMOB_SECRET_KEY ?? "").trim();
  const publicKey = (process.env.PAYMOB_PUBLIC_KEY ?? "").trim();
  const hmacSecret = (process.env.PAYMOB_HMAC_SECRET ?? "").trim();
  const cardIntegration = integrationId(process.env.PAYMOB_INTEGRATION_ID_CARD);
  if (!secretKey || !publicKey || !hmacSecret || cardIntegration === null) return null;
  const live = !(isTestKey(secretKey, "sk") && isTestKey(publicKey, "pk"));
  if (live && process.env.PAYMOB_LIVE !== "1") {
    if (!warnedLive) log.error("paymob_live_keys_refused: PAYMOB_LIVE is not 1, so Paymob stays off");
    warnedLive = true;
    return null;
  }
  return { secretKey, publicKey, hmacSecret, cardIntegration, motoIntegration: integrationId(process.env.PAYMOB_INTEGRATION_ID_MOTO), live };
}

/** A Paymob failure. The message is `paymob_{code}[:{status}]`, as before the provider seam (rule 2057). */
export class PaymobError extends PaymentError {
  constructor(code: string, status = 0) {
    super("paymob", code, status);
    this.name = "PaymobError";
  }
}

async function post(path: string, body: unknown, auth: string | null): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${PAYMOB_API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(auth ? { authorization: `Token ${auth}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new PaymobError("unreachable");
  }
  return { status: res.status, json: await res.json().catch(() => null) };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const posInt = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};

export type IntentionInput = {
  amountCents: number;
  integration: number;
  item: { name: string; description: string };
  billing: { firstName: string; lastName: string; email: string; phone: string };
  reference: string;
  notificationUrl: string;
  redirectionUrl: string;
  expirationS: number;
};
export type Intention = { intentionId: string; clientSecret: string; orderId: number; paymentKey: string | null };

/** POST /v1/intention/ (Token auth). One item for the whole amount, so the items always sum to it. */
export async function createIntention(cfg: PaymobConfig, i: IntentionInput): Promise<Intention> {
  const { status, json } = await post("/v1/intention/", {
    amount: i.amountCents,
    currency: "SAR",
    payment_methods: [i.integration],
    items: [{ name: i.item.name.slice(0, 50), amount: i.amountCents, description: i.item.description.slice(0, 255), quantity: 1 }],
    billing_data: {
      first_name: i.billing.firstName, last_name: i.billing.lastName, email: i.billing.email, phone_number: i.billing.phone,
      apartment: "NA", floor: "NA", street: "NA", building: "NA", city: "NA", state: "NA", country: "SA",
    },
    special_reference: i.reference,
    notification_url: i.notificationUrl,
    redirection_url: i.redirectionUrl,
    expiration: i.expirationS,
  }, cfg.secretKey);
  if (status !== 200 && status !== 201) throw new PaymobError("intention_failed", status);
  const j = isObj(json) ? json : {};
  const orderId = posInt(j.intention_order_id);
  const keys = Array.isArray(j.payment_keys) ? j.payment_keys : [];
  const first = isObj(keys[0]) ? keys[0] : {};
  if (typeof j.client_secret !== "string" || !j.client_secret || orderId === null) throw new PaymobError("intention_bad_answer", status);
  return { intentionId: typeof j.id === "string" ? j.id : "", clientSecret: j.client_secret, orderId, paymentKey: typeof first.key === "string" && first.key ? first.key : null };
}

/** The unified checkout page for an intention. The public key is public and the client secret is single-use. */
export const checkoutUrl = (cfg: PaymobConfig, clientSecret: string) =>
  `${PAYMOB_CHECKOUT}/?publicKey=${encodeURIComponent(cfg.publicKey)}&clientSecret=${encodeURIComponent(clientSecret)}`;

/**
 * A transaction as we use it, from a callback's `obj` or from the pay answer. Null when the shape is not one. Our
 * reference (`special_reference`) is echoed as `order.merchant_order_id`.
 */
export type Txn = PaymentTxn;
export function parseTxn(o: unknown): Txn | null {
  if (!isObj(o)) return null;
  const id = posInt(o.id);
  const amountCents = typeof o.amount_cents === "number" && Number.isSafeInteger(o.amount_cents) ? o.amount_cents : null;
  if (id === null || amountCents === null) return null;
  const order = o.order;
  const orderId = isObj(order) ? posInt(order.id) : posInt(order);
  const ref = isObj(order) && typeof order.merchant_order_id === "string" ? order.merchant_order_id : null;
  return {
    id, amountCents, orderId, ref,
    success: o.success === true,
    pending: o.pending === true,
    currency: typeof o.currency === "string" ? o.currency : "",
    isRefunded: o.is_refunded === true,
    isVoided: o.is_voided === true,
    hasParent: o.has_parent_transaction === true,
    isLive: typeof o.is_live === "boolean" ? o.is_live : null,
  };
}

/** MIT: charge a saved card with a Moto intention's payment key (POST /api/acceptance/payments/pay). Null when the answer is not a transaction. */
export async function payWithToken(paymentKey: string, cardToken: string): Promise<Txn | null> {
  const { status, json } = await post("/api/acceptance/payments/pay", { source: { identifier: cardToken, subtype: "TOKEN" }, payment_token: paymentKey }, null);
  if (status >= 500) throw new PaymobError("pay_failed", status);
  return parseTxn(json);
}

/** Refund `amountCents` of a transaction (Token auth). Paymob refuses more than is refundable (400). */
export async function refundTxn(cfg: PaymobConfig, txnId: number, amountCents: number): Promise<void> {
  const { status } = await post("/api/acceptance/void_refund/refund", { transaction_id: txnId, amount_cents: amountCents }, cfg.secretKey);
  if (status !== 200 && status !== 201) throw new PaymobError("refund_failed", status);
}

/** Void a same-day transaction (Token auth). Not used by the console in v1. */
export async function voidTxn(cfg: PaymobConfig, txnId: number): Promise<void> {
  const { status } = await post("/api/acceptance/void_refund/void", { transaction_id: txnId }, cfg.secretKey);
  if (status !== 200 && status !== 201) throw new PaymobError("void_failed", status);
}

// ---- Callback HMACs (SHA-512, lowercase hex, values concatenated in Paymob's documented order) ----

/** Transaction processed callback (POST, `obj`): 20 fields. */
export const TXN_HMAC_FIELDS = [
  "amount_cents", "created_at", "currency", "error_occured", "has_parent_transaction", "id", "integration_id", "is_3d_secure",
  "is_auth", "is_capture", "is_refunded", "is_standalone_payment", "is_voided", "order.id", "owner", "pending",
  "source_data.pan", "source_data.sub_type", "source_data.type", "success",
] as const;
/** Card token callback (POST, `obj`): 8 fields. */
export const TOKEN_HMAC_FIELDS = ["card_subtype", "created_at", "email", "id", "masked_pan", "merchant_id", "order_id", "token"] as const;

function field(obj: Record<string, unknown>, path: string): unknown {
  const [head, sub] = path.split(".");
  const v = Object.prototype.hasOwnProperty.call(obj, head) ? obj[head] : undefined;
  if (!sub) return v;
  // `order` is an object in the POST callback and a bare id in some answers.
  if (head === "order" && sub === "id" && !isObj(v)) return v;
  return isObj(v) && Object.prototype.hasOwnProperty.call(v, sub) ? v[sub] : undefined;
}
/** A value as Paymob writes it: booleans `true`/`false`, numbers plain, null or missing as "" (spec open question 3). */
const asText = (v: unknown) => (v === null || v === undefined || typeof v === "object" ? "" : String(v));

export const hmacString = (obj: Record<string, unknown>, fields: readonly string[]) => fields.map((f) => asText(field(obj, f))).join("");
export const signHmac = (text: string, secret: string) => createHmac("sha512", secret).update(text, "utf8").digest("hex");

/** True only for a 128-hex `received` equal, in constant time, to the HMAC of `obj`'s fields. Anything else is false. */
export function verifyHmac(obj: unknown, fields: readonly string[], received: unknown, secret: string): boolean {
  if (!isObj(obj) || typeof received !== "string" || !/^[a-f0-9]{128}$/i.test(received) || !secret) return false;
  return sameSecret(signHmac(hmacString(obj, fields), secret), received.toLowerCase());
}

// ---- The provider (rule 2050) ----

/** A callback's envelope: `{ type: "TRANSACTION" | "TOKEN", obj: {…} }`. Null for anything else (the webhook answers 400). */
export function parseEvent(body: unknown): WebhookEvent | null {
  const b = isObj(body) ? body : null;
  const obj = b && isObj(b.obj) ? b.obj : null;
  if (!b || !obj || (b.type !== "TRANSACTION" && b.type !== "TOKEN")) return null;
  return { kind: b.type === "TOKEN" ? "card_token" : "transaction", obj };
}

/** A card token callback's `obj`. Null without a whole order id and a token of the documented alphabet. */
export function parseCardToken(o: Record<string, unknown>): CardTokenEvent | null {
  const orderId = typeof o.order_id === "string" && /^\d{1,15}$/.test(o.order_id) ? Number(o.order_id) : typeof o.order_id === "number" ? o.order_id : null;
  const token = typeof o.token === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(o.token) ? o.token : null;
  if (!orderId || !Number.isSafeInteger(orderId) || !token) return null;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[^\w -]/g, "").slice(0, max) : "");
  return {
    orderId, token, email: typeof o.email === "string" ? o.email : "",
    last4: text(o.masked_pan, 32).replace(/\D/g, "").slice(-4), brand: text(o.card_subtype, 20),
    expMonth: text(o.expiry_month, 2), expYear: text(o.expiry_year, 4),
  };
}

/**
 * Paymob as a `PaymentProvider`, or null while the gate (`paymobConfig`) is closed. The configuration, secrets included,
 * stays inside these closures: the object carries no key, so nothing that logs or returns it can leak one. Saved-card
 * renewals need the Moto integration; without it `savedCard` is null and renewals go through checkout by hand.
 */
export function paymobProvider(): PaymentProvider | null {
  const cfg = paymobConfig();
  if (!cfg) return null;
  const moto = cfg.motoIntegration;
  return {
    name: "paymob",
    live: cfg.live,
    async createCheckout(i) {
      const it = await createIntention(cfg, { ...i, integration: cfg.cardIntegration });
      return { orderId: it.orderId, url: checkoutUrl(cfg, it.clientSecret) };
    },
    savedCard: moto ? {
      async prepare(i) {
        const it = await createIntention(cfg, { ...i, integration: moto });
        return { orderId: it.orderId, paymentKey: it.paymentKey };
      },
      charge: payWithToken,
    } : null,
    parseEvent,
    verifyWebhook: (e, signature) => verifyHmac(e.obj, e.kind === "card_token" ? TOKEN_HMAC_FIELDS : TXN_HMAC_FIELDS, signature, cfg.hmacSecret),
    parseTransaction: parseTxn,
    parseCardToken,
    refund: (txnId, amountCents) => refundTxn(cfg, Number(txnId), amountCents),
  };
}
