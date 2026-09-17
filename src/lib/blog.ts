import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Lang } from "./i18n";

export type Post = { slug: string; title: string; desc: string; date: string; body: string };

const DIR = join(process.cwd(), "content", "blog");

function parse(raw: string) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const body = m ? m[2] : raw;
  const [ar, en] = body.split(/\n---EN---\n/);
  return { meta, ar: ar.trim(), en: (en ?? ar).trim() };
}

export function listPosts(lang: Lang): Post[] {
  return readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => {
    const { meta, ar, en } = parse(readFileSync(join(DIR, f), "utf8"));
    return { slug: f.replace(/\.md$/, ""), title: meta[`title_${lang}`] ?? meta.title_en ?? f, desc: meta[`desc_${lang}`] ?? "", date: meta.date ?? "", body: lang === "ar" ? ar : en };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));
}
export function getPost(lang: Lang, slug: string) {
  return listPosts(lang).find((p) => p.slug === slug) ?? null;
}
export function slugs() {
  return readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
}

/** Small markdown → HTML: headings, paragraphs, lists, tables, bold, links. */
export { render } from "./md";
