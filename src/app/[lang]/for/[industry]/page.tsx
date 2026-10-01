import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { INDUSTRY_PAGES, INDUSTRY_SLUGS } from "@/lib/pages-industry";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Pricing from "@/components/Pricing";
import FinalCta from "@/components/FinalCta";

export function generateStaticParams() {
  return LANGS.flatMap((lang) => INDUSTRY_SLUGS.map((industry) => ({ lang, industry })));
}
export async function generateMetadata({ params }: { params: Promise<{ lang: string; industry: string }> }): Promise<Metadata> {
  const { lang, industry } = await params;
  if (!isLang(lang)) return {};
  const p = INDUSTRY_PAGES[lang].find((x) => x.slug === industry);
  return p ? { title: `${p.headline} — ${lang === "ar" ? "ذكين" : "Thakeen"} ${p.name}`, description: p.sub } : {};
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
        <section className="bg-oasis-deep text-mist">
          <div className="section-wrap">
            <p className="eyebrow eyebrow-accent">{p.name}</p>
            <h1 className="mt-3 font-display text-4xl font-bold leading-tight sm:text-6xl">{p.headline}</h1>
            <p className="mt-5 max-w-2xl text-lg text-mist-dim">{p.sub}</p>
            <Link href={`/${lang}/app/signup`} className="mt-8 inline-block rounded-full bg-saffron px-6 py-3 font-semibold text-ink">{t.hero.cta}</Link>
          </div>
          <div className="sadu" aria-hidden />
        </section>
        <section className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 className="font-display text-2xl font-bold">{lang === "ar" ? "ما يحدث اليوم" : "What happens today"}</h2>
            <ul className="mt-4 space-y-3">{p.pains.map((x) => <li key={x} className="flex gap-3 text-ink/80"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sadu" />{x}</li>)}</ul>
          </div>
          <div>
            <h2 className="font-display text-2xl font-bold">{lang === "ar" ? "ما تفعله نور" : "What Noor does"}</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">{p.workflows.map((w) => <div key={w.t} className="card card-sm"><h3 className="font-display font-medium">{w.t}</h3><p className="mt-1 text-sm text-ink/70">{w.d}</p></div>)}</div>
          </div>
        </section>
        <section className="bg-salt-dim"><div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-3 sm:px-6">{p.proof.map((x) => <div key={x.l}><p className="font-display text-4xl font-bold text-oasis" dir="ltr">{x.n}</p><p className="mt-1 text-sm text-ink/70">{x.l}</p></div>)}</div></section>
        <Pricing t={t} lang={lang} />
        <section className="page-wrap">
          <h2 className="font-display text-2xl font-bold">{t.faq.title}</h2>
          <div className="mt-6 divide-y divide-ink/10 border-y border-ink/10">{p.faq.map((f) => <details key={f.q} className="py-4"><summary className="font-display font-medium">{f.q}</summary><p className="mt-2 text-sm text-ink/70">{f.a}</p></details>)}</div>
          <p className="mt-8 text-sm text-ink/60">{lang === "ar" ? "قطاعات أخرى:" : "Other industries:"} {INDUSTRY_PAGES[lang].filter((x) => x.slug !== p.slug).map((x) => <Link key={x.slug} href={`/${lang}/for/${x.slug}`} className="me-3 underline">{x.name}</Link>)}</p>
        </section>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} />
    </>
  );
}
