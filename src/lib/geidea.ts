import { createHmac } from "node:crypto";
import { sameSecret } from "./rate";
import { log } from "./log";
import { isProductionDeploy, isStaging } from "./deploy-env";
import { appOrigin } from "./origin";
import { PaymentDeclined, PaymentError, type CheckoutInput, type PaymentProvider, type PaymentTxn, type TxnCard, type WebhookEvent } from "./payments/provider";

/**
 * Geidea KSA adapter (spec docs/superpowers/specs/2026-10-18-geidea-payment-provider-design.md, rules 3900-3917): the
 * configuration gate, the HTTP calls we make (create session, pay with a saved card, refund, fetch an order by our
 * reference) and the callback signature, offered to billing as a `PaymentProvider` (src/lib/payments/provider.ts, rule
 * 2050). Plain `fetch` and `node:crypto`, no SDK (Geidea publishes none for Node). The hosts are constants, never user
 * input. HTTP Basic with the public key and the API password; the API password is also the HMAC key of every signature,
 * ours and Geidea's. No secret is ever logged, put in a URL or put in an error: errors carry a short code, the HTTP status
 * and at most Geidea's `detailedResponseCode`.
 */

export const GEIDEA_API = "https://api.ksamerchant.geidea.net";
export const GEIDEA_HPP = "https://www.ksamerchant.geidea.net/hpp/checkout/";
const TIMEOUT_MS = 15_000;

/** A UUID (any version, either case): Geidea's order, token and agreement ids. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GeideaConfig = {
  publicKey: string;
  apiPassword: string;
  /** Geidea switched merchant-initiated charges on for the account (`GEIDEA_MIT=1`): saved-card renewals are offered. */
  mit: boolean;
  /** Live credentials (`GEIDEA_LIVE=1`, honoured only on the production deploy, never on staging). */
  live: boolean;
};

let warnedLive = false;
/**
 * The gate (rule 3900): Geidea is on only when the public key and the API password are both set. Geidea's credentials do
 * not show whether they are test or live (spec G2), so the live guard is the deploy: `GEIDEA_LIVE=1` is honoured only on
 * the production deploy (`isProductionDeploy()` and not `isStaging()`); set anywhere else the gate closes and logs
 * `geidea_live_refused` once. Without it every order must say `isTest: true` (a live order is a mismatch, rule 3907).
 * Read per call, so tests and a variable added in the host take effect without a restart of this module.
 */
export function geideaConfig(): GeideaConfig | null {
  const publicKey = (process.env.GEIDEA_PUBLIC_KEY ?? "").trim();
  const apiPassword = (process.env.GEIDEA_API_PASSWORD ?? "").trim();
  // A colon or a space would break the Basic-auth pair; such a value is not a Geidea key.
  if (!/^[^\s:]{8,200}$/.test(publicKey) || !/^\S{8,200}$/.test(apiPassword)) return null;
  const live = process.env.GEIDEA_LIVE === "1";
  if (live && (!isProductionDeploy() || isStaging())) {
    if (!warnedLive) log.error("geidea_live_refused: GEIDEA_LIVE=1 outside the production deploy, so Geidea stays off");
    warnedLive = true;
    return null;
  }
  return { publicKey, apiPassword, mit: process.env.GEIDEA_MIT === "1", live };
}

/** A Geidea failure. The message is `geidea_{code}[:{status}]`. */
export class GeideaError extends PaymentError {
  constructor(code: string, status = 0) {
    super("geidea", code, status);
    this.name = "GeideaError";
  }
}

// ---- Money: riyals with 2 decimals on the wire, halalas in our code, integer math only (rule 3901) ----

/** 34385 → "343.85". Only a whole, non-negative, safe number of halalas. */
export function toRiyals(halalas: number): string {
  if (!Number.isSafeInteger(halalas) || halalas < 0) throw new GeideaError("bad_amount");
  return `${Math.floor(halalas / 100)}.${String(halalas % 100).padStart(2, "0")}`;
}

/**
 * "343.85" or 343.85 → 34385. Null for anything else: negative, more than 2 decimals, an exponent, not finite, not a
 * number. A JSON number is read through its shortest decimal text, so 343.85 is exactly "343.85", never 343.8499….
 */
export function toHalalas(v: unknown): number | null {
  const text = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v.trim() : "";
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

// ---- Signatures (HMAC-SHA256 keyed with the API password, Base64 of the raw bytes) ----

const pad = (n: number) => String(n).padStart(2, "0");
/**
 * The timestamp we send and sign, `YYYY/MM/DD HH:mm:ss` in UTC (the format of Geidea's PHP sample). The exact format is
 * UNVERIFIED (spec G5, question G6); we always sign exactly the string we send.
 */
export function geideaTimestamp(now = new Date()): string {
  return `${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
}
export const signGeidea = (text: string, apiPassword: string) => createHmac("sha256", apiPassword).update(text, "utf8").digest("base64");

/** Session (G5): public key + amount (2 decimals) + currency + merchantReferenceId + timestamp. */
export const sessionSignText = (publicKey: string, amountHalalas: number, currency: string, ref: string, timestamp: string) =>
  `${publicKey}${toRiyals(amountHalalas)}${currency}${ref}${timestamp}`;
/** Saved-card charge (G10): public key + session id + timestamp. */
export const payTokenSignText = (publicKey: string, sessionId: string, timestamp: string) => `${publicKey}${sessionId}${timestamp}`;
/** Refund (G12): timestamp + public key + refund amount (2 decimals) + order id. */
export const refundSignText = (timestamp: string, publicKey: string, amountHalalas: number, orderId: string) =>
  `${timestamp}${publicKey}${toRiyals(amountHalalas)}${orderId}`;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Callback (G7): public key + amount (2 decimals) + currency + orderId + status + merchantReferenceId + timeStamp. Null
 * when the amount cannot be read (the signature then never matches).
 */
export function callbackSignText(publicKey: string, order: Record<string, unknown>, timeStamp: string): string | null {
  const amount = toHalalas(order.amount);
  if (amount === null) return null;
  return `${publicKey}${toRiyals(amount)}${str(order.currency)}${str(order.orderId)}${str(order.status)}${str(order.merchantReferenceId)}${timeStamp}`;
}

/** True only for a 44-character Base64 `body.signature` equal, in constant time, to ours over the callback (rule 3903). */
export function verifyCallback(body: unknown, publicKey: string, apiPassword: string): boolean {
  if (!isObj(body) || !isObj(body.order) || typeof body.signature !== "string" || typeof body.timeStamp !== "string" || !apiPassword) return false;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(body.signature)) return false;
  const text = callbackSignText(publicKey, body.order, body.timeStamp);
  return text !== null && sameSecret(signGeidea(text, apiPassword), body.signature);
}

// ---- HTTP ----

async function call(cfg: GeideaConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${GEIDEA_API}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.apiPassword}`, "utf8").toString("base64")}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new GeideaError("unreachable");
  }
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Geidea's answer codes: `000` / `000` is success. Only a short, safe code is ever kept. */
const codeOf = (v: unknown) => (typeof v === "string" && /^[0-9.]{1,12}$/.test(v) ? v : typeof v === "number" && Number.isSafeInteger(v) ? String(v).padStart(3, "0") : "");

export type SessionInput = CheckoutInput & {
  /** A merchant-initiated renewal: the saved card's token and agreement (G10 step 2). */
  merchant?: { token: string; agreementId: string };
};

/** The body of `POST /payment-intent/api/v2/direct/session` (G4, G10). Exported for the tests (rule 3902). */
export function sessionBody(cfg: GeideaConfig, i: SessionInput, timestamp: string): Record<string, unknown> {
  const amount = toRiyals(i.amountCents);
  const body: Record<string, unknown> = {
    amount: Number(amount),
    currency: "SAR",
    timestamp,
    merchantReferenceId: i.reference,
    signature: signGeidea(sessionSignText(cfg.publicKey, i.amountCents, "SAR", i.reference, timestamp), cfg.apiPassword),
    paymentOperation: "Pay",
    callbackUrl: i.notificationUrl,
    returnUrl: i.redirectionUrl,
    language: i.lang === "en" ? "en" : "ar",
    // Name and email only (spec F4): Geidea needs a phone only for Tabby and Tamara.
    customer: { email: i.billing.email, firstName: i.billing.firstName, lastName: i.billing.lastName },
    // Cards only in v1 (spec F3): no Apple Pay or STC Pay button on the hosted page.
    hideWallets: true,
  };
  if (i.merchant) {
    // G10 step 2. The guide puts the agreement at the top level and the reference inside `cofAgreement` (question G2), so both are sent.
    Object.assign(body, {
      initiatedBy: "Merchant", cardOnFile: true, tokenId: i.merchant.token,
      agreementId: i.merchant.agreementId, agreementType: "Unscheduled",
      cofAgreement: { id: i.merchant.agreementId, type: "Unscheduled" },
    });
  } else if (i.agreementId) {
    // A plan's first payment saves the card under our agreement (G10 step 1). A pack saves nothing.
    Object.assign(body, { initiatedBy: "Internet", cardOnFile: true, cofAgreement: { id: i.agreementId, type: "Unscheduled" } });
  }
  return body;
}

/** Create a session. Answers its id, which alone builds the hosted page's URL. */
export async function createSession(cfg: GeideaConfig, i: SessionInput, now = new Date()): Promise<string> {
  const { status, json } = await call(cfg, "POST", "/payment-intent/api/v2/direct/session", sessionBody(cfg, i, geideaTimestamp(now)));
  const j = isObj(json) ? json : {};
  const session = isObj(j.session) ? j.session : {};
  const id = typeof session.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(session.id) ? session.id : null;
  if (status !== 200 && status !== 201) throw new GeideaError("session_failed", status);
  const detailed = codeOf(j.detailedResponseCode);
  if (codeOf(j.responseCode) !== "000" || !id) throw new GeideaError(detailed ? `session_refused_${detailed}` : "session_refused", status);
  return id;
}

/** The hosted page for a session (G1, G4): built from the session id only. */
export const hostedPageUrl = (sessionId: string) => `${GEIDEA_HPP}?${encodeURIComponent(sessionId)}`;

// ---- Orders (rule 3904) ----

const PAID_DETAILED = new Set(["000", "000.004"]);

/**
 * The codes a paid order is judged by: the last `Pay` transaction's, and the order's own when it carries them (where
 * they sit is UNVERIFIED, question G8). When both are present they must agree.
 */
function payCodes(order: Record<string, unknown>): { response: string; detailed: string } | null {
  const txns = Array.isArray(order.transactions) ? order.transactions.filter(isObj) : [];
  const last = txns.filter((t) => typeof t.type === "string" && t.type.toLowerCase() === "pay").at(-1);
  const codes = last && isObj(last.codes) ? last.codes : null;
  const fromTxn = codes ? { response: codeOf(codes.responseCode), detailed: codeOf(codes.detailedResponseCode) } : null;
  const fromOrder = order.responseCode !== undefined || order.detailedResponseCode !== undefined
    ? { response: codeOf(order.responseCode), detailed: codeOf(order.detailedResponseCode) } : null;
  if (fromTxn && fromOrder && (fromTxn.response !== fromOrder.response || fromTxn.detailed !== fromOrder.detailed)) return null;
  return fromTxn ?? fromOrder;
}

/** The card a paid order saved (rule 3906): token and agreement validated as UUIDs; none on 000.004 (paid, no token). */
function cardOf(order: Record<string, unknown>, detailed: string): TxnCard | undefined {
  if (detailed === "000.004" || typeof order.tokenId !== "string" || !UUID.test(order.tokenId)) return undefined;
  const pm = isObj(order.paymentMethod) ? order.paymentMethod : {};
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[^\w -]/g, "").slice(0, max) : "");
  const exp = pm.expiryDate;
  let expMonth = "", expYear = "";
  if (isObj(exp)) {
    expMonth = text(String(exp.month ?? ""), 2).padStart(2, "0");
    expYear = text(String(exp.year ?? ""), 4);
  } else if (typeof exp === "string") {
    const m = /^(\d{1,2})\s*\/\s*(\d{2,4})$/.exec(exp.trim());
    if (m) [expMonth, expYear] = [m[1].padStart(2, "0"), m[2]];
  }
  return {
    token: order.tokenId.toLowerCase(),
    agreementId: typeof order.agreementId === "string" && UUID.test(order.agreementId) ? order.agreementId.toLowerCase() : null,
    last4: (typeof pm.maskedCardNumber === "string" ? pm.maskedCardNumber : "").replace(/\D/g, "").slice(-4),
    brand: text(pm.brand, 20) || "card",
    expMonth, expYear,
  };
}

/**
 * A Geidea order (the callback's `order`, or the `order` of an answer) as billing uses it. Null when the shape is not one:
 * no UUID order id, or an amount that is not riyals with at most 2 decimals. Paid only on Success + Paid + 000 / 000 (or
 * 000.004, paid without a saved card); Failed and "Cancelled By User" are declines; InProgress is pending; any refunded
 * total marks it refunded. A missing `isTest` reads as live, so a test-mode deployment refuses it (fail closed, rule 3907).
 */
export function parseOrder(o: unknown): PaymentTxn | null {
  const order = isObj(o) && isObj(o.order) ? o.order : o;
  if (!isObj(order) || typeof order.orderId !== "string" || !UUID.test(order.orderId)) return null;
  const amountCents = toHalalas(order.amount);
  if (amountCents === null) return null;
  const status = str(order.status);
  const detailedStatus = str(order.detailedStatus);
  const codes = payCodes(order);
  const success = status === "Success" && detailedStatus === "Paid" && !!codes && codes.response === "000" && PAID_DETAILED.has(codes.detailed);
  const refundedTotal = toHalalas(order.totalRefundedAmount);
  const id = order.orderId.toLowerCase();
  const card = success ? cardOf(order, codes!.detailed) : undefined;
  return {
    id, amountCents, orderId: id,
    ref: typeof order.merchantReferenceId === "string" ? order.merchantReferenceId.toLowerCase() : null,
    success,
    pending: status === "InProgress",
    currency: str(order.currency),
    isRefunded: (refundedTotal !== null && refundedTotal > 0) || /refund/i.test(detailedStatus),
    isVoided: /void/i.test(detailedStatus),
    hasParent: false,
    isLive: order.isTest !== true,
    ...(card ? { card } : {}),
    agreementId: typeof order.agreementId === "string" && UUID.test(order.agreementId) ? order.agreementId.toLowerCase() : null,
  };
}

/** A callback's envelope `{order, signature, timeStamp}`: the whole body is the event, because the signature covers it. */
export function parseEvent(body: unknown): WebhookEvent | null {
  if (!isObj(body) || !isObj(body.order) || typeof body.signature !== "string" || typeof body.timeStamp !== "string") return null;
  return { kind: "transaction", obj: body };
}

/**
 * MIT (rule 3910): `POST /pgw/api/v2/direct/pay/token` for a Merchant session, signed over public key + session id +
 * timestamp. 750.005 (agreement mismatch), 750.006 (MIT not enabled) and any other refusal without an order are
 * `PaymentDeclined` (nothing charged); a 5xx or no answer is a `GeideaError` (the card may have been charged, rule 2984).
 */
export async function payWithToken(cfg: GeideaConfig, sessionId: string, tokenId: string, agreementId: string | null | undefined, now = new Date()): Promise<PaymentTxn | null> {
  const timestamp = geideaTimestamp(now);
  const { status, json } = await call(cfg, "POST", "/pgw/api/v2/direct/pay/token", {
    sessionId, tokenId, initiatedBy: "Merchant", ...(agreementId ? { agreementId, agreementType: "Unscheduled" } : {}),
    timestamp, signature: signGeidea(payTokenSignText(cfg.publicKey, sessionId, timestamp), cfg.apiPassword),
  });
  if (status >= 500) throw new GeideaError("pay_failed", status);
  const j = isObj(json) ? json : {};
  const order = parseOrder(j);
  if (order) return order;
  const detailed = codeOf(j.detailedResponseCode);
  if (detailed === "750.005") throw new PaymentDeclined("geidea", "agreement_mismatch");
  if (detailed === "750.006") throw new PaymentDeclined("geidea", "mit_not_enabled");
  const response = codeOf(j.responseCode);
  if (response && response !== "000") throw new PaymentDeclined("geidea", `code_${detailed || response}`);
  return null;
}

/** Refund (rule 3912): any amount from 0.01 SAR to the paid total; a refusal is `geidea_refund_failed[:{status}]`. */
export async function refundOrder(cfg: GeideaConfig, orderId: string, amountHalalas: number, now = new Date()): Promise<void> {
  if (!UUID.test(orderId) || !Number.isSafeInteger(amountHalalas) || amountHalalas < 1) throw new GeideaError("refund_bad_request");
  const timestamp = geideaTimestamp(now);
  const { status, json } = await call(cfg, "POST", "/pgw/api/v2/direct/refund", {
    orderId, refundAmount: Number(toRiyals(amountHalalas)), timestamp,
    signature: signGeidea(refundSignText(timestamp, cfg.publicKey, amountHalalas, orderId), cfg.apiPassword),
    callbackUrl: `${appOrigin()}/api/billing/geidea/webhook`,
  });
  const j = isObj(json) ? json : {};
  if ((status !== 200 && status !== 201) || codeOf(j.responseCode) !== "000") throw new GeideaError("refund_failed", status);
}

/** The order paid under our reference (rule 3909, G14), parsed by the same parser. Null when Geidea has none. */
export async function fetchOrderByReference(cfg: GeideaConfig, ref: string): Promise<PaymentTxn | null> {
  if (!UUID.test(ref)) return null;
  const { status, json } = await call(cfg, "GET", `/pgw/api/v1/direct/order?MerchantReferenceId=${encodeURIComponent(ref)}`);
  if (status === 404) return null;
  if (status !== 200) throw new GeideaError("order_failed", status);
  const j = isObj(json) ? json : {};
  // One order, or a list of the reference's orders: the paid one counts, else the newest.
  const list = Array.isArray(j.orders) ? j.orders.map(parseOrder).filter((t): t is PaymentTxn => !!t) : [];
  return list.find((t) => t.success) ?? list.at(-1) ?? parseOrder(j);
}

/**
 * Geidea as a `PaymentProvider`, or null while the gate (`geideaConfig`) is closed. The configuration, secrets included,
 * stays inside these closures: the object carries no key. Saved-card renewals need `GEIDEA_MIT=1`; without it
 * `savedCard` is null and a due month goes past due for the owner to pay from the billing page.
 */
export function geideaProvider(): PaymentProvider | null {
  const cfg = geideaConfig();
  if (!cfg) return null;
  return {
    name: "geidea",
    live: cfg.live,
    async createCheckout(i) {
      return { orderId: null, url: hostedPageUrl(await createSession(cfg, i)) };
    },
    savedCard: cfg.mit ? {
      async prepare(i, card) {
        if (!card || !card.agreementId) throw new GeideaError("no_agreement");
        return { orderId: null, paymentKey: await createSession(cfg, { ...i, merchant: { token: card.token, agreementId: card.agreementId } }) };
      },
      charge: (sessionId, token, agreementId) => payWithToken(cfg, sessionId, token, agreementId),
    } : null,
    parseEvent,
    verifyWebhook: (e) => verifyCallback(e.obj, cfg.publicKey, cfg.apiPassword),
    parseTransaction: parseOrder,
    parseCardToken: () => null,
    refund: (id, amountCents) => refundOrder(cfg, String(id), amountCents),
    fetchByReference: (ref) => fetchOrderByReference(cfg, ref),
  };
}
