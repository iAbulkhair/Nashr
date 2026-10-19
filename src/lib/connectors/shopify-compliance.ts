import { createHmac } from "crypto";
import { db, pushCapped } from "../db";
import { globalKey } from "../keys";
import { pmap } from "../parallel";
import { sameSecret } from "../rate";
import { dropSalesSnapshot } from "../store-sales";
import { SHOP_HOST, subscribeUninstall, UNINSTALL_HOOK_META, UNINSTALL_TRIED_META } from "./shopify";
import { deleteConnection, getConnection, listConnections, saveConnection } from "./store";

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
 * - `app/uninstalled` (rule 2203; not a compliance topic: subscribed per store by `subscribeUninstall` at connect): the
 *   store's token is dead from that moment, so the store joins the same pending list at once instead of 48 hours later,
 *   and the next stores run drops it the same way. The store comes from the shop body's `myshopify_domain`.
 *
 * Shopify signs each delivery with `X-Shopify-Hmac-Sha256`: base64 HMAC-SHA256 of the raw body with the app's secret.
 */

export const COMPLIANCE_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;
export type ComplianceTopic = (typeof COMPLIANCE_TOPICS)[number];
export const isComplianceTopic = (t: string | null): t is ComplianceTopic => (COMPLIANCE_TOPICS as readonly string[]).includes(t ?? "");
/** The app-lifecycle topic the same URL takes (rule 2203). */
export const UNINSTALL_TOPIC = "app/uninstalled";
export type ShopHookTopic = ComplianceTopic | typeof UNINSTALL_TOPIC;
export const isShopHookTopic = (t: string | null): t is ShopHookTopic => isComplianceTopic(t) || t === UNINSTALL_TOPIC;

/** Receipts kept for the founder: topic, store and time only. */
export const COMPLIANCE_LOG_CAP = 500;

/** True only when `given` is the base64 HMAC-SHA256 of the exact raw body under the app secret. */
export function validShopifyWebhook(raw: string, given: string | null, secret: string | undefined): boolean {
  if (!given || !secret) return false;
  return sameSecret(createHmac("sha256", secret).update(raw, "utf8").digest("base64"), given);
}

export type ComplianceReceipt = { topic: ShopHookTopic | "shop/redact:done"; shop: string; at: string; workspaces?: number };

/**
 * When the store's event happened (rule 2244): Shopify's `X-Shopify-Triggered-At` when it parses and is not later than
 * `now`, else `now`. A retry Shopify sends hours later keeps the event's own time, so an owner who connected the store
 * again in between is never taken for the uninstalled grant. The header is not signed; it can only move the time
 * earlier than the receipt, which drops fewer connections, never more.
 */
export function eventTime(triggeredAt: string | null | undefined, now: Date): string {
  const t = Date.parse(String(triggeredAt ?? ""));
  return Number.isFinite(t) && t <= now.getTime() ? new Date(t).toISOString() : now.toISOString();
}

/**
 * Records one verified delivery. Returns false for a body without a real *.myshopify.com `shop_domain` (or, for
 * `app/uninstalled`, `myshopify_domain`). Only the topic, the store and the time are kept: `customer`,
 * `orders_requested`, `orders_to_redact` and the shop's own fields are never read. The receipt carries the time it was
 * received; the pending store carries the event's time (`eventTime`, rule 2244) and never moves back.
 */
export async function recordCompliance(topic: ShopHookTopic, body: unknown, now = new Date(), triggeredAt?: string | null): Promise<boolean> {
  const b = body as { shop_domain?: unknown; myshopify_domain?: unknown } | null;
  const raw = topic === UNINSTALL_TOPIC ? b?.myshopify_domain : b?.shop_domain;
  const shop = typeof raw === "string" ? raw.toLowerCase() : "";
  if (!SHOP_HOST.test(shop)) return false;
  const at = now.toISOString();
  const pending = topic === "shop/redact" || topic === UNINSTALL_TOPIC;
  // The pending list is small and its key is fixed: one read of it, so an older retry cannot move a later time back.
  const held = pending ? (await db.hgetall<string>(globalKey.shopifyRedact()))[shop] : undefined;
  const event = eventTime(triggeredAt, now);
  const keep = held && Date.parse(String(held)) > Date.parse(event) ? String(held) : event;
  await Promise.all([
    pushCapped(globalKey.shopifyCompliance(), JSON.stringify({ topic, shop, at } satisfies ComplianceReceipt), COMPLIANCE_LOG_CAP),
    // The field is the store, the key is fixed.
    pending ? db.hset(globalKey.shopifyRedact(), shop, keep) : null,
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

/** Stores subscribed to `app/uninstalled` by one stores run at most (rule 2204): two Shopify calls each. */
export const HOOKS_PER_RUN = 30;
export type HookBackfill = { due: number; subscribed: number; failed: number };

/**
 * Subscribes `app/uninstalled` (rule 2203) for the Shopify connections of the workspaces given (the cron's roster) that
 * do not carry the mark yet: those made before rule 2203, and those whose subscription failed at connect. A connection
 * that must reconnect or runs through Composio is left alone. At most HOOKS_PER_RUN a run, six at a time; the mark is
 * saved only when the store answered and the connection read back is still the same grant (same `connectedAt`, no
 * mark), so a reconnect in between is never overwritten. A failure is retried by the next run. No store is started
 * at or after `deadline` (epoch ms, rule 2208), so a slow platform cannot eat the syncs' time; those wait for a later run.
 * A failed store gets the time of the attempt (`uninstallHookTried`, same-grant check), and the stores never tried come
 * first, then the ones tried longest ago (rule 2209), so stores that keep failing cannot take every run's slots.
 */
export async function backfillUninstallHooks(scopes: readonly string[], origin: string, now = new Date(), deadline = Infinity): Promise<HookBackfill> {
  const lists = await pmap(scopes, (scope) => listConnections(scope));
  const due = scopes.flatMap((scope, i) => {
    const c = (lists[i] ?? []).find((x) => x.provider === "shopify");
    return c && SHOP_HOST.test(String(c.meta?.shop ?? "")) && !c.meta?.[UNINSTALL_HOOK_META] && !c.needsReconnect && c.meta?.via !== "composio" ? [{ scope, connectedAt: c.connectedAt, tried: String(c.meta?.[UNINSTALL_TRIED_META] ?? "") }] : [];
  });
  // Never tried ("") first, then the oldest attempt; a stable sort keeps the roster's order among equals.
  due.sort((a, b) => (a.tried < b.tried ? -1 : a.tried > b.tried ? 1 : 0));
  const results = await pmap(due.slice(0, HOOKS_PER_RUN), async ({ scope, connectedAt }) => {
    if (Date.now() >= deadline) return "late" as const;
    const conn = await getConnection(scope, "shopify");
    if (!conn || conn.connectedAt !== connectedAt || conn.meta?.[UNINSTALL_HOOK_META]) return "skip" as const;
    const ok = await subscribeUninstall(conn, origin);
    const again = await getConnection(scope, "shopify");
    if (!again || again.connectedAt !== connectedAt || again.meta?.[UNINSTALL_HOOK_META]) return ok ? ("skip" as const) : ("failed" as const);
    const meta = { ...again.meta };
    delete meta[UNINSTALL_TRIED_META];
    await saveConnection(scope, { ...again, meta: ok ? { ...meta, [UNINSTALL_HOOK_META]: now.toISOString() } : { ...meta, [UNINSTALL_TRIED_META]: now.toISOString() } });
    return ok ? ("subscribed" as const) : ("failed" as const);
  }, 6);
  return { due: due.length, subscribed: results.filter((r) => r === "subscribed").length, failed: results.filter((r) => r === "failed").length };
}

/** Receipts the founder console shows (rule 2173): the newest ones, plus every store still waiting for a stores run. */
export const COMPLIANCE_SHOWN = 10;
export type ComplianceSummary = { pending: { shop: string; at: string }[]; recent: ComplianceReceipt[] };

/** Two reads of the two fixed keys. Stores and times only, as recorded; a row that does not parse is left out. */
export async function complianceSummary(): Promise<ComplianceSummary> {
  const [pending, rows] = await Promise.all([db.hgetall<string>(globalKey.shopifyRedact()), db.lrange(globalKey.shopifyCompliance(), 0, COMPLIANCE_SHOWN - 1)]);
  const recent = rows.flatMap((r) => {
    try {
      const x = JSON.parse(r) as ComplianceReceipt;
      return typeof x?.topic === "string" && SHOP_HOST.test(String(x.shop)) ? [{ topic: x.topic, shop: x.shop, at: String(x.at), ...(typeof x.workspaces === "number" ? { workspaces: x.workspaces } : {}) }] : [];
    } catch {
      return [];
    }
  });
  return {
    pending: Object.entries(pending).filter(([shop]) => SHOP_HOST.test(shop)).map(([shop, at]) => ({ shop, at: String(at) })).sort((a, b) => a.at.localeCompare(b.at)),
    recent,
  };
}
