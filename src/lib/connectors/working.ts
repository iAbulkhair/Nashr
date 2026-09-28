/**
 * Which connectors do something once connected. A provider can verify and store a connection without any code
 * that uses it; the app must not call such a connection "Connected" or read numbers from it.
 * - WORKING_PROVIDERS: publishTask in publish.ts (wordpress, shopify, telegram, x) and the import_products action
 *   in api/connect/[provider] (shopify, woocommerce, odoo, prestashop, salla, zid). tests/connectors-working.test.ts keeps
 *   this list equal to those two code paths.
 * - READS_METRICS: providers whose orders, revenue, traffic, ad spend or audience the Reports page reads: the stores
 *   with an order reader in orders.ts (ORDER_READERS). src/lib/stats.ts still reads only workspace data; store numbers
 *   come from src/lib/store-metrics.ts.
 * No imports, so client components can use it.
 */
export const WORKING_PROVIDERS: readonly string[] = ["wordpress", "shopify", "telegram", "x", "woocommerce", "odoo", "prestashop", "salla", "zid"];
export const READS_METRICS: readonly string[] = ["salla", "zid", "shopify", "woocommerce"];
/** Stores whose products the Integrations card can import (the import_products action). */
export const IMPORTS_PRODUCTS: readonly string[] = ["shopify", "woocommerce", "odoo", "prestashop", "salla", "zid"];
export const isWorking = (id: string) => WORKING_PROVIDERS.includes(id);
