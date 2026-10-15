import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { COMPARE_PAGE } from "@/lib/pages-compare";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import FinalCta from "@/components/FinalCta";
import { QaList } from "@/components/Faq";
import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import TickList from "@/components/TickList";
import { pageMeta } from "@/lib/page-meta";

/**
 * Thakeen compared with kinds of alternative, not with named products (rules 1740-1749). The old `/vs/{competitor}`
 * addresses answer 308 here (next.config.ts, rule 1742).
 */
export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  const p = COMPARE_PAGE[lang];
  return pageMeta(lang, "/compare", { title: p.title, description: p.desc });
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const p = COMPARE_PAGE[lang];
  const t = dict[lang], rtl = lang === "ar";
  const us = lang === "ar" ? "نور (ذكين)" : "Noor (Thakeen)";
  return (
    <>
      <Nav t={t} lang={lang} />
      <main id="main" tabIndex={-1}>
        <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
          <p className="eyebrow">{lang === "ar" ? "مقارنة" : "Comparison"}</p>
          <h1 className="mt-3 font-display text-3xl font-bold leading-tight sm:text-5xl">
            <span className="s-ul">
              <ScribbleStatic kind="underline" seed="compare-h" rtl={rtl} />
              {p.title}
            </span>
          </h1>
          <p className="mt-6 text-lg leading-relaxed">{p.intro}</p>
          <p className="s-card mt-8 text-sm leading-relaxed">
            <Scribble kind="box" seed="compare-disclosure" fill="lemon" />
            {p.disclosure}
          </p>
          <nav aria-label={lang === "ar" ? "الفئات" : "Kinds"} className="mt-8">
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">{p.groups.map((g) => <li key={g.id}><a href={`#${g.id}`} className="inline-flex min-h-6 items-center font-bold underline">{g.name}</a></li>)}</ul>
          </nav>
          {p.groups.map((g) => (
            <section key={g.id} id={g.id} aria-labelledby={`${g.id}-h`} className="mt-16 scroll-mt-24">
              <h2 id={`${g.id}-h`} className="font-display text-2xl font-bold sm:text-3xl">{g.name}</h2>
              <p className="mt-4 leading-relaxed">{g.summary}</p>
              <div className="mt-6 overflow-x-auto border-y-[1.5px] border-border-strong">
                <table className="w-full text-sm">
                  <thead><tr className="border-b-[1.5px] border-border-strong"><th scope="col" className="p-3 text-start"><span className="sr-only">{rtl ? "الجانب" : "Aspect"}</span></th><th scope="col" className="p-3 text-start font-display">{g.name}</th><th scope="col" className="p-3 text-start font-display">{us}</th></tr></thead>
                  <tbody className="divide-y divide-foreground/15">{g.rows.map((r) => <tr key={r.dim}><th scope="row" className="p-3 text-start font-bold">{r.dim}</th><td className="p-3 text-foreground-muted">{r.them}</td><td className="p-3 font-bold">{r.us}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="mt-8 grid gap-6 sm:grid-cols-2">
                <div className="s-card">
                  <Scribble kind="box" seed={`compare-${g.id}-them`} fill="paper" />
                  <h3 className="font-display text-lg font-bold">{lang === "ar" ? "اختر هذا الطريق إذا:" : "Choose this way if:"}</h3>
                  <ul className="mt-3 list-disc space-y-2 ps-5 text-sm text-foreground-muted">{g.chooseThem.map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
                <div className="s-card">
                  <Scribble kind="box" seed={`compare-${g.id}-us`} fill="lilac" heavy shadow />
                  <h3 className="font-display text-lg font-bold">{lang === "ar" ? "اختر نور إذا:" : "Choose Noor if:"}</h3>
                  <TickList items={g.chooseUs} seed={`compare-${g.id}-us`} rtl={rtl} className="mt-3 text-sm" />
                </div>
              </div>
            </section>
          ))}
          <h2 className="mt-16 font-display text-2xl font-bold">{lang === "ar" ? "كيف تختار" : "How to choose"}</h2>
          <p className="mt-4 text-lg leading-relaxed">{p.choose}</p>
          <QaList items={p.faq} className="mt-10" />
        </div>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
