import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { AGENTS, agentById } from "@/lib/agents";
import { AGENT_PAGES, AGENT_SLUGS, SITE, isAgentSlug } from "@/lib/site";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import FinalCta from "@/components/FinalCta";
import UrlStart from "@/components/UrlStart";
import { pageMeta } from "@/lib/page-meta";

export function generateStaticParams() {
  return LANGS.flatMap((lang) => AGENT_SLUGS.map((agent) => ({ lang, agent })));
}
export async function generateMetadata({ params }: { params: Promise<{ lang: string; agent: string }> }): Promise<Metadata> {
  const { lang, agent } = await params;
  if (!isLang(lang) || !isAgentSlug(agent)) return {};
  const a = agentById(agent), p = AGENT_PAGES[lang][agent];
  return pageMeta(lang, `/agents/${agent}`, { title: `${a.name[lang]} · ${a.role[lang]} — ${dict[lang].brand}`, description: p.intro });
}

export default async function Page({ params }: { params: Promise<{ lang: string; agent: string }> }) {
  const { lang, agent } = await params;
  if (!isLang(lang) || !isAgentSlug(agent)) notFound();
  const t = dict[lang], s = SITE[lang].agents, a = agentById(agent), p = AGENT_PAGES[lang][agent];
  const asks = appDict[lang].agents[agent].suggestions;
  return (
    <>
      <Nav t={t} lang={lang} />
      <main>
        <section className="bg-oasis-deep text-mist">
          <div className="section-wrap">
            <p className="eyebrow eyebrow-accent">{a.role[lang]}</p>
            <h1 className="mt-3 font-display text-4xl font-bold leading-tight sm:text-6xl">{a.name[lang]}</h1>
            <p className="mt-3 font-display text-2xl text-saffron">{p.tagline}</p>
            <p className="mt-5 max-w-2xl text-lg text-mist-dim">{p.intro}</p>
            <div className="mt-8"><UrlStart t={t} lang={lang} /></div>
            {agent !== "noor" && <p className="mt-3 text-sm text-mist-dim">{s.startWith} <Link href={`/${lang}/agents/noor`} className="underline">{agentById("noor").name[lang]}</Link></p>}
          </div>
          <div className="border-t-[1.5px] border-ink" aria-hidden />
        </section>
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="font-display text-2xl font-bold">{s.does}</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">{p.outcomes.map((o) => <div key={o.t} className="card card-sm"><h3 className="font-display font-medium text-oasis">{o.t}</h3><p className="mt-1 text-sm text-ink/70">{o.d}</p></div>)}</div>
        </section>
        <section className="bg-salt-dim">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="font-display text-2xl font-bold">{s.works}</h2>
              <ol className="mt-4 space-y-3">{p.works.map((w, i) => <li key={w} className="flex gap-3 text-ink/80"><span className="tnum grid h-6 w-6 shrink-0 place-items-center rounded-full bg-oasis text-xs font-semibold text-mist">{i + 1}</span>{w}</li>)}</ol>
            </div>
            <div>
              <h2 className="font-display text-2xl font-bold">{s.asks}</h2>
              <ul className="mt-4 flex flex-wrap gap-2">{asks.map((q) => <li key={q}><Link href={`/${lang}/app/chat?${agent === "noor" ? "" : `agent=${agent}&`}prompt=${encodeURIComponent(q)}`} className="inline-block rounded-full border border-oasis/30 bg-white px-3 py-1.5 text-sm text-oasis hover:bg-oasis hover:text-mist">{q}</Link></li>)}</ul>
            </div>
          </div>
        </section>
        <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="font-display text-2xl font-bold">{s.others}</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{AGENTS.filter((x) => x.id !== agent).map((x) => <Link key={x.id} href={`/${lang}/agents/${x.id}`} className="card card-sm transition hover:border-oasis"><span className="font-display font-medium text-oasis">{x.name[lang]}</span><span className="block text-sm text-ink/60">{x.role[lang]}</span></Link>)}</div>
        </section>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
