import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { AGENTS } from "@/lib/agents";
import { AGENT_PAGES, SITE } from "@/lib/site";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import FinalCta from "@/components/FinalCta";
import UrlStart from "@/components/UrlStart";
import { pageMeta } from "@/lib/page-meta";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  return pageMeta(lang, "/agents", { title: `${SITE[lang].agents.title} — ${dict[lang].brand}`, description: SITE[lang].agents.sub });
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang], s = SITE[lang].agents;
  return (
    <>
      <Nav t={t} lang={lang} />
      <main>
        <section className="bg-oasis-deep text-mist">
          <div className="section-wrap">
            <p className="eyebrow eyebrow-accent">{s.eyebrow}</p>
            <h1 className="mt-3 max-w-3xl font-display text-4xl font-bold leading-tight sm:text-6xl">{s.title}</h1>
            <p className="mt-5 max-w-2xl text-lg text-mist-dim">{s.sub}</p>
            <div className="mt-8"><UrlStart t={t} lang={lang} /></div>
          </div>
          <div className="sadu" aria-hidden />
        </section>
        <section className="mx-auto grid max-w-6xl gap-4 px-4 py-16 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {AGENTS.map((a, i) => (
            <Link key={a.id} href={`/${lang}/agents/${a.id}`} className={`card transition hover:border-oasis ${i === 0 ? "sm:col-span-2 lg:col-span-3" : ""}`}>
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-oasis font-display text-lg font-bold text-saffron" aria-hidden>{a.name[lang].charAt(0)}</span>
                <div><h2 className="font-display text-xl font-bold text-oasis">{a.name[lang]}</h2><p className="text-sm text-ink/60">{a.role[lang]}</p></div>
              </div>
              <p className="mt-3 font-medium">{AGENT_PAGES[lang][a.id].tagline}</p>
              <p className="mt-1 text-sm text-ink/70">{AGENT_PAGES[lang][a.id].intro}</p>
            </Link>
          ))}
        </section>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
