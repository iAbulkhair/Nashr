import type { Lang } from "./i18n";

/**
 * Blog tags (rule 3140). A post may carry up to `MAX_TAGS` short tags per language in its front matter (`tags_ar`,
 * `tags_en`, comma separated); the blog index lists them as plain links to `/{lang}/blog?tag=...` and shows the posts
 * that carry the chosen one. Everything here is pure (no file system, no request), so the front-matter check, the page
 * and the tests share one reading. The idea comes from supastarter's blog tag filter (apps/marketing/modules/blog/lib/tags.ts);
 * the code is ours.
 */
export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 30;

/** Splits a front-matter value on the Latin and the Arabic comma. An empty value gives no tags; an empty piece stays so the check can name it. */
export function splitTags(value: string | undefined): string[] {
  if (value === undefined || !value.trim()) return [];
  return value.split(/[,،]/).map((t) => t.replace(/\s+/g, " ").trim());
}

/** The form two spellings of one tag share: trimmed, one space between words, lower case (a no-op in Arabic). */
export const tagKey = (tag: string): string => tag.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * What is wrong with one language's tags, empty when nothing is: a tag is never empty, never longer than
 * `MAX_TAG_LENGTH`, never repeated (in any letter case) and there are at most `MAX_TAGS` of them.
 */
export function tagProblems(file: string, field: string, tags: string[]): string[] {
  const out: string[] = [];
  if (tags.length > MAX_TAGS) out.push(`${file}: ${field} has ${tags.length} tags, at most ${MAX_TAGS}`);
  if (tags.some((t) => !t)) out.push(`${file}: ${field} has an empty tag (a stray comma)`);
  if (tags.some((t) => t.length > MAX_TAG_LENGTH)) out.push(`${file}: ${field} has a tag longer than ${MAX_TAG_LENGTH} characters`);
  const keys = tags.filter(Boolean).map(tagKey);
  if (new Set(keys).size !== keys.length) out.push(`${file}: ${field} repeats a tag`);
  return out;
}

/** The `tag` query as the page receives it (a string, a repeated key or nothing): the first value, trimmed, or undefined when blank. */
export function tagFromParam(param: string | string[] | undefined): string | undefined {
  const v = (Array.isArray(param) ? param[0] : param)?.trim();
  return v ? v : undefined;
}

type Tagged = { tags: string[] };

/** Every tag used by some post, once (the first spelling met), sorted for `lang`. */
export function allTags(posts: Tagged[], lang: Lang): string[] {
  const seen = new Map<string, string>();
  for (const p of posts) for (const t of p.tags) if (!seen.has(tagKey(t))) seen.set(tagKey(t), t);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, lang));
}

/** The posts that carry `tag`, compared without regard to letter case; every post when there is no tag. */
export function filterByTag<P extends Tagged>(posts: P[], tag: string | undefined): P[] {
  if (!tag) return posts;
  const k = tagKey(tag);
  return posts.filter((p) => p.tags.some((t) => tagKey(t) === k));
}

export const isActiveTag = (tag: string, active: string | undefined): boolean => !!active && tagKey(tag) === tagKey(active);

/** The index's address, filtered when a tag is given: `/ar/blog` or `/ar/blog?tag=...` with the tag percent-encoded. */
export function blogHref(lang: Lang, tag?: string): string {
  return tag ? `/${lang}/blog?tag=${encodeURIComponent(tag)}` : `/${lang}/blog`;
}
