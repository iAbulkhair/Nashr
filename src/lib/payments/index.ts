import { paymobProvider } from "../paymob";
import type { PaymentProvider } from "./provider";

export { PaymentError, type CardTokenEvent, type Checkout, type CheckoutInput, type PaymentProvider, type PaymentTxn, type SavedCardIntent, type WebhookEvent } from "./provider";

/**
 * The one place the payment provider is chosen (rule 2050). Paymob KSA is the only one, and it stays off exactly as
 * before: null until every PAYMOB_* variable its gate needs is set (and PAYMOB_LIVE=1 for live keys, rule 700). Read per
 * call, like the gate itself. Nothing outside src/lib/payments and src/lib/paymob.ts imports the Paymob module.
 */
export function paymentProvider(): PaymentProvider | null {
  return paymobProvider();
}

/** Online payments are on: what the routes and pages ask before they offer or accept one. */
export const paymentsEnabled = () => paymentProvider() !== null;
