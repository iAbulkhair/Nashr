import { isLang, LANGS } from "@/lib/i18n";
import { HELP, helpTopics, serveTopic } from "@/lib/help";
import { appOrigin } from "@/lib/origin";
import { markdownHeaders, pageUrl, topicMarkdown } from "@/lib/page-markdown";

/**
 * `/{lang}/help/{topic}.md` (rule 3316): the help topic as Markdown, the title and each question with its answer. Same
 * shape, same reasons and same caching as the blog's (src/app/[lang]/blog/[slug]/md/route.ts): public, read-only, built once
 * at build time, limited to the topics and languages `generateStaticParams` lists, `noindex`. The answers carry the canonical
 * origin in place of the `{origin}` slot, as the help pages do. A topic written in one language is served on the other
 * language's address in the language it exists in (rule 3313).
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return LANGS.flatMap((lang) => HELP.map((t) => ({ lang, topic: t.id })));
}

export async function GET(_req: Request, { params }: { params: Promise<{ lang: string; topic: string }> }) {
  const { lang, topic } = await params;
  const base = appOrigin();
  const t = isLang(lang) ? helpTopics(base).find((x) => x.id === topic) : undefined;
  const s = t && isLang(lang) ? serveTopic(t, lang) : null;
  if (!t || !s) return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" } });
  return new Response(topicMarkdown(base, s.lang, t), { headers: markdownHeaders(s.lang, pageUrl(base, s.lang, `/help/${t.id}`)) });
}
