import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { SITE } from "@/lib/site";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ContactForm from "@/components/ContactForm";
import Scribble from "@/components/Scribble";
import TickList from "@/components/TickList";
import { pageMeta } from "@/lib/page-meta";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  return pageMeta(lang, "/customers", { title: `${SITE[lang].customers.title} — ${dict[lang].brand}`, description: SITE[lang].customers.sub });
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang], s = SITE[lang].customers;
  return (
    <>
      <Nav t={t} lang={lang} />
      <main>
        <section className="section-wrap">
          <p className="eyebrow">{s.eyebrow}</p>
          <h1 className="mt-3 max-w-3xl font-display text-4xl font-bold leading-tight sm:text-6xl">
            <span className="s-ul">
              <Scribble kind="underline" seed="customers-h" />
              {s.title}
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted">{s.sub}</p>
        </section>
        <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
          <h2 className="font-display text-2xl font-bold">{s.whoTitle}</h2>
          <div className="mt-6 grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {INDUSTRY_PAGES[lang].map((p) => (
              <Link key={p.slug} href={`/${lang}/for/${p.slug}`} className="s-card block" data-boil>
                <Scribble kind="box" seed={`customers-${p.slug}`} fill="paper" boil />
                <h3 className="font-display text-lg font-bold">{p.name}</h3>
                <p className="mt-1 text-sm text-muted">{p.headline}</p>
              </Link>
            ))}
          </div>
        </section>
        <section className="border-y-[1.5px] border-ink bg-lilac">
          <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="font-display text-2xl font-bold">{s.honestTitle}</h2>
              <p className="mt-3">{s.honest}</p>
              <h2 className="mt-8 font-display text-2xl font-bold">{s.programTitle}</h2>
              <TickList items={s.program} seed="customers-program" className="mt-4" />
            </div>
            <div className="s-card">
              <Scribble kind="box" seed="customers-form" fill="paper" heavy shadow />
              <h2 className="font-display text-xl font-bold">{s.formTitle}</h2>
              <div className="mt-4"><ContactForm lang={lang} kind="early-adopter" page="/customers" /></div>
            </div>
          </div>
        </section>
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
