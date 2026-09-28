import type { Connection } from "./store";
import { SHOP_HOST } from "./shopify";
import { ZID_API, zidHeaders } from "./zid";
import { safeFetch } from "../safe-fetch";

/**
 * Order readers: how many orders a connected store took in a window, and what they came to. Every reader returns the
 * same row shape and `totals` does the arithmetic, so a platform's quirks stay in its reader.
 *
 * - Cancelled, refunded, failed and test orders are counted as void: they are neither orders nor revenue.
 * - Revenue is kept per currency. A store that sells in two currencies shows two amounts, never a sum of both.
 * - A reader stops after MAX_PAGES pages or BUDGET_MS. When it stops with pages left, the result is `partial` and the page says
 *   "at least"; it never presents a truncated count as the whole.
 * - Every URL is built on the platform's fixed host (the shop's own host for Shopify, the owner's site through
 *   safeFetch for WooCommerce). A pagination link in an answer is read for its cursor only, never followed as a URL.
 */
export type OrderRow = { at: string; total: number; currency: string; void: boolean };
export type OrderRead = { rows: OrderRow[]; partial: boolean };
export type Totals = { orders: number; revenue: Record<string, number> };

/** The platforms that have a reader. READS_METRICS in working.ts is kept equal to this list by a test. */
export const ORDER_READERS = ["salla", "zid", "shopify", "woocommerce"] as const;

const MAX_PAGES = 20;
const TIMEOUT_MS = 6000;
/** Reports waits on this read, so a slow store ends it early (as partial) instead of holding the page. */
const BUDGET_MS = 10_000;
const VOID = /cancel|refund|revers|restor|fail|void|trash|draft/i;

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * "2026-09-01 14:05:00" with no zone is store time. Salla and Zid stores are in the Gulf, and both platforms answer in
 * Asia/Riyadh (UTC+3), so a bare timestamp is read as +03:00. A timestamp with a zone keeps its own.
 */
export function storeTime(s: string | undefined | null, zone = "+03:00"): string {
  if (!s) return "";
  const t = s.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}${zone}`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}

/** Orders and revenue for rows inside [from, to]; void rows and rows with no readable date are left out. */
export function totals(rows: OrderRow[], from: Date, to: Date): Totals {
  const out: Totals = { orders: 0, revenue: {} };
  for (const r of rows) {
    const t = new Date(r.at).getTime();
    if (r.void || !Number.isFinite(t) || t < from.getTime() || t > to.getTime()) continue;
    out.orders++;
    // A currency code comes from the store's API and reaches Dana's prompt: only a three-letter code passes.
    const cur = /^[A-Za-z]{3}$/.test(r.currency) ? r.currency.toUpperCase() : "?";
    out.revenue[cur] = Math.round(((out.revenue[cur] ?? 0) + r.total) * 100) / 100;
  }
  return out;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const get = (url: string, headers: Record<string, string>) => fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });

/** Orders created from `from` to `to`, read from the platform behind the connection. */
export async function readOrders(c: Connection, from: Date, to: Date): Promise<OrderRead> {
  const end = Date.now() + BUDGET_MS;
  switch (c.provider) {
    case "salla":
      return readSalla(c, from, to, end);
    case "zid":
      return readZid(c, from, end);
    case "shopify":
      return readShopify(c, from, to, end);
    case "woocommerce":
      return readWoo(c, from, to, end);
    default:
      throw new Error("no_order_reader");
  }
}

type SallaOrder = { date?: { date?: string } | string; total?: { amount?: number | string; currency?: string }; amounts?: { total?: { amount?: number | string; currency?: string } }; currency?: string; status?: { slug?: string; name?: string } };
async function readSalla(c: Connection, from: Date, to: Date, end: number): Promise<OrderRead> {
  const rows: OrderRow[] = [];
  const h = { Authorization: `Bearer ${c.data.access_token}`, Accept: "application/json" };
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1 && Date.now() > end) break;
    const r = await get(`https://api.salla.dev/admin/v2/orders?page=${page}&per_page=50&from_date=${day(from)}&to_date=${day(to)}`, h);
    if (!r.ok) throw new Error(`salla ${r.status}`);
    const j = (await r.json()) as { data?: SallaOrder[]; pagination?: { currentPage?: number; totalPages?: number } };
    for (const o of j.data ?? []) {
      const total = o.total ?? o.amounts?.total;
      rows.push({ at: storeTime(typeof o.date === "string" ? o.date : o.date?.date), total: num(total?.amount), currency: total?.currency ?? o.currency ?? "SAR", void: VOID.test(`${o.status?.slug ?? ""} ${o.status?.name ?? ""}`) });
    }
    const cur = j.pagination?.currentPage ?? page, last = j.pagination?.totalPages ?? cur;
    if (cur >= last || !j.data?.length) return { rows, partial: false };
  }
  return { rows, partial: true };
}

type ZidOrder = { created_at?: string; order_total?: number | string; currency_code?: string; order_status?: { code?: string; name?: string } | string };
/**
 * Zid's list is read newest first and filtered here by date: its date filters are not relied on. Reading stops at the
 * first page that reaches past `from`.
 */
async function readZid(c: Connection, from: Date, end: number): Promise<OrderRead> {
  const rows: OrderRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1 && Date.now() > end) break;
    const r = await get(`${ZID_API}/managers/store/orders?page=${page}&per_page=50`, zidHeaders(c));
    if (!r.ok) throw new Error(`zid ${r.status}`);
    const j = (await r.json()) as { orders?: ZidOrder[]; total_order_count?: number; last_page?: number };
    const list = j.orders ?? [];
    for (const o of list) {
      const st = typeof o.order_status === "string" ? o.order_status : `${o.order_status?.code ?? ""} ${o.order_status?.name ?? ""}`;
      rows.push({ at: storeTime(o.created_at), total: num(o.order_total), currency: o.currency_code ?? "SAR", void: VOID.test(st) });
    }
    const oldest = Math.min(...list.map((o) => new Date(storeTime(o.created_at) || 0).getTime()));
    if (!list.length || oldest < from.getTime() || (j.last_page != null && page >= j.last_page)) return { rows, partial: false };
  }
  return { rows, partial: true };
}

/** A partially refunded Shopify order is still an order; only a full refund or a void takes it out. */
type ShopifyOrder = { created_at?: string; total_price?: string; currency?: string; cancelled_at?: string | null; financial_status?: string; test?: boolean };
/** Without Shopify's read_all_orders scope the API answers the last 60 days only; older windows read as partial. */
async function readShopify(c: Connection, from: Date, to: Date, end: number): Promise<OrderRead> {
  const shop = c.meta?.shop ?? "";
  if (!SHOP_HOST.test(shop)) throw new Error("shopify bad_shop");
  const base = `https://${shop}/admin/api/2024-10/orders.json`;
  const fields = "created_at,total_price,currency,cancelled_at,financial_status,test";
  let url = `${base}?status=any&limit=250&created_at_min=${from.toISOString()}&created_at_max=${to.toISOString()}&fields=${fields}`;
  const rows: OrderRow[] = [];
  const partial = from.getTime() < Date.now() - 60 * 864e5;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1 && Date.now() > end) break;
    const r = await get(url, { "X-Shopify-Access-Token": c.data.access_token, Accept: "application/json" });
    if (!r.ok) throw new Error(`shopify ${r.status}`);
    const j = (await r.json()) as { orders?: ShopifyOrder[] };
    for (const o of j.orders ?? []) rows.push({ at: o.created_at ?? "", total: num(o.total_price), currency: o.currency ?? "", void: !!o.cancelled_at || !!o.test || /^(refunded|voided)$/.test(o.financial_status ?? "") });
    const next = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(r.headers.get("link") ?? "")?.[1];
    if (!next) return { rows, partial };
    // Shopify's cursor pages carry only limit, fields and page_info; the filters live inside the cursor.
    url = `${base}?limit=250&fields=${fields}&page_info=${encodeURIComponent(decodeURIComponent(next))}`;
  }
  return { rows, partial: true };
}

type WooOrder = { date_created_gmt?: string; total?: string; currency?: string; status?: string };
async function readWoo(c: Connection, from: Date, to: Date, end: number): Promise<OrderRead> {
  const site = (c.data.site ?? "").replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`${c.data.consumerKey}:${c.data.consumerSecret}`).toString("base64");
  const rows: OrderRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1 && Date.now() > end) break;
    const r = await safeFetch(`${site}/wp-json/wc/v3/orders?per_page=100&page=${page}&after=${from.toISOString()}&before=${to.toISOString()}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`woo ${r.status}`);
    const list = (await r.json()) as WooOrder[];
    for (const o of list) rows.push({ at: o.date_created_gmt ? storeTime(o.date_created_gmt, "Z") : "", total: num(o.total), currency: o.currency ?? "", void: VOID.test(o.status ?? "") });
    const pages = Number(r.headers.get("x-wp-totalpages") ?? page);
    if (!list.length || page >= pages) return { rows, partial: false };
  }
  return { rows, partial: true };
}
