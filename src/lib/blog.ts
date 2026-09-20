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

const files = () => readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();

/**
 * Newest first, ties broken by slug. The old comparator returned -1 for every pair it did not consider older, never
 * 0, which is not a valid ordering: with all posts sharing one date the result was whatever order readdir happened
 * to return, so the blog index was ordered differently on different machines and could change between deploys.
 */
const byNewest = (a: { slug: string; date: string }, b: { slug: string; date: string }) =>
  b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug);

export function listPosts(lang: Lang): Post[] {
  return files().map((f) => {
    const { meta, ar, en } = parse(readFileSync(join(DIR, f), "utf8"));
    return { slug: f.replace(/\.md$/, ""), title: meta[`title_${lang}`] ?? meta.title_en ?? f, desc: meta[`desc_${lang}`] ?? "", date: meta.date ?? "", body: lang === "ar" ? ar : en };
  }).sort(byNewest);
}
export function getPost(lang: Lang, slug: string) {
  return listPosts(lang).find((p) => p.slug === slug) ?? null;
}
/** Slug and publication date for every post, in the same order the index shows. The sitemap needs the dates. */
export function postIndex(): { slug: string; date: string }[] {
  return files()
    .map((f) => ({ slug: f.replace(/\.md$/, ""), date: parse(readFileSync(join(DIR, f), "utf8")).meta.date ?? "" }))
    .sort(byNewest);
}
export function slugs() {
  return postIndex().map((p) => p.slug);
}

/** Small markdown → HTML: headings, paragraphs, lists, tables, bold, links. */
export { render } from "./md";
