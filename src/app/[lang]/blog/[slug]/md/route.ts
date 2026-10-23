import { isLang, LANGS } from "@/lib/i18n";
import { getPostServed, slugs } from "@/lib/blog";
import { appOrigin } from "@/lib/origin";
import { markdownHeaders, pageUrl, postMarkdown } from "@/lib/page-markdown";

/**
 * `/{lang}/blog/{slug}.md` (rule 3316): the post as Markdown. `next.config.ts` rewrites that public address to this folder
 * (a folder cannot be named `[slug].md`). The idea is supastarter's (every docs page has a text twin); the code is ours.
 *
 * Public and read-only, and it takes no input but the two path parameters, which `dynamicParams = false` limits to the pairs
 * built below, so there is nothing to authenticate or to rate-limit: like the sitemap and `/llms-full.txt` it is built once at
 * build time (`force-static`) and served as a file. It prints what the post's page shows and nothing from the front matter
 * beyond that (src/lib/page-markdown.ts). There is no draft state in the blog: a file in `content/blog` is published, so this
 * serves exactly the posts the page, the sitemap and `/llms-full.txt` serve. A post written in one language is served on the
 * other language's address in the language it exists in, as the page is (rule 3313). `noindex`: the page is what search lists.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return LANGS.flatMap((lang) => slugs().map((slug) => ({ lang, slug })));
}

export async function GET(_req: Request, { params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang, slug } = await params;
  const r = isLang(lang) ? getPostServed(lang, slug) : null;
  if (!r) return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" } });
  const base = appOrigin();
  const sl = r.served.lang;
  return new Response(postMarkdown(base, sl, r.post), { headers: markdownHeaders(sl, pageUrl(base, sl, `/blog/${slug}`)) });
}
