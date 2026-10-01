import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { SITE } from "@/lib/site";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ContactForm from "@/components/ContactForm";
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
        <section className="bg-oasis-deep text-mist">
          <div className="section-wrap">
            <p className="eyebrow eyebrow-accent">{s.eyebrow}</p>
            <h1 className="mt-3 font-display text-4xl font-bold leading-tight sm:text-6xl">{s.title}</h1>
            <p className="mt-5 max-w-2xl text-lg text-mist-dim">{s.sub}</p>
          </div>
          <div className="sadu" aria-hidden />
        </section>
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="font-display text-2xl font-bold">{s.whoTitle}</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{INDUSTRY_PAGES[lang].map((p) => <Link key={p.slug} href={`/${lang}/for/${p.slug}`} className="card card-sm transition hover:border-oasis"><h3 className="font-display font-medium text-oasis">{p.name}</h3><p className="mt-1 text-sm text-ink/70">{p.headline}</p></Link>)}</div>
        </section>
        <section className="bg-salt-dim">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="font-display text-2xl font-bold">{s.honestTitle}</h2>
              <p className="mt-3 text-ink/80">{s.honest}</p>
              <h2 className="mt-8 font-display text-2xl font-bold">{s.programTitle}</h2>
              <ul className="mt-4 space-y-3">{s.program.map((x) => <li key={x} className="flex gap-3 text-ink/80"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-oasis" />{x}</li>)}</ul>
            </div>
            <div className="card"><h2 className="font-display text-xl font-bold text-oasis">{s.formTitle}</h2><div className="mt-4"><ContactForm lang={lang} kind="early-adopter" page="/customers" /></div></div>
          </div>
        </section>
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
