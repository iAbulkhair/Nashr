import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Lang } from "./i18n";
import { splitTags, tagProblems } from "./blog-tags";

/** `tags` is the post's tags in the page's language (rule 3140): empty when the front matter has none. */
export type Post = { slug: string; title: string; desc: string; date: string; body: string; tags: string[] };

const DIR = join(process.cwd(), "content", "blog");

function parse(raw: string) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const body = m ? m[2] : raw;
  const [ar, en] = body.split(/\n---EN---\n/);
  return { meta, ar: ar.trim(), en: (en ?? ar).trim(), split: en !== undefined };
}

const files = () => readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();

/** The front matter every post must carry, each non-empty. `tags_ar` and `tags_en` are optional, but come as a pair. */
export const POST_FIELDS = ["title_ar", "title_en", "desc_ar", "desc_en", "date"] as const;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const realDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/**
 * What is wrong with one post file (rule 1979), empty when nothing is. A post needs its front matter block, the five
 * fields above (the date a real calendar day as YYYY-MM-DD, which the sitemap and the Article data publish), a slug of
 * lowercase words and hyphens, and both an Arabic and an English body split by `---EN---`. Without the split the Arabic
 * text was served at /en as well; without a title the file name was shown as one.
 */
export function postProblems(file: string, raw: string): string[] {
  const out: string[] = [];
  const slug = file.replace(/\.md$/, "");
  if (!SLUG.test(slug)) out.push(`${file}: the file name must be lowercase words joined by hyphens`);
  if (!/^---\n[\s\S]*?\n---\n/.test(raw)) return [...out, `${file}: no front matter block`];
  const { meta, ar, en, split } = parse(raw);
  for (const k of POST_FIELDS) if (!meta[k]) out.push(`${file}: ${k} is missing`);
  if (meta.date && !realDate(meta.date)) out.push(`${file}: date "${meta.date.slice(0, 20)}" is not a YYYY-MM-DD day`);
  // Rule 3140: tags are optional, but a post tagged in one language is tagged in both, so the index filters the same way in each.
  for (const [f, o] of [["tags_ar", "tags_en"], ["tags_en", "tags_ar"]] as const) {
    if (meta[o] !== undefined && meta[o] !== "" && !meta[f]) out.push(`${file}: ${f} is missing (${o} is given; tags come in both languages)`);
    if (meta[f]) out.push(...tagProblems(file, f, splitTags(meta[f])));
  }
  if (!split) out.push(`${file}: no ---EN--- line between the Arabic and the English text`);
  else if (!ar || !en) out.push(`${file}: the ${ar ? "English" : "Arabic"} text is empty`);
  return out;
}

/**
 * Every post, read and checked together. A bad post throws, naming every problem in every file, so `next build` fails
 * (the blog pages' `generateStaticParams` and the sitemap read through here) instead of publishing a post with no title,
 * a date of "soon" or the Arabic text under /en.
 */
function readAll() {
  const raws = files().map((f) => ({ f, raw: readFileSync(join(DIR, f), "utf8") }));
  const problems = raws.flatMap(({ f, raw }) => postProblems(f, raw));
  if (problems.length) throw new Error(`content/blog has ${problems.length} problem(s): ${problems.join("; ")}`);
  return raws.map(({ f, raw }) => ({ slug: f.replace(/\.md$/, ""), ...parse(raw) }));
}

/**
 * Newest first, ties broken by slug. The old comparator returned -1 for every pair it did not consider older, never
 * 0, which is not a valid ordering: with all posts sharing one date the result was whatever order readdir happened
 * to return, so the blog index was ordered differently on different machines and could change between deploys.
 */
const byNewest = (a: { slug: string; date: string }, b: { slug: string; date: string }) =>
  b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug);

export function listPosts(lang: Lang): Post[] {
  return readAll().map(({ slug, meta, ar, en }) => ({ slug, title: meta[`title_${lang}`], desc: meta[`desc_${lang}`], date: meta.date, body: lang === "ar" ? ar : en, tags: splitTags(meta[`tags_${lang}`]) })).sort(byNewest);
}
export function getPost(lang: Lang, slug: string) {
  return listPosts(lang).find((p) => p.slug === slug) ?? null;
}
/** Slug and publication date for every post, in the same order the index shows. The sitemap needs the dates. */
export function postIndex(): { slug: string; date: string }[] {
  return readAll().map(({ slug, meta }) => ({ slug, date: meta.date })).sort(byNewest);
}
export function slugs() {
  return postIndex().map((p) => p.slug);
}

/** Small markdown → HTML: headings, paragraphs, lists, tables, bold, links. */
export { render } from "./md";
