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
import Scribble from "@/components/Scribble";
import Face from "@/components/home/Face";
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
        <section className="section-wrap">
          <p className="eyebrow">{s.eyebrow}</p>
          <h1 className="mt-3 max-w-3xl font-display text-4xl font-bold leading-tight sm:text-6xl">
            <span className="s-ul">
              <Scribble kind="underline" seed="agents-h" />
              {s.title}
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted">{s.sub}</p>
          <div className="mt-8"><UrlStart t={t} lang={lang} /></div>
        </section>
        <section className="mx-auto grid max-w-6xl gap-x-6 gap-y-8 px-4 pb-20 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {AGENTS.map((a, i) => (
            <Link key={a.id} href={`/${lang}/agents/${a.id}`} className={`s-card block ${i === 0 ? "sm:col-span-2 lg:col-span-3" : ""}`} data-boil>
              <Scribble kind="box" seed={`agents-${a.id}`} fill="paper" boil />
              <div className="flex items-center gap-3">
                <Face who={a.id} seed={`agents-face-${a.id}`} />
                <div><h2 className="font-display text-xl font-bold">{a.name[lang]}</h2><p className="text-sm text-muted">{a.role[lang]}</p></div>
              </div>
              <p className="mt-3 font-medium">{AGENT_PAGES[lang][a.id].tagline}</p>
              <p className="mt-1 text-sm text-muted">{AGENT_PAGES[lang][a.id].intro}</p>
            </Link>
          ))}
        </section>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
