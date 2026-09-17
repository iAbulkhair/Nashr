import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { getPost, render, slugs } from "@/lib/blog";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import FinalCta from "@/components/FinalCta";

export function generateStaticParams() {
  return LANGS.flatMap((lang) => slugs().map((slug) => ({ lang, slug })));
}
export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLang(lang)) return {};
  const p = getPost(lang, slug);
  return p ? { title: `${p.title} — ${lang === "ar" ? "نشر" : "Nashr"}`, description: p.desc } : {};
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
      <main className="page-wrap">
        <p className="font-mono text-xs text-ink/50" dir="ltr">{p.date}</p>
        <h1 className="mt-2 font-display text-3xl font-bold leading-tight text-oasis sm:text-5xl">{p.title}</h1>
        <p className="mt-4 text-lg text-ink/70">{p.desc}</p>
        <article className="prose-nashr mt-10" dangerouslySetInnerHTML={{ __html: render(p.body) }} />
      </main>
      <FinalCta t={t} lang={lang} />
      <Footer t={t} />
    </>
  );
}
