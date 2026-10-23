import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Lang } from "./i18n";
import { splitTags, tagProblems } from "./blog-tags";
import { serve, type Served } from "./lang-fallback";
import { coverProblems, readCoverFile, type CoverReader } from "./blog-cover";

/**
 * `tags` is the post's tags in the page's language (rule 3140): empty when the front matter has none. `langs` is the
 * languages the post is written in (rule 3313): both, unless its front matter says `languages: ar` or `languages: en`.
 */
export type Post = { slug: string; title: string; desc: string; date: string; body: string; tags: string[]; langs: Lang[]; cover: { src: string; alt: string } | null };

const DIR = join(process.cwd(), "content", "blog");

function parse(raw: string) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const body = m ? m[2] : raw;
  const [ar, en] = body.split(/\n---EN---\n/);
  return { meta, ar: ar.trim(), en: (en ?? ar).trim(), split: en !== undefined };
}

/**
 * The languages a post is written in (rule 3313): `languages: ar` or `languages: en` in its front matter says it exists in
 * that one only; no line means both. Anything else is a problem reported by `postProblems`, and reads as both here.
 */
export function postLangs(meta: Record<string, string>): Lang[] {
  const v = (meta.languages ?? "").trim();
  return v === "ar" || v === "en" ? [v] : ["ar", "en"];
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
export function postProblems(file: string, raw: string, readCover: CoverReader = readCoverFile): string[] {
  const out: string[] = [];
  const slug = file.replace(/\.md$/, "");
  if (!SLUG.test(slug)) out.push(`${file}: the file name must be lowercase words joined by hyphens`);
  if (!/^---\n[\s\S]*?\n---\n/.test(raw)) return [...out, `${file}: no front matter block`];
  const { meta, ar, en, split } = parse(raw);
  // Rule 3313: a post written in one language says so (`languages: ar` or `languages: en`); it is never inferred from a missing
  // translation, so a forgotten English text still fails the build instead of quietly shipping Arabic-only.
  const langsLine = (meta.languages ?? "").trim();
  if (meta.languages !== undefined && langsLine !== "ar" && langsLine !== "en") out.push(`${file}: languages "${langsLine.slice(0, 20)}" must be ar or en (leave the line out for a post in both)`);
  const langs = postLangs(meta);
  const one = langs.length === 1 ? langs[0] : null;
  // Rule 3314: a cover is optional; when given it is a real image file in public/blog with alternative text in each language of the post.
  out.push(...coverProblems(file, meta, langs, readCover));
  const need = POST_FIELDS.filter((k) => !one || k === "date" || k.endsWith(`_${one}`));
  for (const k of need) if (!meta[k]) out.push(`${file}: ${k} is missing`);
  if (meta.date && !realDate(meta.date)) out.push(`${file}: date "${meta.date.slice(0, 20)}" is not a YYYY-MM-DD day`);
  // Rule 3140: tags are optional, but a post tagged in one language is tagged in both, so the index filters the same way in each.
  // A post in one language is tagged in that language only (rule 3313).
  if (one) {
    const other = one === "ar" ? "en" : "ar";
    for (const k of [`title_${other}`, `desc_${other}`, `tags_${other}`]) if (meta[k]) out.push(`${file}: ${k} is given but the post is only in ${one === "ar" ? "Arabic" : "English"}`);
    if (meta[`tags_${one}`]) out.push(...tagProblems(file, `tags_${one}` as "tags_ar" | "tags_en", splitTags(meta[`tags_${one}`])));
    if (split) out.push(`${file}: a post in one language has no ---EN--- line`);
    else if (!ar) out.push(`${file}: the text is empty`);
    return out;
  }
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
  return raws.map(({ f, raw }) => postEntry(f, raw));
}

/** One checked post file, read once: its slug, front matter, both texts and the languages it exists in. */
export type PostEntry = ReturnType<typeof postEntry>;
export function postEntry(file: string, raw: string) {
  const p = parse(raw);
  return { slug: file.replace(/\.md$/, ""), ...p, langs: postLangs(p.meta) };
}

/** The post as `lang` shows it. Only for a language the entry exists in. */
export function postIn(e: PostEntry, lang: Lang): Post {
  return { slug: e.slug, title: e.meta[`title_${lang}`], desc: e.meta[`desc_${lang}`], date: e.meta.date, body: lang === "ar" ? e.ar : e.en, tags: splitTags(e.meta[`tags_${lang}`]), langs: e.langs, cover: e.meta.cover ? { src: e.meta.cover, alt: e.meta[`cover_alt_${lang}`] ?? "" } : null };
}

/**
 * Newest first, ties broken by slug. The old comparator returned -1 for every pair it did not consider older, never
 * 0, which is not a valid ordering: with all posts sharing one date the result was whatever order readdir happened
 * to return, so the blog index was ordered differently on different machines and could change between deploys.
 */
const byNewest = (a: { slug: string; date: string }, b: { slug: string; date: string }) =>
  b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug);

/** The posts written in `lang`, newest first. A post that exists only in the other language is not listed (rule 3313): it is served at its own language's address, once. */
export const listIn = (entries: PostEntry[], lang: Lang): Post[] => entries.filter((e) => e.langs.includes(lang)).map((e) => postIn(e, lang)).sort(byNewest);
export function listPosts(lang: Lang): Post[] {
  return listIn(readAll(), lang);
}
export function getPost(lang: Lang, slug: string) {
  return listPosts(lang).find((p) => p.slug === slug) ?? null;
}

/**
 * The post at `/{lang}/blog/{slug}` (rule 3313): in `lang` when it is written in it; otherwise the language it exists in,
 * `served` saying which and `fallback` that it is not the visitor's. `null` for a slug no post has.
 */
export function servePost(entries: PostEntry[], lang: Lang, slug: string): { post: Post; served: Served } | null {
  const e = entries.find((x) => x.slug === slug);
  const s = e && serve(lang, e.langs);
  return e && s ? { post: postIn(e, s.lang), served: s } : null;
}
export function getPostServed(lang: Lang, slug: string) {
  return servePost(readAll(), lang, slug);
}

/** Slug, publication date and languages for every post, in the same order the index shows. The sitemap needs the dates and the languages. */
export function postIndex(): { slug: string; date: string; langs: Lang[] }[] {
  return readAll().map((e) => ({ slug: e.slug, date: e.meta.date, langs: e.langs })).sort(byNewest);
}
export function slugs() {
  return postIndex().map((p) => p.slug);
}

/** Small markdown → HTML: headings, paragraphs, lists, tables, bold, links. */
export { render } from "./md";
