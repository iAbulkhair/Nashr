/**
 * One product line of products.md, the core memory every agent reads (rule 2247). Every store importer writes its rows
 * through here: a store's names, prices and descriptions are the merchant's text (and, for WooCommerce, Odoo and
 * PrestaShop, whatever the host the owner typed in answers), so each field becomes one line of plain text with a cap,
 * and a link is kept only when it is http(s) and, for an owner-supplied host, on that store's own host. Without this a
 * single name could hold newlines that read as headings, or fill the file's 40,000 characters alone, and a hostile
 * host could point every product at another site that the agents would then put in published content.
 */

/** Rows one import keeps: generation reads the first part of products.md, and every source asks for at most 150. */
export const PRODUCT_ROWS_MAX = 150;
export const NAME_MAX = 140;
export const PRICE_MAX = 40;
export const DESC_MAX = 200;
export const URL_MAX = 300;

/** Plain one-line text: tags out, non-breaking spaces and whitespace collapsed, capped. */
export function plainLine(v: unknown, max: number): string {
  const s = typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  return s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

/**
 * The link as given when it is an absolute http(s) URL of at most URL_MAX characters, without credentials, and, when
 * `host` is set (an owner-supplied store), on that host or its www twin; else "".
 */
export function storeLink(v: unknown, host?: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > URL_MAX || /\s/.test(s)) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  if (u.username || u.password) return "";
  if (host && bareHost(u.hostname) !== bareHost(host)) return "";
  return s;
}

export type ProductRow = { name: unknown; price?: unknown; description?: unknown; url?: unknown };

/** `- **name** — price`, then the description and the link on their own indented lines when present; "" without a name. */
export function productLine(p: ProductRow, host?: string): string {
  const name = plainLine(p.name, NAME_MAX).replace(/\*+/g, "*");
  if (!name) return "";
  const price = plainLine(p.price, PRICE_MAX);
  const desc = plainLine(p.description, DESC_MAX);
  const url = storeLink(p.url, host);
  return `- **${name}**${price ? ` — ${price}` : ""}${desc ? `\n  ${desc}` : ""}${url ? `\n  ${url}` : ""}`;
}

/** The file: the heading, then up to PRODUCT_ROWS_MAX lines of rows that have a name. Returns the text and the count. */
export function productsMarkdown(heading: string, rows: readonly ProductRow[], host?: string): { md: string; count: number } {
  const lines = rows.slice(0, PRODUCT_ROWS_MAX).map((r) => productLine(r, host)).filter(Boolean);
  return { md: [`# ${plainLine(heading, 200)}`, "", ...lines].join("\n"), count: lines.length };
}
