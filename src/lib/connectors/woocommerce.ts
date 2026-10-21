import type { Connection } from "./store";
import { writeFile } from "../files";
import { fileSrc } from "../ref-provenance";
import { safeFetch } from "../safe-fetch";
import { STORE_REPLY_BYTES, responseJson } from "../read-capped";
import { productsMarkdown } from "./products-md";
import { SALES_DAYS, addTo, amountOf, tally, topOf, type Line, type SalesSnapshot } from "./sales";

type WooKey = { site: string; consumerKey: string; consumerSecret: string };

/**
 * Every WooCommerce call goes through here: the host is the owner's, so it passes safeFetch, and it must be https. The
 * consumer key and secret travel in a Basic header, and over plain http anyone on the path could read them.
 */
function wooGet(d: WooKey, path: string) {
  return safeFetch(`${d.site.replace(/\/+$/, "")}/wp-json/wc/v3/${path}`, { headers: { Authorization: "Basic " + Buffer.from(`${d.consumerKey}:${d.consumerSecret}`).toString("base64"), Accept: "application/json" } }, { httpsOnly: true });
}

/** The store's host, for the store name on the Reports card and in store-sales.md. */
export function wooHost(c: Connection): string | undefined {
  try { return new URL(c.data.site).hostname; } catch { return undefined; }
}

export async function verifyWoo(data: Record<string, string>) {
  // A typo'd or private host makes safeFetch throw. Uncaught, that became a 500 with a non-JSON body, the client's
  // `await res.json()` rejected, and the connect dialog stayed disabled with no message. Answer like the siblings.
  try {
    const r = await wooGet(data as WooKey, "products?per_page=1");
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unreachable" };
  }
}

export async function importWoo(email: string, c: Connection) {
  const r = await wooGet(c.data as WooKey, "products?per_page=50&status=publish");
  if (!r.ok) throw new Error(`woo ${r.status}`);
  const items = (await responseJson(r, STORE_REPLY_BYTES)) as unknown;
  if (!Array.isArray(items)) throw new Error("woo unexpected_products");
  // The host is the owner's: each field one capped line, and a permalink only on the store's own host (rule 2247).
  const host = new URL((c.data as WooKey).site).hostname;
  const { md, count } = productsMarkdown(`Product catalog (WooCommerce, ${new Date().toISOString().slice(0, 10)})`, (items as { name?: unknown; price?: unknown; permalink?: unknown; short_description?: unknown }[]).map((p) => ({ name: p?.name, price: p?.price, description: p?.short_description, url: p?.permalink })), host);
  await writeFile(email, "products.md", md, "noor", { src: fileSrc("store") });
  return count;
}

// ---------- Orders: totals only ----------
//
// GET /wp-json/wc/v3/orders (WooCommerce REST API v3). What the code relies on, and what it does not:
// - `per_page` ≤ 100, `page`, `orderby=date&order=desc`, `after` (ISO 8601) and `dates_are_gmt` are collection
//   parameters. Whether a given store honours `after` is not assumed: the window is enforced here on `date_created_gmt`
//   ("2026-09-01T14:05:00", no zone, GMT), and the filter is only a lower bound sent a day early so it can never be
//   narrower than the window. `X-WP-TotalPages` only stops the paging early; the count of orders is never taken from
//   `X-WP-Total`, because it may cover more than the window.
// - `_fields` names exactly what is read. Billing and shipping blocks (name, email, phone, address), `customer_id` and
//   payment details are never in the answer, so personal data is kept out at the request and not only in the reducer.
//   `line_items` and `refunds` come whole (nested field filtering is not relied on); only `name` and `quantity`, and
//   each refund's `total`, are read.
// - `status` is a slug without the `wc-` prefix. `total` is a decimal string and the order's own `currency` a code.
//   `refunds[].total` is a negative decimal string. `date_paid_gmt` is the paid stamp (null while unpaid). WooCommerce answers 401 for a wrong key and also for a key without
//   read access to orders, so the two cannot be told apart: one error, `woo_access_denied`.
// - Core WooCommerce keeps no abandoned carts, so the snapshot says carts are unavailable (not zero).

const ORDER_PAGES = 5;
const ORDER_PER_PAGE = 100;
export const WOO_ACCESS_DENIED = "woo_access_denied";
const ORDER_FIELDS = "id,status,total,currency,date_created_gmt,date_paid_gmt,line_items,refunds";

/** Not a sale: undone, never paid, or not an order yet (a checkout still being filled in). */
const VOID_STATUS = new Set(["cancelled", "refunded", "failed", "trash", "checkout-draft", "draft", "auto-draft"]);
/** Placed and not paid: `pending` (payment awaited) and `on-hold` (WooCommerce's "awaiting payment confirmation", such as a
 * bank transfer). They count as orders, not as revenue, until the store marks them paid (founder, 2026-10-05). */
const UNPAID_STATUS = new Set(["pending", "on-hold"]);

type WooOrder = { id?: number | string; status?: string; total?: number | string; currency?: string; date_created_gmt?: string; date_paid_gmt?: string | null; line_items?: Line[]; refunds?: { total?: number | string }[] };

const wooStatus = (o: WooOrder) => String(o.status ?? "").toLowerCase().replace(/^wc-/, "");

/** "2026-09-01T14:05:00" is GMT without a zone mark. Unreadable is null. */
function wooTime(s: string | undefined): number | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s.trim())) return null;
  const t = new Date(`${s.trim().slice(0, 19).replace(" ", "T")}Z`).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Last 30 days of orders, reduced to totals. Never carts, never a customer field. */
export async function wooSales(c: Connection, now = new Date()): Promise<SalesSnapshot> {
  const since = now.getTime() - SALES_DAYS * 864e5;
  const after = encodeURIComponent(new Date(since - 864e5).toISOString().slice(0, 19) + "Z");
  const rows: WooOrder[] = [];
  const ids = new Set<string>();
  let capped = false;
  for (let page = 1; page <= ORDER_PAGES; page++) {
    const r = await wooGet(c.data as WooKey, `orders?per_page=${ORDER_PER_PAGE}&page=${page}&orderby=date&order=desc&after=${after}&dates_are_gmt=true&_fields=${ORDER_FIELDS}`);
    if (r.status === 401 || r.status === 403) throw new Error(WOO_ACCESS_DENIED);
    if (!r.ok) throw new Error(`woo ${r.status}`);
    const list = (await responseJson(r, STORE_REPLY_BYTES).catch(() => null)) as unknown;
    if (!Array.isArray(list)) throw new Error("woo unexpected_orders");
    let past = false;
    for (const o of list as WooOrder[]) {
      const key = o.id == null ? null : String(o.id);
      if (key && ids.has(key)) continue; // an order that moved to the next page while paging
      if (key) ids.add(key);
      const t = wooTime(o.date_created_gmt);
      if (t != null && t < since) { past = true; continue; }
      if (t != null && t > now.getTime()) continue;
      rows.push(o);
    }
    const pages = Number(r.headers.get("x-wp-totalpages"));
    if (past || list.length < ORDER_PER_PAGE || (Number.isFinite(pages) && pages > 0 && page >= pages)) break;
    if (page === ORDER_PAGES) capped = true;
  }

  let unread = 0;
  let canceled = 0;
  let pending = 0;
  const revenue: Record<string, number> = {};
  const sold = new Map<string, number>();
  for (const o of rows) {
    const status = wooStatus(o);
    if (VOID_STATUS.has(status)) { canceled++; continue; }
    // Revenue is paid orders only. WooCommerce stamps `date_paid_gmt` when an order is paid; an order with the field present
    // and empty (a custom status that never took payment) is unpaid whatever its status says. A store that does not send
    // the field at all is read by status alone.
    const unpaid = UNPAID_STATUS.has(status) || ("date_paid_gmt" in o && !o.date_paid_gmt);
    if (unpaid) { pending++; continue; }
    const cur = o.currency || "";
    const gross = amountOf(o.total, cur);
    if (!gross) { unread++; continue; }
    // A partly refunded order counts what the shopper kept. A refund with no readable amount leaves the gross total and
    // is counted in `unread`, so a shape change shows up instead of silently overstating sales.
    let kept = gross.amount;
    for (const f of o.refunds ?? []) {
      const a = amountOf(f.total, cur);
      if (a) kept += a.amount < 0 ? a.amount : -a.amount;
      else unread++;
    }
    // Refunded in full while the status still reads paid: it is not a sale.
    if (kept <= 0 && gross.amount > 0) { canceled++; continue; }
    addTo(revenue, { amount: Math.max(0, kept), currency: cur });
    tally(o.line_items, sold);
  }

  return {
    provider: "woocommerce",
    at: now.toISOString(),
    days: SALES_DAYS,
    orders: { count: rows.length, read: rows.length, canceled, revenue, top: topOf(sold), ...(pending ? { pending } : {}), ...(capped ? { capped: true } : {}) },
    carts: { count: 0, read: 0, value: {}, top: [], unavailable: true },
    unread,
  };
}
