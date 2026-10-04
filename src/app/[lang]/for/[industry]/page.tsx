import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { INDUSTRY_PAGES, INDUSTRY_SLUGS } from "@/lib/pages-industry";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Pricing from "@/components/Pricing";
import FinalCta from "@/components/FinalCta";
import { QaList } from "@/components/Faq";
import Scribble from "@/components/Scribble";
import { pageMeta } from "@/lib/page-meta";

export function generateStaticParams() {
  return LANGS.flatMap((lang) => INDUSTRY_SLUGS.map((industry) => ({ lang, industry })));
}
export async function generateMetadata({ params }: { params: Promise<{ lang: string; industry: string }> }): Promise<Metadata> {
  const { lang, industry } = await params;
  if (!isLang(lang)) return {};
  const p = INDUSTRY_PAGES[lang].find((x) => x.slug === industry);
  const other = lang === "ar" ? "en" : "ar";
  return p ? pageMeta(lang, `/for/${industry}`, { title: `${p.headline} — ${lang === "ar" ? "ذكين" : "Thakeen"} ${p.name}`, description: p.sub, bilingual: INDUSTRY_PAGES[other].some((x) => x.slug === industry) }) : {};
}

export default async function Page({ params }: { params: Promise<{ lang: string; industry: string }> }) {
  const { lang, industry } = await params;
  if (!isLang(lang)) notFound();
  const p = INDUSTRY_PAGES[lang].find((x) => x.slug === industry);
  if (!p) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main>
        <section className="section-wrap">
          <p className="eyebrow">{p.name}</p>
          <h1 className="mt-3 max-w-3xl font-display text-4xl font-bold leading-tight sm:text-6xl">
            <span className="s-ul">
              <Scribble kind="underline" seed="for-h" />
              {p.headline}
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted">{p.sub}</p>
          <Link href={`/${lang}/app/signup`} className="s-btn mt-8"><Scribble kind="pill" seed={`for-${p.slug}-go`} fill="ink" shadow ring />{t.hero.cta}</Link>
        </section>
        <section className="mx-auto grid max-w-6xl gap-10 px-4 pb-16 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 className="font-display text-2xl font-bold">{lang === "ar" ? "ما يحدث اليوم" : "What happens today"}</h2>
            <ul className="mt-4 space-y-3" role="list">{p.pains.map((x) => <li key={x} className="flex gap-3"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden />{x}</li>)}</ul>
          </div>
          <div>
            <h2 className="font-display text-2xl font-bold">{lang === "ar" ? "ما تفعله نور" : "What Noor does"}</h2>
            <div className="mt-6 grid gap-x-5 gap-y-6 sm:grid-cols-2">
              {p.workflows.map((w, i) => (
                <div key={w.t} className="s-card">
                  <Scribble kind="box" seed={`for-${p.slug}-${i}`} fill="paper" />
                  <h3 className="font-display font-bold">{w.t}</h3>
                  <p className="mt-1 text-sm text-muted">{w.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="border-y-[1.5px] border-ink bg-lilac">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-3 sm:px-6">
            {p.proof.map((x) => <div key={x.l}><p className="font-display text-4xl font-bold" dir="ltr">{x.n}</p><p className="mt-1 text-sm">{x.l}</p></div>)}
          </div>
        </section>
        <Pricing t={t} lang={lang} />
        <section className="page-wrap">
          <h2 className="font-display text-2xl font-bold">{t.faq.title}</h2>
          <QaList items={p.faq} className="mt-6" />
          <p className="mt-8 text-sm text-muted">{lang === "ar" ? "قطاعات أخرى:" : "Other industries:"} {INDUSTRY_PAGES[lang].filter((x) => x.slug !== p.slug).map((x) => <Link key={x.slug} href={`/${lang}/for/${x.slug}`} className="me-3 font-bold text-ink underline">{x.name}</Link>)}</p>
        </section>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} />
    </>
  );
}
