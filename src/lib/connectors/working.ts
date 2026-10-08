/**
 * Which connectors do something once connected. A provider can verify and store a connection without any code
 * that uses it; the app must not call such a connection "Connected" or read numbers from it.
 * - WORKING_PROVIDERS: publishTask in publish.ts (wordpress, shopify, telegram, x, meta for facebook and instagram,
 *   linkedin and tiktok through Composio only, and the drafts: whatsapp templates and private youtube uploads through
 *   Composio, brevo and klaviyo email drafts by API key) and the import_products action
 *   in api/connect/[provider] (shopify, woocommerce, odoo, prestashop, salla, zid). tests/connectors-working.test.ts keeps
 *   this list equal to those two code paths.
 * - READS_METRICS: providers whose orders, revenue, traffic, ad spend or audience the Reports page reads: the stores
 *   the store-sales sync reads (SALES_PROVIDERS in sales.ts; the test keeps the two equal). src/lib/stats.ts still reads
 *   no connection: store numbers come from the synced snapshot. The ad accounts in READS_ADS are read too, into
 *   the campaign results card (src/lib/connectors/ads.ts), and Google in READS_SITE into the reports' site block.
 * No imports, so client components can use it.
 */
export const WORKING_PROVIDERS: readonly string[] = ["wordpress", "shopify", "telegram", "x", "woocommerce", "odoo", "prestashop", "salla", "zid", "meta", "linkedin", "tiktok", "whatsapp", "youtube", "brevo", "klaviyo"];
/** Stores whose products the Integrations card can import (the import_products action). */
export const IMPORTS_PRODUCTS: readonly string[] = ["shopify", "woocommerce", "odoo", "prestashop", "salla", "zid"];
/** Ad accounts whose results are read into the campaign results card (syncAds in src/lib/perf-store.ts). */
export const READS_ADS: readonly string[] = ["meta_ads", "snapchat", "google_ads", "tiktok_ads"];
/** Google Analytics 4 and Search Console, read into the reports' site block (syncSite in src/lib/site-stats.ts). */
export const READS_SITE: readonly string[] = ["google"];
/** Meta through Composio: Instagram account and post results, read into the reports' social block (src/lib/social-stats.ts). */
export const READS_SOCIAL: readonly string[] = ["meta"];
export const READS_METRICS: readonly string[] = ["salla", "shopify", "woocommerce", "zid", ...READS_ADS, ...READS_SITE, ...READS_SOCIAL];
export const isWorking = (id: string) => WORKING_PROVIDERS.includes(id);
