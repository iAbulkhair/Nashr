import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { TOOLS, getTool } from "@/lib/tools";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Scribble from "@/components/Scribble";
import ToolForm from "@/components/ToolForm";
import { pageMeta } from "@/lib/page-meta";

export function generateStaticParams() {
  return LANGS.flatMap((lang) => TOOLS.map((t) => ({ lang, tool: t.slug })));
}
export async function generateMetadata({ params }: { params: Promise<{ lang: string; tool: string }> }): Promise<Metadata> {
  const { lang, tool } = await params;
  const x = getTool(tool);
  if (!x || !isLang(lang)) return {};
  return pageMeta(lang, `/tools/${tool}`, { title: `${x.h1[lang]} — ${lang === "ar" ? "ذكين" : "Thakeen"}`, description: x.desc[lang] });
}

export default async function Page({ params }: { params: Promise<{ lang: string; tool: string }> }) {
  const { lang, tool } = await params;
  if (!isLang(lang)) notFound();
  const x = getTool(tool);
  if (!x) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <Link href={`/${lang}/tools`} className="text-sm font-bold text-ink underline">{lang === "ar" ? "← كل الأدوات" : "← All tools"}</Link>
        <h1 className="mt-4 font-display text-3xl font-bold leading-tight sm:text-4xl"><span className="s-ul"><Scribble kind="underline" seed="tool-h" />{x.h1[lang]}</span></h1>
        <p className="mt-2 max-w-2xl text-muted">{x.desc[lang]}</p>
        <div className="mt-8"><ToolForm tool={x} lang={lang} /></div>
        <section className="mt-16">
          <h2 className="font-display text-xl font-bold">{lang === "ar" ? "أدوات أخرى" : "More tools"}</h2>
          <div className="mt-4 flex flex-wrap gap-3">{TOOLS.filter((y) => y.slug !== x.slug).map((y) => <Link key={y.slug} href={`/${lang}/tools/${y.slug}`} className="s-chip inline-flex items-center"><Scribble kind="pill" seed={`tool-more-${y.slug}`} fill="paper" ring />{y.name[lang]}</Link>)}</div>
        </section>
      </main>
      <Footer t={t} />
    </>
  );
}
