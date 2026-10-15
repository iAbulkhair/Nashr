import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { AGENTS, agentById } from "@/lib/agents";
import { AGENT_PAGES, AGENT_SLUGS, isAgentSlug } from "@/lib/site";
import { AGENT_CAST } from "@/lib/home";
import { AGENTS_VOICE } from "@/lib/pages-voice";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import FinalCta from "@/components/FinalCta";
import UrlStart from "@/components/UrlStart";
import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import Doodle from "@/components/home/Doodle";
import Face from "@/components/home/Face";
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
  const t = dict[lang], v = AGENTS_VOICE[lang], a = agentById(agent), p = AGENT_PAGES[lang][agent];
  const asks = appDict[lang].agents[agent].suggestions;
  // Rule 1862: the home page's line for the agent, in its voice, and the first question it answers as its thought.
  const cast = AGENT_CAST.find((x) => x.id === agent);
  const thought = cast?.questions[0];
  const rtl = lang === "ar";
  return (
    <>
      <Nav t={t} lang={lang} />
      <main id="main" tabIndex={-1}>
        <section className="section-wrap grid grid-cols-[minmax(0,1fr)] items-end gap-10 md:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <p className="eyebrow">{a.role[lang]}</p>
            <h1 className="mt-3 font-display text-4xl font-bold leading-tight sm:text-6xl">{a.name[lang]}</h1>
            <p className="mt-4 font-display text-2xl">
              <span className="s-ul">
                <ScribbleStatic kind="underline" seed={`agent-tag-${agent}`} rtl={rtl} />
                {cast?.value[lang] ?? p.tagline}
              </span>
            </p>
            <p className="mt-5 max-w-2xl text-lg text-foreground-muted">{p.intro}</p>
            <div className="mt-8"><UrlStart t={t} lang={lang} /></div>
            {agent !== "noor" && <p className="mt-4 text-sm text-foreground-muted">{v.startWith} <Link href={`/${lang}/agents/noor`} className="inline-flex min-h-[var(--hit-min)] items-center font-bold text-foreground underline">{agentById("noor").name[lang]}</Link></p>}
          </div>
          <div className="mx-auto flex max-w-[16rem] flex-col items-center">
            {thought && (
              <p className="s-cloud text-base" data-on-mind>
                <Scribble kind="cloud" seed={`agent-think-${agent}`} rtl={rtl} />
                <span className="sr-only">{v.onMind}: </span>
                {thought[lang]}
              </p>
            )}
            {/* The agent standing on its own colour, as in the homepage lineup. */}
            <div className="relative isolate w-24 sm:w-32" aria-hidden="true">
              <span className="absolute -inset-x-[8%] -bottom-2 isolate h-6 opacity-50"><Scribble kind="puddle" seed={`agent-pud-${agent}`} fill={`agent-${agent}`} /></span>
              <span className="relative z-[1] block"><Doodle who={agent} /></span>
            </div>
          </div>
        </section>
        <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
          <h2 className="font-display text-2xl font-bold">{v.does}</h2>
          <div className="mt-6 grid gap-x-6 gap-y-8 sm:grid-cols-3">
            {p.outcomes.map((o) => (
              <div key={o.t} className="s-card">
                <Scribble kind="box" seed={`agent-out-${o.t.length}-${o.d.length}`} fill="paper" />
                <h3 className="font-display text-lg font-bold">{o.t}</h3>
                <p className="mt-1 text-sm text-foreground-muted">{o.d}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="border-y-[1.5px] border-border-strong bg-background-muted">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="font-display text-2xl font-bold">{v.works}</h2>
              <ol className="mt-5 space-y-4" role="list">
                {p.works.map((w, i) => (
                  <li key={w} className="flex items-start gap-3">
                    <span className="s-num !h-8 !w-8 !text-base">
                      <Scribble kind="circleLoop" seed={`agent-num-${i}`} fill="paper" />
                      <span className="tnum">{i + 1}</span>
                    </span>
                    <span className="pt-1">{w}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h2 className="font-display text-2xl font-bold">{v.asks}</h2>
              <ul className="mt-5 flex flex-wrap gap-3" role="list">
                {asks.map((q, i) => (
                  <li key={q} className="max-w-full">
                    <Link href={`/${lang}/app/chat?${agent === "noor" ? "" : `agent=${agent}&`}prompt=${encodeURIComponent(q)}`} className="s-chip inline-flex max-w-full items-center text-start">
                      <Scribble kind="pill" seed={`agent-ask-${i}`} fill="paper" />
                      {q}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
        <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="font-display text-2xl font-bold">{v.others}</h2>
          <div className="mt-6 grid gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {AGENTS.filter((x) => x.id !== agent).map((x) => (
              <Link key={x.id} href={`/${lang}/agents/${x.id}`} className="s-card flex items-center gap-3 !py-3" data-boil>
                <Scribble kind="box" seed={`agent-other-${x.id}`} fill="paper" boil />
                <Face who={x.id} seed={`agent-other-face-${x.id}`} small />
                <span><span className="block font-display font-bold">{x.name[lang]}</span><span className="block text-sm text-foreground-muted">{x.role[lang]}</span></span>
              </Link>
            ))}
          </div>
        </section>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
