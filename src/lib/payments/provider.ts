/**
 * The payment provider seam (rules 2050-2057, `flows.md` section 85). Billing (src/lib/billing.ts) talks to a card
 * processor only through this type: start a checkout, prepare and charge a saved card, read and verify a callback,
 * refund. The shape follows the idea of supastarter's payments package (one provider type, one implementation chosen in
 * one place); none of its code is used. Two implementations: Paymob KSA (src/lib/paymob.ts) and Geidea
 * (src/lib/geidea.ts, rules 3900-3917, spec docs/superpowers/specs/2026-10-18-geidea-payment-provider-design.md), chosen
 * in src/lib/payments/index.ts. Geidea's ids are UUID strings where Paymob's are integers, so ids are `number | string`.
 *
 * What stays in billing and never moves into a provider: the amount check against our own price (`priceFor`), the
 * account taken from our own intent record and never from a callback, and exactly-once handling per transaction id.
 * A provider answers what the processor said; billing decides what it means.
 */

/** What we ask the processor to charge. The amount comes from src/lib/pricing.ts, never from a request. */
export type CheckoutInput = {
  amountCents: number;
  item: { name: string; description: string };
  /** `phone` may be "" for a provider that does not need it (Geidea, rule 3902). */
  billing: { firstName: string; lastName: string; email: string; phone: string };
  /** The hosted page's language (Geidea). Paymob ignores it. */
  lang?: "ar" | "en";
  /** Our card-on-file agreement for a plan's first payment (Geidea `cofAgreement.id`, rule 3902). Paymob ignores it. */
  agreementId?: string;
  /** Our random reference, echoed back on the transaction. */
  reference: string;
  notificationUrl: string;
  redirectionUrl: string;
  expirationS: number;
};

export type ProviderName = "paymob" | "geidea";

/** A hosted checkout: the page the owner pays on, and the processor's order for our pointer (null: Geidea makes its order only when the customer pays). */
export type Checkout = { orderId: number | string | null; url: string };
/** A saved-card charge prepared at the processor: its order (null when none yet), and the one-time key the charge uses (Geidea: the session id; null when none came back). */
export type SavedCardIntent = { orderId: number | string | null; paymentKey: string | null };
/** A saved card that rides on a paid transaction (Geidea, rule 3906). The token never leaves billing's card record. */
export type TxnCard = { token: string; agreementId: string | null; last4: string; brand: string; expMonth: string; expYear: string };

/** A transaction as billing uses it, from a verified callback or from our own charge call. */
export type PaymentTxn = {
  id: number | string;
  success: boolean;
  pending: boolean;
  amountCents: number;
  currency: string;
  orderId: number | string | null;
  /** Our reference, as the processor echoes it. */
  ref: string | null;
  isRefunded: boolean;
  isVoided: boolean;
  hasParent: boolean;
  /** Whether the processor says the transaction is live; null when it does not say. */
  isLive: boolean | null;
  /** A card saved with this payment (Geidea's paid order carries it); absent when none. */
  card?: TxnCard;
  /** The card-on-file agreement the processor charged under (Geidea), or null when it does not say. */
  agreementId?: string | null;
};

/** A callback's envelope: a transaction, or a card the processor saved for later charges. Nothing in it is trusted yet. */
export type WebhookEvent = { kind: "transaction" | "card_token"; obj: Record<string, unknown> };

/** A saved card from a verified card-token callback. The token never leaves billing's card record. */
export type CardTokenEvent = { orderId: number; token: string; email: string; last4: string; brand: string; expMonth: string; expYear: string };

export interface PaymentProvider {
  /** Also the `billing.provider` value stored on the account. */
  readonly name: ProviderName;
  /** The keys are live (real money). A transaction whose own live flag disagrees is a mismatch. */
  readonly live: boolean;
  /** The hosted checkout for a plan month or a pack. */
  createCheckout(i: CheckoutInput): Promise<Checkout>;
  /** Merchant-initiated renewals with a saved card; null when this deployment cannot charge one. */
  readonly savedCard: {
    /** `card`: the saved card's token and agreement (Geidea's Merchant session names both; Paymob ignores it). */
    prepare(i: CheckoutInput, card?: { token: string; agreementId: string | null }): Promise<SavedCardIntent>;
    /** Throws `PaymentDeclined` for a definite refusal with no transaction (Geidea 750.005 / 750.006). */
    charge(paymentKey: string, cardToken: string, agreementId?: string | null): Promise<PaymentTxn | null>;
  } | null;
  /** The callback's envelope, or null for a body that is not one. Says nothing about who sent it. */
  parseEvent(body: unknown): WebhookEvent | null;
  /**
   * True only when the signature matches the event, compared in constant time. Nothing of the event is used before.
   * Paymob's signature comes in the query (`?hmac=`); Geidea's is inside the body, so it ignores the argument.
   */
  verifyWebhook(e: WebhookEvent, signature: unknown): boolean;
  parseTransaction(obj: unknown): PaymentTxn | null;
  parseCardToken(obj: Record<string, unknown>): CardTokenEvent | null;
  /** Refund `amountCents` of a transaction. Throws a PaymentError when the processor refuses. */
  refund(txnId: number | string, amountCents: number): Promise<void>;
  /** The order paid under our reference, asked of the processor with our own credentials (Geidea, rule 3909). Absent for Paymob. */
  fetchByReference?(ref: string): Promise<PaymentTxn | null>;
}

/** A provider failure: a short code and the HTTP status only, never a secret, a URL or a processor body. */
export class PaymentError extends Error {
  constructor(public provider: PaymentProvider["name"], public code: string, public status = 0) {
    super(`${provider}_${code}${status ? `:${status}` : ""}`);
    this.name = "PaymentError";
  }
}

/** A definite refusal of a saved-card charge with no transaction to apply (rule 3911): nothing was charged. */
export class PaymentDeclined extends PaymentError {
  constructor(provider: PaymentProvider["name"], public reason: string) {
    super(provider, `declined_${reason}`);
    this.name = "PaymentDeclined";
  }
}
