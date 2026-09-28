import type { Connection } from "./store";
import { writeFile } from "../files";

/**
 * Zid Merchant API v1. Zid's token answer carries two tokens: `authorization` goes in the Authorization header as a
 * bearer, `access_token` goes in X-Manager-Token and names the store. Product calls also need the store id, which the
 * manager profile gives and the callback keeps in `meta.storeId`. Lists answer `{ count, next, previous, results }`.
 * The host is fixed, never taken from a request or from a `next` link in an answer.
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

/** Published products, written to products.md like the other store connectors. */
export async function importZid(email: string, c: Connection) {
  let conn = c;
  if (!conn.meta?.storeId) {
    // A connection made before the callback recorded the store id: ask once, for this import.
    const s = await zidStore(conn);
    if (s?.id) conn = { ...conn, meta: { ...conn.meta, storeId: s.id } };
  }
  const items: ZidProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(`${ZID_API}/products/?page=${page}&page_size=${PER_PAGE}`, { headers: zidHeaders(conn) });
    if (!r.ok) throw new Error(`zid ${r.status}`);
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
