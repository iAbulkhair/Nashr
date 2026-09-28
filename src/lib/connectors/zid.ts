import type { Connection } from "./store";
import { writeFile } from "../files";
import { pmap } from "../parallel";
import { SALES_DAYS, addTo, amountOf, tally, topOf, type Line, type SalesSnapshot } from "./sales";

/**
 * Zid Merchant API v1. Zid's token answer carries two tokens: `authorization` goes in the Authorization header as a
 * bearer, `access_token` goes in X-Manager-Token and names the store. Product calls also need the store id, which the
 * manager profile gives and the callback keeps in `meta.storeId`. The products list answers
 * `{ count, next, previous, results }`; orders and abandoned carts answer differently (see zidSales). The host is fixed,
 * never taken from a request or from a `next` link in an answer.
 */
export const ZID_API = "https://api.zid.sa/v1";
const PER_PAGE = 50;
/** Generation reads the first part of products.md; a catalog larger than this adds nothing to what Noor sees. */
const MAX_PAGES = 3;

type Text = string | { ar?: string; en?: string } | null | undefined;
type ZidProduct = {
  name?: Text;
  price?: number | string | null;
  sale_price?: number | string | null;
  currency?: string;
  description?: Text;
  html_url?: string;
  is_published?: boolean;
};

export function zidHeaders(c: Connection): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${c.data.authorization ?? ""}`, "X-Manager-Token": c.data.access_token ?? "", Role: "Manager", "Accept-Language": "ar", Accept: "application/json" };
  if (c.meta?.storeId) h["Store-Id"] = c.meta.storeId;
  return h;
}

/** Arabic first, since the catalog is written for a Gulf store; English when the Arabic is empty. */
export const zidText = (t: Text): string => (t == null ? "" : typeof t === "string" ? t : t.ar || t.en || "");

/** The store behind the manager token: id (needed on product calls), name and address for the Integrations card. */
export async function zidStore(c: Connection): Promise<{ id?: string; name?: string; url?: string } | null> {
  const r = await fetch(`${ZID_API}/managers/account/profile`, { headers: zidHeaders(c) });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => null)) as { user?: { store?: { id?: number | string; title?: Text; url?: string } } } | null;
  const s = j?.user?.store;
  if (!s) return null;
  return { id: s.id == null ? undefined : String(s.id), name: zidText(s.title) || undefined, url: s.url };
}

/** A connection made before the callback recorded the store id asks the profile once, for this call. */
async function withStore(c: Connection): Promise<Connection> {
  if (c.meta?.storeId) return c;
  const s = await zidStore(c);
  return s?.id ? { ...c, meta: { ...c.meta, storeId: s.id } } : c;
}

/** Published products, written to products.md like the other store connectors. */
export async function importZid(email: string, c: Connection) {
  const conn = await withStore(c);
  const items: ZidProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(`${ZID_API}/products/?page=${page}&page_size=${PER_PAGE}`, { headers: zidHeaders(conn) });
    // 403 is a permission the app was not granted: a new connection cannot fix it, so it must not ask for one.
    if (!r.ok) throw new Error(r.status === 403 ? ZID_ACCESS_DENIED : `zid ${r.status}`);
    const j = (await r.json()) as { results?: ZidProduct[]; next?: string | null };
    items.push(...(j.results ?? []));
    if (!j.next || !j.results?.length) break;
  }
  const live = items.filter((p) => zidText(p.name) && p.is_published !== false);
  const store = conn.meta?.account ? ` ${conn.meta.account}` : "";
  const md = [
    `# Product catalog (Zid${store}, ${new Date().toISOString().slice(0, 10)})`,
    "",
    ...live.map((p) => {
      const cur = p.currency ? ` ${p.currency}` : "";
      const reg = p.price == null || p.price === "" ? "" : `${p.price}${cur}`;
      const sale = p.sale_price == null || p.sale_price === "" || Number(p.sale_price) === Number(p.price) ? "" : `${p.sale_price}${cur}`;
      const price = sale ? `${sale} (was ${reg})` : reg;
      const desc = zidText(p.description).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      return `- **${zidText(p.name)}** — ${price}${desc ? `\n  ${desc}` : ""}${p.html_url ? `\n  ${p.html_url}` : ""}`;
    }),
  ].join("\n");
  await writeFile(email, "products.md", md, "noor");
  return live.length;
}

// ---------- Orders and abandoned carts: totals only ----------
//
// Shapes from Zid's official Python SDK (zidsa/sdk-python: resources and test fixtures), since docs.zid.sa is not
// reachable from the build. What they establish, and what they do not:
// - GET /managers/store/orders?payload_type=default&page&per_page(≤100) answers `{ orders: [...], total_order_count }`
//   with no next link. `payload_type=default` is the only list payload that carries `products` ({ name, quantity }).
//   `order_total` is a decimal string ("100.00000000000000"), `currency_code` a code, `order_status` `{ code, name }`,
//   `payment_status` a string, `created_at` "YYYY-MM-DD HH:MM:SS" with no zone.
//   Not established: what `date_from`/`date_to` filter on, or whether `total_order_count` honours them (it may be the
//   store's all-time count). So the window is enforced here on `created_at`, newest first (`sort_by=desc`), and
//   `total_order_count` is never reported as the 30-day count.
// - GET /managers/store/abandoned-carts?page&page_size(≤100) answers the carts under "abandoned-carts", each with
//   `cart_total`, `currency_code` and a `phase` ("completed" = the cart became an order). Its pagination block is not
//   established, so paging stops on a short page. The list has no products; GET /managers/store/abandoned-carts/{id}
//   answers `{ abandoned_cart: { products: [...] } }`.
// - 401 is a dead token (reconnect). 403 is a permission the app was not granted: on orders it is `zid_access_denied`
//   and does not mark the connection; on carts the snapshot says carts are unavailable and the orders still count.
// Zid allows 60 requests a minute per store, so the sync stays well under it: at most 5 order pages, 3 cart pages and
// CART_DETAILS detail calls. Customer names, phones, emails, cart links and WhatsApp texts are in these answers and
// are never read.

const ORDER_PAGES = 5;
const ORDER_PER_PAGE = 100;
const CART_PAGES = 3;
const CART_PER_PAGE = 100;
/** Carts whose products are read for "most often left", newest first. Each one is a request. */
export const CART_DETAILS = 20;
export const ZID_ACCESS_DENIED = "zid_access_denied";

type ZidOrder = { id?: number | string; created_at?: string; order_total?: number | string; currency_code?: string; currency?: string | { order_currency?: { code?: string } }; order_status?: { code?: string | number; name?: string } | string; payment_status?: string; products?: Line[] };
type ZidCart = { id?: string; phase?: string; cart_total?: number | string; currency_code?: string; created_at?: string };

/** Order statuses that are not a sale (canceled, reversed or being reversed) and payment states that undid one. */
const VOID_STATUS = new Set(["cancelled", "canceled", "reversed", "reverse_in_progress"]);
const VOID_PAYMENT = new Set(["refunded", "voided"]);
const statusCode = (o: ZidOrder) => String(typeof o.order_status === "object" && o.order_status ? o.order_status.code ?? "" : o.order_status ?? "").toLowerCase();
/** The order's own currency. Never a default: an order with none is summed under "" and shown without a code. */
const orderCurrency = (o: ZidOrder) => o.currency_code || (typeof o.currency === "object" ? o.currency?.order_currency?.code : o.currency) || "";

/**
 * "2026-09-01 14:05:00" with no zone. Zid does not document the zone; it is read as Riyadh time (UTC+3), which at
 * worst moves an order three hours across the 30-day edge. Unreadable is null.
 */
function zidTime(s: string | undefined): number | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s.trim())) return null;
  const t = new Date(`${s.trim().slice(0, 19).replace(" ", "T")}+03:00`).getTime();
  return Number.isFinite(t) ? t : null;
}

class ZidStatus extends Error {
  constructor(public status: number) { super(`zid ${status}`); }
}
async function zidGet<T>(c: Connection, path: string): Promise<T> {
  const r = await fetch(`${ZID_API}${path}`, { headers: zidHeaders(c) });
  if (!r.ok) throw new ZidStatus(r.status);
  return (await r.json()) as T;
}

/** Last 30 days of orders and the open abandoned carts, reduced to totals. */
export async function zidSales(conn: Connection, now = new Date()): Promise<SalesSnapshot> {
  const c = await withStore(conn);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const since = now.getTime() - SALES_DAYS * 864e5;
  const range = `date_from=${day(new Date(since))}&date_to=${day(now)}`;

  // Orders, newest first. Paging stops at a short or empty page, at a page that reaches past the window, at the
  // store's count, or at the page cap; only the last one leaves orders unread, and then the count is a floor.
  const rows: ZidOrder[] = [];
  const ids = new Set<string>();
  let capped = false;
  for (let page = 1; page <= ORDER_PAGES; page++) {
    let j: { orders?: unknown; total_order_count?: number | string };
    try {
      j = await zidGet(c, `/managers/store/orders?payload_type=default&sort_by=desc&page=${page}&per_page=${ORDER_PER_PAGE}&${range}`);
    } catch (e) {
      throw e instanceof ZidStatus && e.status === 403 ? new Error(ZID_ACCESS_DENIED) : e;
    }
    if (!Array.isArray(j.orders)) throw new Error("zid unexpected_orders");
    const list = j.orders as ZidOrder[];
    let past = false;
    for (const o of list) {
      const key = o.id == null ? null : String(o.id);
      if (key && ids.has(key)) continue; // an order that moved to the next page while paging
      if (key) ids.add(key);
      const t = zidTime(o.created_at);
      if (t != null && t < since) { past = true; continue; }
      if (t != null && t > now.getTime()) continue;
      rows.push(o);
    }
    const total = Number(j.total_order_count);
    if (past || list.length < ORDER_PER_PAGE || (Number.isFinite(total) && page * ORDER_PER_PAGE >= total)) break;
    if (page === ORDER_PAGES) capped = true;
  }
  let unread = 0;
  let canceled = 0;
  const revenue: Record<string, number> = {};
  const sold = new Map<string, number>();
  for (const o of rows) {
    if (VOID_STATUS.has(statusCode(o)) || VOID_PAYMENT.has(String(o.payment_status ?? "").toLowerCase())) { canceled++; continue; }
    const a = amountOf(o.order_total, orderCurrency(o));
    if (!a) { unread++; continue; }
    addTo(revenue, a);
    tally(o.products, sold);
  }

  // Abandoned carts: completed ones became orders and are left out. More than CART_PAGES full pages is `capped`.
  // A 403 means the app has no access to carts: the snapshot says so, and the orders above still count.
  const carts: ZidCart[] = [];
  let cartsCapped = false;
  let unavailable = false;
  try {
    for (let page = 1; page <= CART_PAGES; page++) {
      const j = await zidGet<Record<string, unknown>>(c, `/managers/store/abandoned-carts?page=${page}&page_size=${CART_PER_PAGE}`);
      const list = j["abandoned-carts"];
      if (!Array.isArray(list)) throw new Error("zid unexpected_carts");
      carts.push(...(list as ZidCart[]).filter((x) => String(x.phase ?? "").toLowerCase() !== "completed"));
      if (list.length < CART_PER_PAGE) break;
      if (page === CART_PAGES) cartsCapped = true;
    }
  } catch (e) {
    if (!(e instanceof ZidStatus && e.status === 403)) throw e;
    unavailable = true;
    carts.length = 0;
  }
  const value: Record<string, number> = {};
  for (const cart of carts) {
    const a = amountOf(cart.cart_total, cart.currency_code || "");
    if (!a) { unread++; continue; }
    addTo(value, a);
  }
  // Product names only come from the detail view: the newest CART_DETAILS carts, four at a time. A detail that fails
  // is skipped rather than failing the sync. The cart id is Zid's own and only becomes a path segment after encoding.
  const newest = [...carts].filter((x) => x.id).sort((a, b) => (zidTime(b.created_at) ?? 0) - (zidTime(a.created_at) ?? 0)).slice(0, CART_DETAILS);
  const details = await pmap(newest, (x) => zidGet<{ abandoned_cart?: { products?: Line[] } }>(c, `/managers/store/abandoned-carts/${encodeURIComponent(String(x.id))}`).catch(() => null), 4);
  const left = new Map<string, number>();
  for (const d of details) tally(d?.abandoned_cart?.products, left);

  return {
    provider: "zid",
    at: now.toISOString(),
    days: SALES_DAYS,
    orders: { count: rows.length, read: rows.length, canceled, revenue, top: topOf(sold), ...(capped ? { capped: true } : {}) },
    carts: { count: carts.length, read: carts.length, value, top: topOf(left), ...(cartsCapped ? { capped: true } : {}), ...(unavailable ? { unavailable: true } : {}) },
    unread,
  };
}
