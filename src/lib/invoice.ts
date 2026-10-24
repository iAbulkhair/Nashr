/**
 * The ZATCA e-invoicing seam (spec docs/superpowers/specs/2026-10-08-paymob-billing-design.md section 7). Called once per
 * online payment applied (a plan's first month, a renewal, a top-up pack), right after the payment is recorded, with
 * everything a tax invoice needs. Today it issues nothing and returns null: phase 2 (Fatoora) plugs a provider in here
 * without moving the call site. It must stay idempotent on `paymentId`, because a retried callback can call it again.
 */
export type InvoiceEvent = {
  email: string;
  paymentId: string;
  kind: "plan" | "renewal" | "topup";
  /** Halalas, before VAT. */
  baseHalalas: number;
  vatHalalas: number;
  totalHalalas: number;
  currency: "SAR";
  provider: "paymob" | "geidea";
  /** The provider's transaction id. */
  providerRef: string;
  /** Riyadh day of the payment, YYYY-MM-DD. */
  day: string;
};

export async function invoiceForPayment(event: InvoiceEvent): Promise<null> {
  void event;
  return null;
}
