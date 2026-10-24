import { geideaProvider } from "../geidea";
import { log } from "../log";
import { paymobProvider } from "../paymob";
import type { PaymentProvider, ProviderName } from "./provider";

export { PaymentDeclined, PaymentError, type CardTokenEvent, type Checkout, type CheckoutInput, type PaymentProvider, type PaymentTxn, type ProviderName, type SavedCardIntent, type TxnCard, type WebhookEvent } from "./provider";

let warnedBoth = false;
/**
 * The one place the payment provider is chosen (rules 2050, 3900). Geidea when its gate is open (`GEIDEA_PUBLIC_KEY` and
 * `GEIDEA_API_PASSWORD`, and `GEIDEA_LIVE=1` only on the production deploy), else Paymob KSA exactly as before: null until
 * every PAYMOB_* variable its gate needs is set (and PAYMOB_LIVE=1 for live keys, rule 700). With both set Geidea wins and
 * `payment_provider_both_set` is logged once. Read per call, like the gates themselves. Nothing outside src/lib/payments,
 * src/lib/paymob.ts and src/lib/geidea.ts imports a provider module. Both adapters carry `CheckoutInput.interval` (yearly
 * billing, rules 3539-3540, flows.md section 110 item 7).
 */
export function paymentProvider(): PaymentProvider | null {
  const geidea = geideaProvider();
  if (!geidea) return paymobProvider();
  if (!warnedBoth && paymobProvider()) {
    warnedBoth = true;
    log.error("payment_provider_both_set: Geidea and Paymob are both configured; Geidea is used");
  }
  return geidea;
}

/** The chosen provider's name, or null while online payments are off. */
export const activeProvider = (): ProviderName | null => paymentProvider()?.name ?? null;

/** Online payments are on: what the routes and pages ask before they offer or accept one. */
export const paymentsEnabled = () => paymentProvider() !== null;
