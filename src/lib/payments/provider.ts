/**
 * The payment provider seam (rules 2050-2057, `flows.md` section 83). Billing (src/lib/billing.ts) talks to a card
 * processor only through this type: start a checkout, prepare and charge a saved card, read and verify a callback,
 * refund. The shape follows the idea of supastarter's payments package (one provider type, one implementation chosen in
 * one place); none of its code is used. Paymob KSA (src/lib/paymob.ts) is the only implementation, chosen in
 * src/lib/payments/index.ts.
 *
 * What stays in billing and never moves into a provider: the amount check against our own price (`priceFor`), the
 * account taken from our own intent record and never from a callback, and exactly-once handling per transaction id.
 * A provider answers what the processor said; billing decides what it means.
 */

/** What we ask the processor to charge. The amount comes from src/lib/pricing.ts, never from a request. */
export type CheckoutInput = {
  amountCents: number;
  item: { name: string; description: string };
  billing: { firstName: string; lastName: string; email: string; phone: string };
  /** Our random reference, echoed back on the transaction. */
  reference: string;
  notificationUrl: string;
  redirectionUrl: string;
  expirationS: number;
};

/** A hosted checkout: the page the owner pays on, and the processor's order for our pointer. */
export type Checkout = { orderId: number; url: string };
/** A saved-card charge prepared at the processor: its order, and the one-time key the charge uses (null when none came back). */
export type SavedCardIntent = { orderId: number; paymentKey: string | null };

/** A transaction as billing uses it, from a verified callback or from our own charge call. */
export type PaymentTxn = {
  id: number;
  success: boolean;
  pending: boolean;
  amountCents: number;
  currency: string;
  orderId: number | null;
  /** Our reference, as the processor echoes it. */
  ref: string | null;
  isRefunded: boolean;
  isVoided: boolean;
  hasParent: boolean;
  /** Whether the processor says the transaction is live; null when it does not say. */
  isLive: boolean | null;
};

/** A callback's envelope: a transaction, or a card the processor saved for later charges. Nothing in it is trusted yet. */
export type WebhookEvent = { kind: "transaction" | "card_token"; obj: Record<string, unknown> };

/** A saved card from a verified card-token callback. The token never leaves billing's card record. */
export type CardTokenEvent = { orderId: number; token: string; email: string; last4: string; brand: string; expMonth: string; expYear: string };

export interface PaymentProvider {
  /** Also the `billing.provider` value stored on the account. */
  readonly name: "paymob";
  /** The keys are live (real money). A transaction whose own live flag disagrees is a mismatch. */
  readonly live: boolean;
  /** The hosted checkout for a plan month or a pack. */
  createCheckout(i: CheckoutInput): Promise<Checkout>;
  /** Merchant-initiated renewals with a saved card; null when this deployment cannot charge one. */
  readonly savedCard: {
    prepare(i: CheckoutInput): Promise<SavedCardIntent>;
    charge(paymentKey: string, cardToken: string): Promise<PaymentTxn | null>;
  } | null;
  /** The callback's envelope, or null for a body that is not one. Says nothing about who sent it. */
  parseEvent(body: unknown): WebhookEvent | null;
  /** True only when the signature matches the event, compared in constant time. Nothing of the event is used before. */
  verifyWebhook(e: WebhookEvent, signature: unknown): boolean;
  parseTransaction(obj: unknown): PaymentTxn | null;
  parseCardToken(obj: Record<string, unknown>): CardTokenEvent | null;
  /** Refund `amountCents` of a transaction. Throws a PaymentError when the processor refuses. */
  refund(txnId: number, amountCents: number): Promise<void>;
}

/** A provider failure: a short code and the HTTP status only, never a secret, a URL or a processor body. */
export class PaymentError extends Error {
  constructor(public provider: PaymentProvider["name"], public code: string, public status = 0) {
    super(`${provider}_${code}${status ? `:${status}` : ""}`);
    this.name = "PaymentError";
  }
}
