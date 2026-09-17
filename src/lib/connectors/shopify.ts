import type { Connection } from "./store";
import { writeFile } from "../files";
import { mdToHtml } from "./wordpress";

const V = "2024-10";
const h = (c: Connection) => ({ "X-Shopify-Access-Token": c.data.access_token, "Content-Type": "application/json" });

export async function importShopify(email: string, c: Connection) {
  const r = await fetch(`https://${c.meta?.shop}/admin/api/${V}/products.json?limit=50&status=active`, { headers: h(c) });
  if (!r.ok) throw new Error(`shopify ${r.status}`);
  const j = (await r.json()) as { products: { title: string; handle: string; body_html?: string; variants: { price: string }[] }[] };
  const md = [`# Product catalog (Shopify ${c.meta?.shop}, ${new Date().toISOString().slice(0, 10)})`, "", ...j.products.map((p) => `- **${p.title}** — ${p.variants[0]?.price ?? ""}\n  ${(p.body_html ?? "").replace(/<[^>]+>/g, "").slice(0, 200)}\n  https://${c.meta?.shop}/products/${p.handle}`)].join("\n");
  await writeFile(email, "products.md", md, "noor");
  return j.products.length;
}

export async function publishShopifyArticle(c: Connection, post: { title: string; body: string; published?: boolean }) {
  const blogs = await fetch(`https://${c.meta?.shop}/admin/api/${V}/blogs.json`, { headers: h(c) });
  if (!blogs.ok) throw new Error(`shopify blogs ${blogs.status}`);
  const bj = (await blogs.json()) as { blogs: { id: number; handle: string }[] };
  const blog = bj.blogs[0];
  if (!blog) throw new Error("no blog on store");
  const r = await fetch(`https://${c.meta?.shop}/admin/api/${V}/blogs/${blog.id}/articles.json`, { method: "POST", headers: h(c), body: JSON.stringify({ article: { title: post.title, body_html: mdToHtml(post.body), published: post.published ?? false } }) });
  if (!r.ok) throw new Error(`shopify article ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { article: { id: number; handle: string } };
  return { id: String(j.article.id), url: `https://${c.meta?.shop}/blogs/${blog.handle}/${j.article.handle}` };
}
