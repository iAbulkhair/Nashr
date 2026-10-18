import { createHmac } from "crypto";
import { db, pushCapped } from "../db";
import { globalKey } from "../keys";
import { pmap } from "../parallel";
import { sameSecret } from "../rate";
import { dropSalesSnapshot } from "../store-sales";
import { SHOP_HOST } from "./shopify";
import { deleteConnection, listConnections } from "./store";

/**
 * Shopify's three mandatory compliance webhooks (rules 2168-2171, docs/system/tests/2160-integrations-panel-drift.md).
 * Every app in the Shopify App Store must answer them, holding customer data or not:
 *
 * - `customers/data_request` and `customers/redact`: Thakeen keeps no Shopify customer record. The orders and checkout
 *   queries in shopify.ts ask for no customer, email, phone or address field, and only totals and product titles are
 *   stored, so there is nothing to send or erase. The receipt is logged without the customer's id, email or phone.
 * - `shop/redact` (sent 48 hours after a store uninstalls the app): the store goes into a fixed pending list. The
 *   request never names a Redis key: the stores cron (src/app/api/cron/stores) walks every workspace from its own
 *   roster and drops the Shopify connection, sales snapshot and store-sales.md of each one whose own stored `meta.shop`
 *   is that store and that connected before the request (a store connected again since is a new grant).
 *
 * Shopify signs each delivery with `X-Shopify-Hmac-Sha256`: base64 HMAC-SHA256 of the raw body with the app's secret.
 */

export const COMPLIANCE_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;
export type ComplianceTopic = (typeof COMPLIANCE_TOPICS)[number];
export const isComplianceTopic = (t: string | null): t is ComplianceTopic => (COMPLIANCE_TOPICS as readonly string[]).includes(t ?? "");

/** Receipts kept for the founder: topic, store and time only. */
export const COMPLIANCE_LOG_CAP = 500;

/** True only when `given` is the base64 HMAC-SHA256 of the exact raw body under the app secret. */
export function validShopifyWebhook(raw: string, given: string | null, secret: string | undefined): boolean {
  if (!given || !secret) return false;
  return sameSecret(createHmac("sha256", secret).update(raw, "utf8").digest("base64"), given);
}

export type ComplianceReceipt = { topic: ComplianceTopic | "shop/redact:done"; shop: string; at: string; workspaces?: number };

/**
 * Records one verified delivery. Returns false for a body without a real *.myshopify.com `shop_domain`. Only the topic,
 * the store and the time are kept: `customer`, `orders_requested` and `orders_to_redact` are never read.
 */
export async function recordCompliance(topic: ComplianceTopic, body: unknown, now = new Date()): Promise<boolean> {
  const raw = (body as { shop_domain?: unknown } | null)?.shop_domain;
  const shop = typeof raw === "string" ? raw.toLowerCase() : "";
  if (!SHOP_HOST.test(shop)) return false;
  const at = now.toISOString();
  await Promise.all([
    pushCapped(globalKey.shopifyCompliance(), JSON.stringify({ topic, shop, at } satisfies ComplianceReceipt), COMPLIANCE_LOG_CAP),
    // A retried delivery only moves the time forward; the field is the store, the key is fixed.
    topic === "shop/redact" ? db.hset(globalKey.shopifyRedact(), shop, at) : null,
  ]);
  return true;
}

/**
 * Applies every pending `shop/redact` to the workspaces given (the cron's roster, active and idle). One read of the
 * pending list; nothing else runs when it is empty. A store leaves the list only after a pass over every workspace
 * finished, so a failed pass is retried by the next run. Returns how many workspaces lost a connection.
 */
export async function applyShopRedactions(scopes: readonly string[], now = new Date()): Promise<number> {
  const pending = await db.hgetall<string>(globalKey.shopifyRedact());
  const shops = Object.entries(pending).filter(([shop]) => SHOP_HOST.test(shop));
  if (!shops.length) return 0;
  const requested = new Map(shops.map(([shop, at]) => [shop, Date.parse(String(at))]));
  const hits = new Map<string, number>();
  const done = await pmap(scopes, async (scope) => {
    const conn = (await listConnections(scope)).find((c) => c.provider === "shopify");
    const shop = String(conn?.meta?.shop ?? "").toLowerCase();
    const at = requested.get(shop);
    if (!conn || at === undefined || !(Date.parse(conn.connectedAt) < at)) return false;
    await Promise.all([deleteConnection(scope, "shopify"), dropSalesSnapshot(scope, "shopify")]);
    hits.set(shop, (hits.get(shop) ?? 0) + 1);
    return true;
  });
  const stamp = now.toISOString();
  await Promise.all(shops.map(([shop]) => Promise.all([
    db.hdel(globalKey.shopifyRedact(), shop),
    pushCapped(globalKey.shopifyCompliance(), JSON.stringify({ topic: "shop/redact:done", shop, at: stamp, workspaces: hits.get(shop) ?? 0 } satisfies ComplianceReceipt), COMPLIANCE_LOG_CAP),
  ])));
  return done.filter(Boolean).length;
}
