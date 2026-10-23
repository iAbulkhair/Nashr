import { dict, LANGS, type Lang } from "@/lib/i18n";
import { helpTopicsIn } from "@/lib/help";
import { listPosts } from "@/lib/blog";
import { SITE_DEFAULT } from "@/lib/page-meta";
import { appOrigin } from "@/lib/origin";

/**
 * `/llms-full.txt` (rule 3143): the text behind `/llms.txt`, in one file for a language model that wants to read the answers
 * instead of following links. The idea comes from supastarter's docs app (apps/docs/app/llms-full.txt/route.ts, every docs
 * page as text); the code is ours.
 *
 * It prints two kinds of public copy and nothing else: every help answer (the same text the help pages show, with the
 * `{origin}` slot filled by the canonical origin exactly as they do) and every blog post's title, date, description and body,
 * as the blog pages read them. The words are the site's own; this file writes no sentence, claim or number. Nothing here
 * comes from a workspace, an account, a connection or the environment other than the public origin, so there is nothing
 * private to leak. Arabic comes first, as on the site, then English; each heading's address is a page src/app/sitemap.ts lists.
 *
 * Same rules and caching as `/llms.txt` (rule 698): built once at build time (`force-static`) and served as a file, so no
 * handler runs per request and, like the sitemap and robots, it carries no rate limit and names the origin APP_ORIGIN had at
 * build time. It is public and read-only, and takes no input.
 */
export const dynamic = "force-static";

/** One line of copy: titles and descriptions may carry line breaks, which would end a heading early. */
const line = (s: string) => s.replace(/\s+/g, " ").trim();

function section(lang: Lang, base: string): string[] {
  const out: string[] = [`# ${dict[lang].brand} (${lang})`, "", `> ${line(SITE_DEFAULT[lang].description)}`];
  for (const t of helpTopicsIn(base, lang)) {
    out.push("", `## ${line(t.title[lang])}`, `<${base}/${lang}/help/${t.id}>`);
    for (const i of t.items) out.push("", `### ${line(i.q[lang])}`, "", i.a[lang].trim());
  }
  for (const p of listPosts(lang)) {
    out.push("", `## ${line(p.title)}`, `<${base}/${lang}/blog/${p.slug}>`, "", p.date, "", line(p.desc), "", p.body.trim());
  }
  return out;
}

export function GET() {
  const base = appOrigin();
  const out = LANGS.flatMap((lang, i) => (i === 0 ? section(lang, base) : ["", "---", "", ...section(lang, base)]));
  return new Response(out.join("\n") + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
