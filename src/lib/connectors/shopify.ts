import { createHmac } from "crypto";
import type { Connection } from "./store";
import { sameSecret } from "../rate";

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
import { mdToHtml } from "./wordpress";
import { SALES_DAYS, addTo, amountOf, tally, topOf, type SalesSnapshot } from "./sales";

const V = "2024-10";
const h = (c: Connection) => ({ "X-Shopify-Access-Token": c.data.access_token, "Content-Type": "application/json" });

export async function importShopify(email: string, c: Connection) {
  const r = await fetch(`https://${c.meta?.shop}/admin/api/${V}/products.json?limit=50&status=active`, { headers: h(c) });
  if (!r.ok) throw new Error(`shopify ${r.status}`);
  const j = (await r.json()) as { products: { title: string; handle: string; body_html?: string; variants: { price: string }[] }[] };
  const md = [`# Product catalog (Shopify ${c.meta?.shop}, ${new Date().toISOString().slice(0, 10)})`, "", ...j.products.map((p) => `- **${p.title}** — ${p.variants[0]?.price ?? ""}\n  ${(p.body_html ?? "").replace(/<[^>]+>/g, "").slice(0, 200)}\n  https://${c.meta?.shop}/products/${p.handle}`)].join("\n");
  await writeFile(email, "products.md", md, "noor");
  return j.products.length;
}

export async function publishShopifyArticle(c: Connection, post: { title: string; body: string; published?: boolean }) {
  const blogs = await fetch(`https://${c.meta?.shop}/admin/api/${V}/blogs.json`, { headers: h(c) });
  if (!blogs.ok) throw new Error(`shopify blogs ${blogs.status}`);
  const bj = (await blogs.json()) as { blogs: { id: number; handle: string }[] };
  const blog = bj.blogs[0];
  if (!blog) throw new Error("no blog on store");
  const r = await fetch(`https://${c.meta?.shop}/admin/api/${V}/blogs/${blog.id}/articles.json`, { method: "POST", headers: h(c), body: JSON.stringify({ article: { title: post.title, body_html: mdToHtml(post.body), published: post.published ?? false } }) });
  if (!r.ok) throw new Error(`shopify article ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { article: { id: number; handle: string } };
  return { id: String(j.article.id), url: `https://${c.meta?.shop}/blogs/${blog.handle}/${j.article.handle}` };
}

// ---------- Orders and abandoned checkouts: totals only ----------
//
// REST Admin endpoints, as Shopify's own @shopify/shopify-api library defines them: GET orders.json and
// orders/count.json (status, created_at_min, fields, limit up to 250) and GET checkouts.json, the abandoned checkouts
// (created_at_min, limit). Pages follow the cursor in the Link header; the next URL is rebuilt on the connected shop
// from its page_info alone, never followed as given. Orders are requested with `fields` so the response carries no
// customer, email or address at all; abandoned checkouts cannot be narrowed that way, so only their totals and line
// titles are read.

const ORDER_PAGES = 4;
const CHECKOUT_PAGES = 3;
const LIMIT = 250;
const ORDER_FIELDS = "id,current_total_price,total_price,currency,cancelled_at,financial_status,line_items";

type ShopifyLine = { title?: string; name?: string; quantity?: number };
type ShopifyOrder = { current_total_price?: string; total_price?: string; currency?: string; cancelled_at?: string | null; financial_status?: string | null; line_items?: ShopifyLine[] };
type ShopifyCheckout = { total_price?: string; currency?: string; completed_at?: string | null; line_items?: ShopifyLine[] };

/**
 * Shopify answers 403 when the app has not been granted protected customer data access to orders (Partner Dashboard →
 * API access), which a new connection cannot fix, so it must not be reported as a refused token. 401 is a dead token.
 */
export const ORDERS_ACCESS_DENIED = "orders_access_denied";
const salesError = (status: number) => new Error(status === 403 ? ORDERS_ACCESS_DENIED : `shopify ${status}`);

/** The page_info cursor of the rel="next" link, or null on the last page. */
export function nextPageInfo(link: string | null): string | null {
  for (const part of (link ?? "").split(",")) {
    if (!/rel="?next"?/.test(part)) continue;
    const url = part.match(/<([^>]+)>/)?.[1];
    if (!url) continue;
    try { return new URL(url).searchParams.get("page_info"); } catch { return null; }
  }
  return null;
}

async function shopifyPages<T>(c: Connection, resource: "orders" | "checkouts", first: URLSearchParams, keep: Record<string, string>, max: number): Promise<{ rows: T[]; more: boolean }> {
  const base = `https://${c.meta?.shop}/admin/api/${V}/${resource}.json`;
  const rows: T[] = [];
  let q = first;
  for (let page = 1; page <= max; page++) {
    const r = await fetch(`${base}?${q}`, { headers: h(c) });
    if (!r.ok) throw salesError(r.status);
    const j = (await r.json()) as Record<string, T[] | undefined>;
    rows.push(...(j[resource] ?? []));
    const next = nextPageInfo(r.headers.get("link"));
    if (!next) return { rows, more: false };
    // A cursor request takes only limit, page_info and fields: the filters travel inside the cursor.
    q = new URLSearchParams({ limit: String(LIMIT), page_info: next, ...keep });
  }
  return { rows, more: true };
}

/** Last 30 days of orders and of open abandoned checkouts, reduced to totals. */
export async function shopifySales(c: Connection, now = new Date()): Promise<SalesSnapshot> {
  if (!SHOP_HOST.test(String(c.meta?.shop ?? ""))) throw new Error("shopify shop");
  const since = new Date(now.getTime() - SALES_DAYS * 864e5).toISOString();
  const countUrl = `https://${c.meta?.shop}/admin/api/${V}/orders/count.json?${new URLSearchParams({ status: "any", created_at_min: since })}`;
  const [orders, checkouts, countRes] = await Promise.all([
    shopifyPages<ShopifyOrder>(c, "orders", new URLSearchParams({ status: "any", created_at_min: since, limit: String(LIMIT), fields: ORDER_FIELDS }), { fields: ORDER_FIELDS }, ORDER_PAGES),
    shopifyPages<ShopifyCheckout>(c, "checkouts", new URLSearchParams({ created_at_min: since, limit: String(LIMIT) }), {}, CHECKOUT_PAGES),
    fetch(countUrl, { headers: h(c) }),
  ]);
  if (!countRes.ok) throw salesError(countRes.status);
  const counted = ((await countRes.json().catch(() => null)) as { count?: number } | null)?.count;

  let unread = 0;
  let canceled = 0;
  const revenue: Record<string, number> = {};
  const sold = new Map<string, number>();
  for (const o of orders.rows) {
    if (o.cancelled_at || o.financial_status === "refunded" || o.financial_status === "voided") { canceled++; continue; }
    // current_total_price already reflects partial refunds, returns and order edits.
    const a = amountOf(o.current_total_price ?? o.total_price, o.currency ?? "");
    if (!a) { unread++; continue; }
    addTo(revenue, a);
    tally(o.line_items, sold);
  }
  const value: Record<string, number> = {};
  const left = new Map<string, number>();
  const open = checkouts.rows.filter((k) => !k.completed_at);
  for (const k of open) {
    const a = amountOf(k.total_price, k.currency ?? "");
    if (!a) { unread++; continue; }
    addTo(value, a);
    tally(k.line_items, left);
  }
  return {
    provider: "shopify",
    at: now.toISOString(),
    days: SALES_DAYS,
    orders: { count: typeof counted === "number" ? counted : orders.rows.length, read: orders.rows.length, canceled, revenue, top: topOf(sold) },
    carts: { count: open.length, read: open.length, value, top: topOf(left), ...(checkouts.more ? { capped: true } : {}) },
    unread,
  };
}
