import { safeFetch } from "./safe-fetch";
/** Fetch a public site and reduce it to text Noor can read. No JS rendering. */
export type SiteSnapshot = { url: string; ok: boolean; title: string; description: string; text: string; links: string[]; platform: string; error?: string; /** most frequent hex colours in inline CSS, for brand guidelines */ colors?: string[]; fonts?: string[] };

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

/** Visual signals from inline CSS and font links. Linked stylesheets are not fetched, so this can be empty. */
function visuals(html: string) {
  const count = new Map<string, number>();
  for (const m of html.matchAll(/#([0-9a-f]{6})\b/gi)) { const c = "#" + m[1].toUpperCase(); count.set(c, (count.get(c) ?? 0) + 1); }
  const colors = [...count.entries()].filter(([c]) => !["#FFFFFF", "#000000"].includes(c)).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c);
  const fonts = new Set<string>();
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&]+)/gi)) for (const f of decodeURIComponent(m[1]).split("|")) fonts.add(f.split(":")[0].replace(/\+/g, " ").trim());
  for (const m of html.matchAll(/font-family\s*:\s*["']?([A-Za-z][A-Za-z0-9 \-]{2,30})["']?\s*[,;}]/g)) { const f = m[1].trim(); if (!/^(inherit|initial|sans|serif|monospace|system|var)/i.test(f)) fonts.add(f); }
  return { colors, fonts: [...fonts].slice(0, 5) };
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
    const res = await safeFetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; NashrBot/0.1; +https://nashr-tau.vercel.app)", "Accept-Language": "ar,en;q=0.8" } });
    clearTimeout(t);
    const html = (await res.text()).slice(0, 600000);
    const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 200);
    const description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? "").slice(0, 400);
    const links = [...new Set([...html.matchAll(/href=["']([^"'#?]+)["']/gi)].map((m) => m[1]).filter((l) => /^(https?:)?\/\//.test(l) || l.startsWith("/")).slice(0, 60))];
    const text = strip(html).slice(0, 12000);
    return { url, ok: res.ok && text.length > 50, title, description, text, links, platform: detectPlatform(html, url), error: res.ok ? undefined : `HTTP ${res.status}`, ...visuals(html) };
  } catch (e) {
    return { url, ok: false, title: "", description: "", text: "", links: [], platform: "unknown", error: e instanceof Error ? e.message : "fetch_failed" };
  }
}
