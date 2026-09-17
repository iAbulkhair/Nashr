/** Fetch a public site and reduce it to text Noor can read. No JS rendering. */
export type SiteSnapshot = { url: string; ok: boolean; title: string; description: string; text: string; links: string[]; platform: string; error?: string };

function strip(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function detectPlatform(html: string, url: string) {
  const h = html.toLowerCase() + " " + url.toLowerCase();
  if (h.includes("salla.sa") || h.includes("salla-")) return "Salla";
  if (h.includes("zid.store") || h.includes("zid.sa") || h.includes("zidapi")) return "Zid";
  if (h.includes("cdn.shopify") || h.includes("myshopify")) return "Shopify";
  if (h.includes("woocommerce")) return "WooCommerce";
  if (h.includes("wp-content")) return "WordPress";
  if (h.includes("webflow")) return "Webflow";
  if (h.includes("wix.com")) return "Wix";
  return "unknown";
}

export async function crawl(input: string): Promise<SiteSnapshot> {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; NashrBot/0.1; +https://nashr-tau.vercel.app)", "Accept-Language": "ar,en;q=0.8" } });
    clearTimeout(t);
    const html = (await res.text()).slice(0, 600000);
    const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 200);
    const description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? "").slice(0, 400);
    const links = [...new Set([...html.matchAll(/href=["']([^"'#?]+)["']/gi)].map((m) => m[1]).filter((l) => /^(https?:)?\/\//.test(l) || l.startsWith("/")).slice(0, 60))];
    const text = strip(html).slice(0, 12000);
    return { url, ok: res.ok && text.length > 50, title, description, text, links, platform: detectPlatform(html, url), error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { url, ok: false, title: "", description: "", text: "", links: [], platform: "unknown", error: e instanceof Error ? e.message : "fetch_failed" };
  }
}
