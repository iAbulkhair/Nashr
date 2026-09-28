import type { Connection } from "./store";
import { writeFile } from "../files";
import { SALES_DAYS, addTo, amountOf, tally, topOf, type Line, type SalesSnapshot } from "./sales";

/**
 * Salla Merchant API v2. Endpoints and shapes checked against Salla's own OAuth strategy (@salla.sa/passport-strategy:
 * token and profile on accounts.salla.sa) and the published Salla actions map (GET /products and /orders, answering
 * `{ data: [...], pagination: { currentPage, totalPages, links } }`). The host is fixed, never taken from a request.
 */
const API = "https://api.salla.dev/admin/v2";
const PROFILE = "https://accounts.salla.sa/oauth2/user/info";
const PER_PAGE = 50;
/** Generation reads the first part of products.md; a catalog larger than this adds nothing to what Noor sees. */
const MAX_PAGES = 3;

type Money = { amount?: number | string; currency?: string } | number | string | null | undefined;
type SallaProduct = {
  name?: string;
  price?: Money;
  sale_price?: Money;
  description?: string | null;
  status?: string;
  urls?: { customer?: string };
  url?: string;
};
type Page = { data?: SallaProduct[]; pagination?: { currentPage?: number; current_page?: number; totalPages?: number; total_pages?: number } };

const auth = (c: Connection) => ({ Authorization: `Bearer ${c.data.access_token}`, Accept: "application/json" });

function money(m: Money): string {
  if (m == null || m === "") return "";
  if (typeof m === "object") return m.amount == null ? "" : `${m.amount}${m.currency ? ` ${m.currency}` : ""}`;
  return String(m);
}

/** The merchant's store name and domain, shown on the Integrations card. Missing fields are simply left out. */
export async function sallaStore(c: Connection): Promise<{ name?: string; domain?: string } | null> {
  const r = await fetch(PROFILE, { headers: auth(c) });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => null)) as { data?: { merchant?: { name?: string; domain?: string } } } | null;
  const m = j?.data?.merchant;
  return m ? { name: m.name, domain: m.domain } : null;
}

/** Products on sale (hidden and deleted ones skipped), written to products.md like the other store connectors. */
export async function importSalla(email: string, c: Connection) {
  const items: SallaProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(`${API}/products?page=${page}&per_page=${PER_PAGE}`, { headers: auth(c) });
    if (!r.ok) throw new Error(`salla ${r.status}`);
    const j = (await r.json()) as Page;
    items.push(...(j.data ?? []));
    const cur = j.pagination?.currentPage ?? j.pagination?.current_page ?? page;
    const total = j.pagination?.totalPages ?? j.pagination?.total_pages ?? cur;
    if (cur >= total || !j.data?.length) break;
  }
  const live = items.filter((p) => p.name && p.status !== "hidden" && p.status !== "deleted");
  const store = c.meta?.account ? ` ${c.meta.account}` : "";
  const md = [
    `# Product catalog (Salla${store}, ${new Date().toISOString().slice(0, 10)})`,
    "",
    ...live.map((p) => {
      const sale = money(p.sale_price);
      const price = sale && sale !== money(p.price) ? `${sale} (was ${money(p.price)})` : money(p.price);
      const desc = (p.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      const url = p.urls?.customer ?? p.url ?? "";
      return `- **${p.name}** — ${price}${desc ? `\n  ${desc}` : ""}${url ? `\n  ${url}` : ""}`;
    }),
  ].join("\n");
  await writeFile(email, "products.md", md, "noor");
  return live.length;
}

// ---------- Orders and abandoned carts: totals only ----------
//
// The list endpoints are GET /orders (from_date / to_date / page) and GET /carts/abandoned (page / per_page, 60 at
// most), per Salla's published OpenAPI request schemas. Their response fields are not in anything published that
// the build can read, so every field below is read defensively, and records whose total cannot be read are counted
// in `unread` instead of being guessed at. Customer names, phone numbers and addresses are never read into the
// snapshot or the file: only counts, money and product names leave this function.

const ORDER_PAGES = 10;
const CART_PAGES = 3;

type SallaOrder = { total?: Money; amounts?: { total?: Money }; status?: { slug?: string; name?: string } | string; items?: Line[] };
type SallaCart = { total?: Money; subtotal?: Money; items?: Line[] };
type ListPage<T> = { data?: T[]; pagination?: { total?: number; currentPage?: number; current_page?: number; totalPages?: number; total_pages?: number } };

/** Salla money is `{ amount, currency }`, or a bare number or string in SAR. */
const sallaAmount = (m: Money) => (m != null && typeof m === "object" ? amountOf(m.amount, m.currency || "SAR") : amountOf(m, "SAR"));

async function pages<T>(c: Connection, path: string, max: number): Promise<{ rows: T[]; total: number | null }> {
  const rows: T[] = [];
  let total: number | null = null;
  for (let page = 1; page <= max; page++) {
    const r = await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}page=${page}`, { headers: auth(c) });
    if (!r.ok) throw new Error(`salla ${r.status}`);
    const j = (await r.json()) as ListPage<T>;
    rows.push(...(j.data ?? []));
    total ??= typeof j.pagination?.total === "number" ? j.pagination.total : null;
    const cur = j.pagination?.currentPage ?? j.pagination?.current_page ?? page;
    const last = j.pagination?.totalPages ?? j.pagination?.total_pages ?? cur;
    if (cur >= last || !j.data?.length) break;
  }
  return { rows, total };
}

const statusSlug = (o: SallaOrder) => (typeof o.status === "string" ? o.status : o.status?.slug ?? o.status?.name ?? "").toLowerCase();

/** Last 30 days of orders and the open abandoned carts, reduced to totals. */
export async function sallaSales(c: Connection, now = new Date()): Promise<SalesSnapshot> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const from = day(new Date(now.getTime() - SALES_DAYS * 864e5));
  const [orders, carts] = await Promise.all([
    pages<SallaOrder>(c, `/orders?from_date=${from}&to_date=${day(now)}`, ORDER_PAGES),
    pages<SallaCart>(c, `/carts/abandoned?per_page=60`, CART_PAGES),
  ]);
  let unread = 0;
  let canceled = 0;
  const revenue: Record<string, number> = {};
  const sold = new Map<string, number>();
  for (const o of orders.rows) {
    if (/cancel|refund|restor|delet/.test(statusSlug(o))) { canceled++; continue; }
    const a = sallaAmount(o.total ?? o.amounts?.total);
    if (!a) { unread++; continue; }
    addTo(revenue, a);
    tally(o.items, sold);
  }
  const value: Record<string, number> = {};
  const left = new Map<string, number>();
  for (const cart of carts.rows) {
    const a = sallaAmount(cart.total ?? cart.subtotal);
    if (!a) { unread++; continue; }
    addTo(value, a);
    tally(cart.items, left);
  }
  return {
    provider: "salla",
    at: now.toISOString(),
    days: SALES_DAYS,
    orders: { count: orders.total ?? orders.rows.length, read: orders.rows.length, canceled, revenue, top: topOf(sold) },
    carts: { count: carts.total ?? carts.rows.length, read: carts.rows.length, value, top: topOf(left) },
    unread,
  };
}
