import { writeFile } from "./files";
import { fileSrc } from "./ref-provenance";
import { safeFetch } from "./safe-fetch";
import { PAGE_PREFIX_BYTES, responsePrefix } from "./read-capped";
import { DESC_MAX, NAME_MAX, PRICE_MAX, plainLine, productsMarkdown } from "./connectors/products-md";

/** Import a store's products from its sitemap → products.md. No API keys, works for Salla/Zid/Shopify/Woo. */
export type Product = { url: string; title: string; price?: string; description?: string };

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", "Accept-Language": "ar,en;q=0.8", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

async function get(url: string, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await safeFetch(url, { signal: c.signal, headers: UA });
    // The first 2 MB only, read inside the same deadline (rule 2246): a sitemap's or page's start is all that is used.
    return r.ok ? await responsePrefix(r, PAGE_PREFIX_BYTES) : "";
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

/** Follow redirects (salla.sa/xyz → custom domain) and return {origin, html}. */
async function resolve(base: string): Promise<{ origin: string; html: string }> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 8000);
  try {
    const r = await safeFetch(base, { signal: c.signal, headers: UA });
    const origin = new URL(r.url || base).origin;
    return { origin, html: r.ok ? await responsePrefix(r, PAGE_PREFIX_BYTES) : "" };
  } catch {
    return { origin: new URL(base).origin, html: "" };
  } finally {
    clearTimeout(t);
  }
}

function locs(xml: string) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}
/**
 * The site's own host or its www twin: a sitemap cannot add a product on another site (rule 2248), and neither
 * robots.txt nor a sitemap index can send the import to fetch a sitemap there (rule 2251).
 */
function sameSite(u: string, origin: string) {
  try {
    const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
    return bare(new URL(u).hostname) === bare(new URL(origin).hostname);
  } catch {
    return false;
  }
}
const PRODUCT_RX = /\/(products?|p|item|items|product-details|shop|منتج)\/|\/p\d{3,}|\/product\?|productid=|\/[^/]*-p-\d+|\/dp\/|\/catalog\/product\//i;

export async function discoverProductUrls(site: string, limit = 25): Promise<string[]> {
  let base = site.trim();
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;
  const deadline = Date.now() + 40000;
  const { origin, html: home } = await resolve(base);
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-products.xml`, `${origin}/sitemap_products_1.xml`, `${origin}/product-sitemap.xml`, `${origin}/sitemap/products.xml`];
  // robots.txt may point to the real sitemap(s), on the site's own host only (rule 2251)
  const robots = await get(`${origin}/robots.txt`, 5000);
  for (const m of robots.matchAll(/^sitemap:\s*(\S+)/gim)) if (sameSite(m[1], origin)) candidates.unshift(m[1]);
  const urls = new Set<string>();
  for (const sm of [...new Set(candidates)]) {
    if (Date.now() > deadline) break;
    const xml = await get(sm, 6000);
    if (!xml || !/<loc>/i.test(xml)) continue;
    const found = locs(xml);
    // sitemap index → follow product-ish children on the site's own host (rule 2251): the sitemaps protocol keeps an
    // index's sitemaps on its host, and one elsewhere would spend the import's fetches on a host the owner never named
    const children = found.filter((u) => /\.xml(\.gz)?(\?|$)/i.test(u) && sameSite(u, origin)).slice(0, 12);
    for (const c of children) {
      if (Date.now() > deadline) break;
      const cx = await get(c, 6000);
      for (const u of locs(cx)) if (PRODUCT_RX.test(u) && sameSite(u, origin)) urls.add(u);
      if (urls.size >= limit) break;
    }
    for (const u of found) if (PRODUCT_RX.test(u) && sameSite(u, origin)) urls.add(u);
    if (urls.size >= limit) break;
  }
  if (urls.size === 0) {
    // fallback: homepage links (already fetched during resolve)
    const html = home || (await get(origin, 6000));
    for (const m of html.matchAll(/href=["']([^"'#?]+)["']/gi)) {
      const u = m[1].startsWith("/") ? origin + m[1] : m[1];
      if (u.startsWith(origin) && PRODUCT_RX.test(u)) urls.add(u);
    }
  }
  return [...urls].slice(0, limit);
}

function text(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

export async function fetchProduct(url: string): Promise<Product | null> {
  const html = await get(url, 7000);
  if (!html) return null;
  const og = (p: string) => html.match(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']*)["']`, "i"))?.[1] ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${p}["']`, "i"))?.[1];
  const title = plainLine(og("og:title") ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "", NAME_MAX);
  if (!title || /سياسة|الشروط|شروط|policy|terms|privacy|faq|الأسئلة|contact|تواصل/i.test(title)) return null;
  const jsonPrice = html.match(/"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/i)?.[1];
  const metaPrice = og("product:price:amount") ?? og("og:price:amount");
  const bodyPrice = text(html).match(/(\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})?)\s*(?:ر\.?س|ريال|SAR|AED|درهم|KWD|د\.ك)/i)?.[0];
  const price = metaPrice ?? jsonPrice ?? bodyPrice;
  const description = plainLine(og("og:description") ?? html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? "", DESC_MAX);
  const shown = plainLine(price ?? "", PRICE_MAX);
  return { url, title, price: shown || undefined, description: description || undefined };
}

export async function importCatalog(email: string, site: string, onProgress?: (msg: string) => void): Promise<{ count: number; products: Product[] }> {
  onProgress?.("sitemap");
  const urls = await discoverProductUrls(site);
  onProgress?.(`found:${urls.length}`);
  const products: Product[] = [];
  // fetch in small parallel batches
  for (let i = 0; i < urls.length; i += 5) {
    const batch = await Promise.all(urls.slice(i, i + 5).map(fetchProduct));
    for (const p of batch) if (p) products.push(p);
    onProgress?.(`fetched:${products.length}`);
  }
  // The same plain, capped lines as every store importer, links only on the site's own host (rule 2248). An import
  // that found nothing leaves the owner's products.md as it was.
  const host = urls[0] ? new URL(urls[0]).hostname : undefined;
  const { md, count } = productsMarkdown(
    `Product catalog (imported ${new Date().toISOString().slice(0, 10)} from ${site})`,
    products.map((p) => ({ name: p.title, price: p.price, description: p.description, url: p.url })),
    host,
    "Noor: use these real products, names and prices in content. Prices below are what the store showed at import time; still confirm offers with the owner.",
  );
  if (count) await writeFile(email, "products.md", md, "noor", fileSrc("crawl", site));
  return { count, products: products.slice(0, count) };
}
