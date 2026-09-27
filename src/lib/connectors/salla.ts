import type { Connection } from "./store";
import { writeFile } from "../files";

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
