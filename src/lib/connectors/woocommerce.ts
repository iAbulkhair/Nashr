import type { Connection } from "./store";
import { writeFile } from "../files";
import { safeFetch } from "../safe-fetch";

export async function verifyWoo(data: Record<string, string>) {
  // A typo'd or private host makes safeFetch throw. Uncaught, that became a 500 with a non-JSON body, the client's
  // `await res.json()` rejected, and the connect dialog stayed disabled with no message. Answer like the siblings.
  try {
    const r = await safeFetch(`${data.site.replace(/\/+$/, "")}/wp-json/wc/v3/products?per_page=1`, { headers: { Authorization: "Basic " + Buffer.from(`${data.consumerKey}:${data.consumerSecret}`).toString("base64") } });
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unreachable" };
  }
}

export async function importWoo(email: string, c: Connection) {
  const r = await safeFetch(`${c.data.site.replace(/\/+$/, "")}/wp-json/wc/v3/products?per_page=50&status=publish`, { headers: { Authorization: "Basic " + Buffer.from(`${c.data.consumerKey}:${c.data.consumerSecret}`).toString("base64") } });
  if (!r.ok) throw new Error(`woo ${r.status}`);
  const items = (await r.json()) as { name: string; price: string; permalink: string; short_description?: string }[];
  const md = [`# Product catalog (WooCommerce, ${new Date().toISOString().slice(0, 10)})`, "", ...items.map((p) => `- **${p.name}** — ${p.price} \n  ${(p.short_description ?? "").replace(/<[^>]+>/g, "").slice(0, 200)}\n  ${p.permalink}`)].join("\n");
  await writeFile(email, "products.md", md, "noor");
  return items.length;
}
