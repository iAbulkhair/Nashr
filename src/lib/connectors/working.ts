/**
 * Which connectors do something once connected. A provider can verify and store a connection without any code
 * that uses it; the app must not call such a connection "Connected" or read numbers from it.
 * - WORKING_PROVIDERS: publishTask in publish.ts (wordpress, shopify, telegram, x, and meta for facebook and
 *   instagram) and the import_products action
 *   in api/connect/[provider] (shopify, woocommerce, odoo, prestashop, salla). tests/connectors-working.test.ts keeps
 *   this list equal to those two code paths.
 * - READS_METRICS: providers whose orders, revenue, traffic, ad spend or audience the Reports page reads: the stores
 *   the store-sales sync reads (SALES_PROVIDERS in sales.ts; the test keeps the two equal). src/lib/stats.ts still reads
 *   no connection: store numbers come from the synced snapshot.
 * No imports, so client components can use it.
 */
export const WORKING_PROVIDERS: readonly string[] = ["wordpress", "shopify", "telegram", "x", "woocommerce", "odoo", "prestashop", "salla", "meta"];
export const READS_METRICS: readonly string[] = ["salla", "shopify"];
export const isWorking = (id: string) => WORKING_PROVIDERS.includes(id);
