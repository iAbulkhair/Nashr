import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { getPostServed, slugs } from "@/lib/blog";
import { renderPost } from "@/lib/blog-render";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ScribbleStatic from "@/components/ScribbleStatic";
import FinalCta from "@/components/FinalCta";
import { PostTags } from "@/components/PostTags";
import LangFallbackNotice from "@/components/LangFallbackNotice";
import PostCover from "@/components/PostCover";
import { postCover } from "@/lib/blog-cover";
import { textAttrs } from "@/lib/lang-fallback";
import { pageMeta } from "@/lib/page-meta";
import { articleJsonLd, ldJson } from "@/lib/home-ld";
import { appOrigin } from "@/lib/origin";

/** Every slug in both languages (rule 3313): a post written in one language is built at the other's address too, as the existing version with a notice. */
export function generateStaticParams() {
  return LANGS.flatMap((lang) => slugs().map((slug) => ({ lang, slug })));
}
export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLang(lang)) return {};
  const r = getPostServed(lang, slug);
  if (!r) return {};
  const { post: p, served } = r;
  // Titles and descriptions are the existing version's own words; the brand suffix follows the language of the words.
  return pageMeta(lang, `/blog/${slug}`, { title: `${p.title} — ${served.lang === "ar" ? "ذكين" : "Thakeen"}`, description: p.desc, bilingual: p.langs.length === 2, served: served.lang });
}

export default async function Page({ params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang, slug } = await params;
  if (!isLang(lang)) notFound();
  const r = getPostServed(lang, slug);
  if (!r) notFound();
  const { post: p, served } = r;
  const t = dict[lang];
  // The words are in `served.lang`; the page around them stays in the visitor's language (rule 3313).
  const sl = served.lang;
  const text = served.fallback ? textAttrs(sl) : {};
  return (
    <>
      {/* Rule 1978: the post as an Article for search engines, escaped by `ldJson` so no text can close the script. Its url and language are the version that exists. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ldJson(articleJsonLd(sl, appOrigin(), p)) }} />
      <Nav t={t} lang={lang} />
      <main id="main" tabIndex={-1}>
        <div className="page-wrap">
          <LangFallbackNotice visitor={lang} served={sl} />
          <div {...text}>
            <p className="font-mono text-xs text-foreground-muted" dir="ltr">{p.date}</p>
            <h1 className="mt-2 font-display text-3xl font-bold leading-tight sm:text-5xl"><span className="s-ul"><ScribbleStatic kind="underline" seed="post-h" rtl={sl === "ar"} />{p.title}</span></h1>
            <p className="mt-4 text-lg text-foreground-muted">{p.desc}</p>
            <PostTags lang={sl} tags={p.tags} label={sl === "ar" ? "وسوم المقال" : "Post tags"} />
            <PostCover cover={postCover(sl, p.slug, p.cover)} />
            <article className="prose-nashr mt-10" dangerouslySetInnerHTML={{ __html: renderPost(sl, p.body) }} />
          </div>
        </div>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} />
    </>
  );
}
