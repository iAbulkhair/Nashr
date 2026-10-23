import type { Lang } from "./i18n";
import { langPath } from "./md";
import type { HelpTopic } from "./help";
import type { Post } from "./blog";

/**
 * The Markdown copy of a public page (rule 3316): `/{lang}/blog/{slug}.md` and `/{lang}/help/{topic}.md`, for a reader or a
 * model that wants the text without the page around it, and for the "Copy page as Markdown" button. The idea comes from
 * supastarter's docs (every page has a `.mdx` twin); the code is ours.
 *
 * Pure and import-light (types only from the content modules): the route handlers pass in what the HTML page shows, so the
 * copy can never hold more than the page. It prints the fields the page shows (title, description, date, the author's name
 * and role when the post names one, the address of the page) and the body, and nothing else from the front matter: no
 * `cover`, `languages`, `author` id, draft marker or file name. The body is the stored Markdown, not HTML, so nothing here
 * runs; it is served as `text/markdown` with `nosniff`. Internal links are made absolute and carry the served language, the
 * way `render` writes them on the page, so they work when the file is read elsewhere.
 */

/** The address of the HTML page the copy is of. */
export const pageUrl = (origin: string, lang: Lang, path: string): string => `${origin}/${lang}${path}`;
/** The address of the copy. */
export const markdownUrl = (origin: string, lang: Lang, path: string): string => `${pageUrl(origin, lang, path)}.md`;

const ONE_LINE = (s: string) => s.replace(/\s+/g, " ").trim();
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** `](/path)`, optionally with a title: the part of a Markdown link or image that holds an address of this site. */
const INTERNAL = /\]\((\/(?!\/)[^)\s]*)((?:\s+"[^"]*")?)\)/g;

/**
 * The body with each site-relative link made absolute, with the language of the text. Lines inside a fenced block are left
 * as written: code that shows a link is not a link.
 */
export function absoluteLinks(body: string, lang: Lang, origin: string): string {
  let fence: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      const m = line.match(FENCE);
      if (fence) {
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
        return line;
      }
      if (m) {
        fence = m[1];
        return line;
      }
      return line.replace(INTERNAL, (_all, path: string, title: string) => `](${origin}${langPath(path, lang)}${title})`);
    })
    .join("\n");
}

/** A post as Markdown, in the language it is written in (`lang`, the one the page shows). */
export function postMarkdown(origin: string, lang: Lang, p: Post): string {
  const ar = lang === "ar";
  const meta = [`${ar ? "التاريخ" : "Date"}: ${p.date}`];
  if (p.author) meta.push(`${ar ? "الكاتب" : "Author"}: ${ONE_LINE(p.author.name)}, ${ONE_LINE(p.author.role)}`);
  meta.push(`${ar ? "الصفحة" : "Page"}: ${pageUrl(origin, lang, `/blog/${p.slug}`)}`);
  return [`# ${ONE_LINE(p.title)}`, "", `> ${ONE_LINE(p.desc)}`, "", meta.join("  \n"), "", absoluteLinks(p.body.trim(), lang, origin), ""].join("\n");
}

/**
 * A help topic as Markdown: its title, then each question as a heading with its answer under it. The answers are plain text
 * (the page prints them as text), with the `{origin}` slot already filled by the caller.
 */
export function topicMarkdown(origin: string, lang: Lang, t: HelpTopic): string {
  const out = [`# ${ONE_LINE(t.title[lang])}`, "", `${lang === "ar" ? "الصفحة" : "Page"}: ${pageUrl(origin, lang, `/help/${t.id}`)}`];
  for (const i of t.items) out.push("", `## ${ONE_LINE(i.q[lang])}`, "", i.a[lang].trim());
  return out.join("\n") + "\n";
}

/** The headers every Markdown copy carries: the type, no sniffing, out of search results, the language, and the page it copies. */
export function markdownHeaders(lang: Lang, canonical: string): Record<string, string> {
  return {
    "Content-Type": "text/markdown; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Content-Language": lang,
    Link: `<${canonical}>; rel="canonical"`,
  };
}
