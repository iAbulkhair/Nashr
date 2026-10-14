import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { getPost, render, slugs } from "@/lib/blog";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ScribbleStatic from "@/components/ScribbleStatic";
import FinalCta from "@/components/FinalCta";
import { pageMeta } from "@/lib/page-meta";

export function generateStaticParams() {
  return LANGS.flatMap((lang) => slugs().map((slug) => ({ lang, slug })));
}
export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLang(lang)) return {};
  const p = getPost(lang, slug);
  return p ? pageMeta(lang, `/blog/${slug}`, { title: `${p.title} — ${lang === "ar" ? "ذكين" : "Thakeen"}`, description: p.desc, bilingual: !!getPost(lang === "ar" ? "en" : "ar", slug) }) : {};
}

export default async function Page({ params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang, slug } = await params;
  if (!isLang(lang)) notFound();
  const p = getPost(lang, slug);
  if (!p) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main id="main" tabIndex={-1}>
        <div className="page-wrap">
          <p className="font-mono text-xs text-foreground-muted" dir="ltr">{p.date}</p>
          <h1 className="mt-2 font-display text-3xl font-bold leading-tight sm:text-5xl"><span className="s-ul"><ScribbleStatic kind="underline" seed="post-h" rtl={lang === "ar"} />{p.title}</span></h1>
          <p className="mt-4 text-lg text-foreground-muted">{p.desc}</p>
          <article className="prose-nashr mt-10" dangerouslySetInnerHTML={{ __html: render(p.body) }} />
        </div>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} />
    </>
  );
}
