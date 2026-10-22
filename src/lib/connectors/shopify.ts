import { createHmac } from "crypto";
import { productsMarkdown } from "./products-md";
import { providerTimeout } from "../fetch-timeout";
import { PROVIDER_REPLY_BYTES, responseJson } from "../read-capped";
import type { Connection } from "./store";
import { sameSecret } from "../rate";
// A function import only (called at publish time), so the cycle with publish.ts is safe at module load.
import { plainTitle } from "./publish";

/** A real Shopify store domain; anything else must never become the host of an OAuth or API request. */
export const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Shopify signs every OAuth callback: HMAC-SHA256 with the app secret over every query parameter except `hmac` and
 * `signature`, sorted by key and joined as key=value with "&". A callback whose signature does not match did not come
 * from Shopify (#113).
 */
export function validShopifyHmac(query: URLSearchParams, secret: string | undefined): boolean {
  const given = query.get("hmac");
  if (!given || !secret) return false;
  const msg = [...query.entries()].filter(([k]) => k !== "hmac" && k !== "signature").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  return sameSecret(createHmac("sha256", secret).update(msg).digest("hex"), given);
}
import { writeFile } from "../files";
import { fileSrc } from "../ref-provenance";
import { mdToHtml } from "./wordpress";
import { SALES_DAYS, addTo, amountOf, tally, topOf, type SalesSnapshot } from "./sales";

/**
 * Shopify Admin GraphQL API. Shopify requires GraphQL for new public App Store apps (REST Admin is legacy), and each
 * version is supported for about a year: 2026-07 is the latest stable version in Shopify's own @shopify/shopify-api
 * 15.0.0. Every query below was validated against the Admin schema Shopify ships in @shopify/dev-mcp (2025-10, the
 * oldest version still supported) and uses no deprecated field.
 *
 * Requests go only to the connected shop's *.myshopify.com host, checked on every call.
 */
export const API_VERSION = "2026-07";

type GqlError = { message?: string; extensions?: { code?: string } };
type GqlResponse<T> = { data?: T; errors?: GqlError[] };

/**
 * Shopify answers 403 or an ACCESS_DENIED error when the app has not been granted protected customer data access to
 * orders (Partner Dashboard → API access), which a new connection cannot fix, so it must not be reported as a refused
 * token. HTTP 401 is a dead token and still asks for a reconnect.
 */
export const ORDERS_ACCESS_DENIED = "orders_access_denied";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One GraphQL call. A THROTTLED answer (the cost bucket is empty) is retried after a short wait, twice at most. */
export async function shopifyGql<T>(c: Connection, query: string, variables: Record<string, unknown> = {}, opts: { orders?: boolean; pause?: (ms: number) => Promise<unknown> } = {}): Promise<T> {
  const shop = String(c.meta?.shop ?? "");
  if (!SHOP_HOST.test(shop)) throw new Error("shopify shop");
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": c.data.access_token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: providerTimeout(),
    });
    if (r.status === 403 && opts.orders) throw new Error(ORDERS_ACCESS_DENIED);
    if (!r.ok) throw new Error(`shopify ${r.status}`);
    const j = (await responseJson(r, PROVIDER_REPLY_BYTES)) as GqlResponse<T>;
    const codes = (j.errors ?? []).map((e) => e.extensions?.code ?? "");
    if (codes.includes("THROTTLED") && attempt < 2) { await (opts.pause ?? wait)(2000); continue; }
    if (codes.includes("ACCESS_DENIED")) throw new Error(opts.orders ? ORDERS_ACCESS_DENIED : "shopify 403");
    if (j.errors?.length || !j.data) throw new Error(`shopify graphql: ${(j.errors?.[0]?.message ?? "no data").slice(0, 160)}`);
    return j.data;
  }
}

/** The one webhook URL of ours Shopify calls: compliance topics and `app/uninstalled` (rules 2168, 2203). */
export const SHOPIFY_HOOK_PATH = "/api/shopify/compliance";

const FIND_UNINSTALL = `query FindUninstall($uri: String!) {
  webhookSubscriptions(first: 1, topics: [APP_UNINSTALLED], uri: $uri) { nodes { id } }
}`;
const SUBSCRIBE_UNINSTALL = `mutation Subscribe($sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: $sub) { userErrors { message } }
}`;

/** The `meta` field a Shopify connection carries once its store is subscribed to `app/uninstalled` (rule 2204). */
export const UNINSTALL_HOOK_META = "uninstallHook";
/** When the stores run last failed to subscribe this store (rule 2209): orders the next runs, cleared on success. */
export const UNINSTALL_TRIED_META = "uninstallHookTried";

/**
 * Asks the store to tell us when it uninstalls the app (rule 2203), so the stores cron drops the dead connection within
 * hours instead of the 48 that `shop/redact` takes. Needs no scope. A store already subscribed to our URL (a reconnect,
 * or a second try) answers true without a second subscription (rule 2204). Best effort: false on any failure or
 * userError, never a throw, so a connect never fails because of it.
 */
export async function subscribeUninstall(c: Connection, origin: string): Promise<boolean> {
  try {
    const uri = `${origin}${SHOPIFY_HOOK_PATH}`;
    const found = await shopifyGql<{ webhookSubscriptions: { nodes: { id: string }[] } }>(c, FIND_UNINSTALL, { uri });
    if (found.webhookSubscriptions.nodes.length) return true;
    const d = await shopifyGql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(c, SUBSCRIBE_UNINSTALL, { sub: { uri } });
    return !d.webhookSubscriptionCreate.userErrors.length;
  } catch {
    return false;
  }
}

const PRODUCTS = `query Products($first: Int!) {
  products(first: $first, query: "status:active", sortKey: UPDATED_AT, reverse: true) {
    nodes { title handle description onlineStoreUrl priceRangeV2 { minVariantPrice { amount currencyCode } } }
  }
}`;
type ProductsData = { products: { nodes: { title: string; handle: string; description?: string; onlineStoreUrl?: string | null; priceRangeV2?: { minVariantPrice?: { amount: string; currencyCode: string } } }[] } };

export async function importShopify(email: string, c: Connection) {
  const d = await shopifyGql<ProductsData>(c, PRODUCTS, { first: 50 });
  const products = Array.isArray(d.products?.nodes) ? d.products.nodes : [];
  // Each field one capped line, links http(s) only (rule 2247).
  const { md, count } = productsMarkdown(`Product catalog (Shopify ${c.meta?.shop}, ${new Date().toISOString().slice(0, 10)})`, products.map((p) => {
    const m = p.priceRangeV2?.minVariantPrice;
    return { name: p.title, price: m ? `${m.amount} ${m.currencyCode}` : "", description: p.description, url: p.onlineStoreUrl ?? `https://${c.meta?.shop}/products/${p.handle}` };
  }));
  await writeFile(email, "products.md", md, "noor", { src: fileSrc("store") });
  return count;
}

const BLOG = `query Blog { shop { name } blogs(first: 1) { nodes { id handle } } }`;
const ARTICLE = `mutation Article($article: ArticleCreateInput!) {
  articleCreate(article: $article) { article { id handle } userErrors { field message } }
}`;

export async function publishShopifyArticle(c: Connection, post: { title: string; body: string; published?: boolean }) {
  const b = await shopifyGql<{ shop: { name: string }; blogs: { nodes: { id: string; handle: string }[] } }>(c, BLOG);
  const blog = b.blogs.nodes[0];
  if (!blog) throw new Error("no blog on store");
  const d = await shopifyGql<{ articleCreate: { article: { id: string; handle: string } | null; userErrors: { message: string }[] } }>(c, ARTICLE, {
    // Model text: a planted `<img onerror>` in the title must not reach a theme that prints it raw (rule 3010).
    article: { blogId: blog.id, title: plainTitle(post.title), body: mdToHtml(post.body), isPublished: post.published ?? false, author: { name: b.shop.name } },
  });
  const a = d.articleCreate.article;
  if (!a) throw new Error(`shopify article: ${(d.articleCreate.userErrors[0]?.message ?? "not created").slice(0, 160)}`);
  return { id: a.id.split("/").pop() ?? a.id, url: `https://${c.meta?.shop}/blogs/${blog.handle}/${a.handle}` };
}

// ---------- Orders and abandoned checkouts: totals only ----------
//
// The orders query asks for no customer, email or address field at all; abandoned checkouts are read for their
// totals and line titles only. The counts come from ordersCount and abandonedCheckoutsCount, so the card and the file
// say when the totals cover only part of the month. Each page asks for 5 line items per record to keep the query cost
// well under Shopify's per-query limit: product rankings count those lines.

const PAGE = 100;
const ORDER_PAGES = 5;
const CHECKOUT_PAGES = 3;

const ORDERS = `query Orders($first: Int!, $after: String, $q: String!) {
  orders(first: $first, after: $after, query: $q) {
    nodes { cancelledAt displayFinancialStatus currentTotalPriceSet { shopMoney { amount currencyCode } } lineItems(first: 5) { nodes { title quantity } } }
    pageInfo { hasNextPage endCursor }
  }
  ordersCount(query: $q, limit: null) { count }
}`;
const CHECKOUTS = `query Checkouts($first: Int!, $after: String, $q: String!) {
  abandonedCheckouts(first: $first, after: $after, query: $q) {
    nodes { completedAt totalPriceSet { shopMoney { amount currencyCode } } lineItems(first: 5) { nodes { title quantity } } }
    pageInfo { hasNextPage endCursor }
  }
  abandonedCheckoutsCount(query: $q, limit: null) { count }
}`;

type Money = { shopMoney?: { amount?: string; currencyCode?: string } };
type Lines = { nodes?: { title?: string | null; quantity?: number }[] };
type OrderNode = { cancelledAt?: string | null; displayFinancialStatus?: string | null; currentTotalPriceSet?: Money; lineItems?: Lines };
type CheckoutNode = { completedAt?: string | null; totalPriceSet?: Money; lineItems?: Lines };
type Page<N> = { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

async function allPages<N>(c: Connection, query: string, root: string, q: string, max: number, orders: boolean): Promise<{ rows: N[]; more: boolean; count: number | null }> {
  const rows: N[] = [];
  let after: string | null = null;
  let count: number | null = null;
  for (let page = 1; page <= max; page++) {
    const d: Record<string, unknown> = await shopifyGql<Record<string, unknown>>(c, query, { first: PAGE, after, q }, { orders });
    const conn = d[root] as Page<N>;
    count ??= (d[`${root}Count`] as { count?: number } | null)?.count ?? null;
    rows.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return { rows, more: false, count };
    after = conn.pageInfo.endCursor;
  }
  return { rows, more: true, count };
}

const money = (m?: Money) => amountOf(m?.shopMoney?.amount, m?.shopMoney?.currencyCode ?? "");
const lines = (l?: Lines) => (l?.nodes ?? []).map((n) => ({ title: n.title ?? undefined, quantity: n.quantity }));

/** Last 30 days of orders and of open abandoned checkouts, reduced to totals. */
export async function shopifySales(c: Connection, now = new Date()): Promise<SalesSnapshot> {
  const since = new Date(now.getTime() - SALES_DAYS * 864e5).toISOString();
  const [orders, checkouts] = await Promise.all([
    allPages<OrderNode>(c, ORDERS, "orders", `created_at:>='${since}'`, ORDER_PAGES, true),
    allPages<CheckoutNode>(c, CHECKOUTS, "abandonedCheckouts", `created_at:>='${since}' AND status:open`, CHECKOUT_PAGES, true),
  ]);

  let unread = 0;
  let canceled = 0;
  const revenue: Record<string, number> = {};
  const sold = new Map<string, number>();
  for (const o of orders.rows) {
    if (o.cancelledAt || o.displayFinancialStatus === "REFUNDED" || o.displayFinancialStatus === "VOIDED") { canceled++; continue; }
    // currentTotalPriceSet already reflects partial refunds, returns and order edits.
    const a = money(o.currentTotalPriceSet);
    if (!a) { unread++; continue; }
    addTo(revenue, a);
    tally(lines(o.lineItems), sold);
  }
  const value: Record<string, number> = {};
  const left = new Map<string, number>();
  const open = checkouts.rows.filter((k) => !k.completedAt);
  for (const k of open) {
    const a = money(k.totalPriceSet);
    if (!a) { unread++; continue; }
    addTo(value, a);
    tally(lines(k.lineItems), left);
  }
  return {
    provider: "shopify",
    at: now.toISOString(),
    days: SALES_DAYS,
    orders: { count: orders.count ?? orders.rows.length, read: orders.rows.length, canceled, revenue, top: topOf(sold) },
    carts: { count: checkouts.count ?? open.length, read: open.length, value, top: topOf(left), ...(checkouts.count == null && checkouts.more ? { capped: true } : {}) },
    unread,
  };
}
