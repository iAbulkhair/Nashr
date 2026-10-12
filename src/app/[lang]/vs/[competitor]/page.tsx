import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { VS_PAGES, VS_SLUGS } from "@/lib/pages-vs";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import FinalCta from "@/components/FinalCta";
import { QaList } from "@/components/Faq";
import Scribble from "@/components/Scribble";
import TickList from "@/components/TickList";
import { pageMeta } from "@/lib/page-meta";

export function generateStaticParams() {
  return LANGS.flatMap((lang) => VS_SLUGS.map((competitor) => ({ lang, competitor })));
}
export async function generateMetadata({ params }: { params: Promise<{ lang: string; competitor: string }> }): Promise<Metadata> {
  const { lang, competitor } = await params;
  if (!isLang(lang)) return {};
  const p = VS_PAGES[lang].find((x) => x.slug === competitor);
  const other = lang === "ar" ? "en" : "ar";
  return p ? pageMeta(lang, `/vs/${competitor}`, { title: p.title, description: p.tldr.slice(0, 160), bilingual: VS_PAGES[other].some((x) => x.slug === competitor) }) : {};
}

export default async function Page({ params }: { params: Promise<{ lang: string; competitor: string }> }) {
  const { lang, competitor } = await params;
  if (!isLang(lang)) notFound();
  const p = VS_PAGES[lang].find((x) => x.slug === competitor);
  if (!p) notFound();
  const t = dict[lang];
  const us = lang === "ar" ? "نور (ذكين)" : "Noor (Thakeen)";
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <p className="eyebrow">{lang === "ar" ? "مقارنة" : "Comparison"}</p>
        <h1 className="mt-3 font-display text-3xl font-bold leading-tight sm:text-5xl">
          <span className="s-ul">
            <Scribble kind="underline" seed="vs-h" />
            {p.title}
          </span>
        </h1>
        <p className="s-card mt-8 text-lg leading-relaxed">
          <Scribble kind="box" seed={`vs-${p.slug}-tldr`} fill="lemon" />
          {p.tldr}
        </p>
        <div className="mt-10 overflow-x-auto border-y-[1.5px] border-border-strong">
          <table className="w-full text-sm">
            <thead><tr className="border-b-[1.5px] border-border-strong"><th className="p-3 text-start"></th><th className="p-3 text-start font-display">{p.competitor}</th><th className="p-3 text-start font-display">{us}</th></tr></thead>
            <tbody className="divide-y divide-foreground/15">{p.rows.map((r) => <tr key={r.dim}><td className="p-3 font-bold">{r.dim}</td><td className="p-3 text-foreground-muted">{r.them}</td><td className="p-3 font-bold">{r.us}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="mt-10 grid gap-6 sm:grid-cols-2">
          <div className="s-card">
            <Scribble kind="box" seed={`vs-${p.slug}-them`} fill="paper" />
            <h2 className="font-display text-lg font-bold">{lang === "ar" ? `اختر ${p.competitor} إذا:` : `Choose ${p.competitor} if:`}</h2>
            <ul className="mt-3 list-disc space-y-2 ps-5 text-sm text-foreground-muted">{p.chooseThem.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
          <div className="s-card">
            <Scribble kind="box" seed={`vs-${p.slug}-us`} fill="lilac" heavy shadow />
            <h2 className="font-display text-lg font-bold">{lang === "ar" ? "اختر نور إذا:" : "Choose Noor if:"}</h2>
            <TickList items={p.chooseUs} seed={`vs-${p.slug}-us`} className="mt-3 text-sm" />
          </div>
        </div>
        <p className="mt-10 font-display text-2xl font-bold">{p.verdict}</p>
        {p.faq.length > 0 && <QaList items={p.faq} className="mt-10" />}
        <p className="mt-8 text-sm text-foreground-muted">{lang === "ar" ? "مقارنات أخرى:" : "More comparisons:"} {VS_PAGES[lang].filter((x) => x.slug !== p.slug).map((x) => <Link key={x.slug} href={`/${lang}/vs/${x.slug}`} className="me-3 font-bold text-foreground underline">{x.competitor}</Link>)}</p>
      </main>
      <FinalCta t={t} lang={lang} />
      <Footer t={t} />
    </>
  );
}
