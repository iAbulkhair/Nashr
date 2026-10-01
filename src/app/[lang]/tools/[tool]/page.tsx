import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { TOOLS, getTool } from "@/lib/tools";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ToolForm from "@/components/ToolForm";

export function generateStaticParams() {
  return LANGS.flatMap((lang) => TOOLS.map((t) => ({ lang, tool: t.slug })));
}
export async function generateMetadata({ params }: { params: Promise<{ lang: string; tool: string }> }): Promise<Metadata> {
  const { lang, tool } = await params;
  const x = getTool(tool);
  if (!x || !isLang(lang)) return {};
  return { title: `${x.h1[lang]} — ${lang === "ar" ? "ذكين" : "Thakeen"}`, description: x.desc[lang] };
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
        <Link href={`/${lang}/tools`} className="text-sm text-ink/60 underline">{lang === "ar" ? "← كل الأدوات" : "← All tools"}</Link>
        <h1 className="mt-4 page-title sm:text-4xl">{x.h1[lang]}</h1>
        <p className="mt-2 max-w-2xl text-ink/70">{x.desc[lang]}</p>
        <div className="mt-8"><ToolForm tool={x} lang={lang} /></div>
        <section className="mt-16">
          <h2 className="font-display text-xl font-bold">{lang === "ar" ? "أدوات أخرى" : "More tools"}</h2>
          <div className="mt-4 flex flex-wrap gap-2">{TOOLS.filter((y) => y.slug !== x.slug).map((y) => <Link key={y.slug} href={`/${lang}/tools/${y.slug}`} className="rounded-full border border-ink/15 bg-white px-3 py-1 text-sm">{y.name[lang]}</Link>)}</div>
        </section>
      </main>
      <Footer t={t} />
    </>
  );
}
