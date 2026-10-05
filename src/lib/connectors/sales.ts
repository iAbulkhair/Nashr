/**
 * Store sales as totals, shared by the store connectors that read orders and abandoned carts (Salla, Shopify, WooCommerce, Zid).
 * Only counts, money and product names leave a connector: never a customer's name, phone, email, address or
 * checkout link. No imports, so client components can use the type and the formatting.
 */

export const SALES_DAYS = 30;
export const SALES_PROVIDERS = ["salla", "shopify", "woocommerce", "zid"] as const;
export type SalesProvider = (typeof SALES_PROVIDERS)[number];
export const PROVIDER_NAME: Record<SalesProvider, string> = { salla: "Salla", shopify: "Shopify", woocommerce: "WooCommerce", zid: "Zid" };

export type SalesSnapshot = {
  provider: SalesProvider;
  at: string;
  days: number;
  /** `capped`: the store has more orders in the window than the sync reads, and it could not say how many. `pending`:
   * orders still awaiting payment (WooCommerce): counted in `count`, left out of `revenue` until the store marks them paid. */
  orders: { count: number; read: number; canceled: number; revenue: Record<string, number>; top: { name: string; qty: number }[]; capped?: boolean; pending?: number };
  /** `capped`: the store has more open carts than the sync reads, and it could not say how many. `unavailable`: the
   * store refused the app access to its carts, or has no cart data at all (WooCommerce), so nothing about them is known
   * (not zero). */
  carts: { count: number; read: number; value: Record<string, number>; top: { name: string; qty: number }[]; capped?: boolean; unavailable?: boolean };
  /** Records whose total could not be read: a non-zero value means the platform's shape differs from what the code expects. */
  unread: number;
};

/** A money amount read from a number or a string such as "1,250.00". Missing or unreadable is null, never 0. */
export function amountOf(raw: unknown, currency: string): { amount: number; currency: string } | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? { amount: raw, currency } : null;
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/[^\d.-]/g, "");
  if (!/\d/.test(clean)) return null;
  const amount = Number(clean);
  return Number.isFinite(amount) ? { amount, currency } : null;
}

export type Line = { name?: string; title?: string; quantity?: number | string; product?: { name?: string } };

/** Adds each line's quantity to its product name. A line with no name is skipped; a missing quantity counts as 1. */
export function tally(lines: Line[] | undefined, into: Map<string, number>) {
  for (const l of lines ?? []) {
    const name = (l.name ?? l.title ?? l.product?.name ?? "").trim();
    if (!name) continue;
    const q = Number(l.quantity ?? 1);
    into.set(name, (into.get(name) ?? 0) + (Number.isFinite(q) && q > 0 ? q : 1));
  }
}
export const topOf = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, qty]) => ({ name, qty }));
export const addTo = (into: Record<string, number>, a: { amount: number; currency: string }) => { into[a.currency] = Math.round(((into[a.currency] ?? 0) + a.amount) * 100) / 100; };

/** 12345.5 → "12,345.5": plain grouping, the same on the server and in every browser. */
export const grouped = (v: number) => { const [i, f] = String(v).split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? `.${f}` : ""); };
export const moneyText = (r: Record<string, number>) => Object.entries(r).map(([cur, v]) => `${grouped(v)}${cur ? ` ${cur}` : ""}`).join(" + ") || "0";

/** The snapshot as Noor reads it in store-sales.md: aggregates only, and it says when it is partial. */
export function salesMarkdown(s: SalesSnapshot, store?: string) {
  const partialOrders = s.orders.capped ? ` or more (totals below cover the latest ${s.orders.read})` : s.orders.read < s.orders.count ? ` (totals below cover the latest ${s.orders.read} of ${s.orders.count})` : "";
  const partialCarts = s.carts.capped ? ` or more (totals below cover the latest ${s.carts.read})` : s.carts.read < s.carts.count ? ` (totals below cover the latest ${s.carts.read} of ${s.carts.count})` : "";
  return [
    `# Store sales (${PROVIDER_NAME[s.provider]}${store ? ` ${store}` : ""}, last ${s.days} days, synced ${s.at.slice(0, 10)})`,
    "",
    "Totals read from the store. No customer details are stored here. Use these numbers as they are; do not extrapolate them.",
    "",
    `## Orders`,
    `- Orders: ${s.orders.count}${partialOrders}`,
    `- Revenue (excluding ${s.orders.canceled} canceled or refunded): ${moneyText(s.orders.revenue)}`,
    ...(s.orders.pending ? [`- ${s.orders.pending} orders are still awaiting payment: they are in the order count and not in the revenue.`] : []),
    ...(s.orders.top.length ? ["- Best sellers by quantity:", ...s.orders.top.map((t) => `  - ${t.name}: ${t.qty}`)] : []),
    "",
    `## Abandoned carts`,
    ...(s.carts.unavailable
      ? [s.provider === "woocommerce"
          ? "- Not available: WooCommerce does not record abandoned carts. Their number and value are unknown, not zero."
          : "- Not available: the store did not give the app access to its abandoned carts. Their number and value are unknown, not zero."]
      : [`- Open abandoned carts: ${s.carts.count}${partialCarts}`, `- Value left in them: ${moneyText(s.carts.value)}`]),
    ...(s.carts.top.length ? ["- Products most often left in carts:", ...s.carts.top.map((t) => `  - ${t.name}: ${t.qty}`)] : []),
  ].join("\n");
}
