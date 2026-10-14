import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { agentById } from "@/lib/agents";
import { INDUSTRY_PAGES, INDUSTRY_SLUGS } from "@/lib/pages-industry";
import { FOR_VOICE } from "@/lib/pages-voice";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Pricing from "@/components/Pricing";
import FinalCta from "@/components/FinalCta";
import { QaList } from "@/components/Faq";
import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import Doodle from "@/components/home/Doodle";
import Face from "@/components/home/Face";
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
  const t = dict[lang], v = FOR_VOICE[lang], rtl = lang === "ar";
  const lead = p.team[0].who;
  return (
    <>
      <Nav t={t} lang={lang} />
      <main id="main" tabIndex={-1}>
        <section className="section-wrap grid grid-cols-[minmax(0,1fr)] items-end gap-10 md:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <p className="eyebrow">{p.name}</p>
            <h1 className="mt-3 max-w-3xl font-display text-4xl font-bold leading-tight sm:text-6xl">
              <span className="s-ul">
                <ScribbleStatic kind="underline" seed="for-h" rtl={rtl} />
                {p.headline}
              </span>
            </h1>
            <p className="mt-5 max-w-2xl text-lg text-foreground-muted">{p.sub}</p>
            <Link href={`/${lang}/app/signup`} className="s-btn mt-8"><Scribble kind="pill" seed={`for-${p.slug}-go`} fill="ink" shadow ring />{t.hero.cta}</Link>
          </div>
          {/* The member who leads on this page, standing on their colour as on the agent pages. Decoration. */}
          <div className="relative isolate mx-auto w-24 sm:w-32" aria-hidden="true" data-for-lead={lead}>
            <span className="absolute -inset-x-[8%] -bottom-2 isolate h-6 opacity-50"><Scribble kind="puddle" seed={`for-pud-${p.slug}`} fill={`agent-${lead}`} /></span>
            <span className="relative z-[1] block"><Doodle who={lead} /></span>
          </div>
        </section>
        <section className="mx-auto grid max-w-6xl gap-10 px-4 pb-16 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 className="font-display text-2xl font-bold">{v.pains}</h2>
            <ul className="mt-4 space-y-3" role="list">{p.pains.map((x) => <li key={x} className="flex gap-3"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden />{x}</li>)}</ul>
          </div>
          <div>
            <h2 className="font-display text-2xl font-bold">{v.does(agentById("noor").name[lang])}</h2>
            <div className="mt-6 grid gap-x-5 gap-y-6 sm:grid-cols-2">
              {p.workflows.map((w, i) => (
                <div key={w.t} className="s-card">
                  <Scribble kind="box" seed={`for-${p.slug}-${i}`} fill="paper" />
                  <h3 className="font-display font-bold">{w.t}</h3>
                  <p className="mt-1 text-sm text-foreground-muted">{w.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
        {/* Rule 1862: the team speaks on the page, one true line each, in the home page's bubbles. */}
        <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6" aria-labelledby="for-team-h">
          <h2 id="for-team-h" className="font-display text-2xl font-bold">{v.team}</h2>
          <ul className="mt-6 grid gap-x-6 gap-y-6 md:grid-cols-3" role="list" data-for-team>
            {p.team.map((m, i) => {
              const a = agentById(m.who);
              return (
                <li key={`${m.who}-${m.task}`} className="flex items-end gap-3" data-who={m.who}>
                  <span className="flex flex-col items-center gap-1 text-sm font-bold">
                    <Face who={m.who} seed={`for-face-${p.slug}-${i}`} small />
                    <Link href={`/${lang}/agents/${m.who}`} className="inline-flex min-h-[var(--hit-min)] items-center underline">{a.name[lang]}</Link>
                  </span>
                  <p className="s-bubble" data-tail="start">
                    <Scribble kind="bubble" seed={`for-say-${p.slug}-${i}`} tail="start" rtl={rtl} />
                    <span className="sr-only">{a.name[lang]}: </span>
                    {m.line}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="border-y-[1.5px] border-border-strong bg-background-muted">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-3 sm:px-6">
            {p.proof.map((x) => <div key={x.l}><p className="font-display text-4xl font-bold" dir="ltr">{x.n}</p><p className="mt-1 text-sm">{x.l}</p></div>)}
          </div>
        </section>
        <Pricing t={t} lang={lang} />
        <section className="page-wrap">
          <h2 className="font-display text-2xl font-bold">{t.faq.title}</h2>
          <QaList items={p.faq} className="mt-6" />
          <p className="mt-8 text-sm text-foreground-muted">{v.others} {INDUSTRY_PAGES[lang].filter((x) => x.slug !== p.slug).map((x) => <Link key={x.slug} href={`/${lang}/for/${x.slug}`} className="me-3 inline-flex min-h-[var(--hit-min)] items-center font-bold text-foreground underline">{x.name}</Link>)}</p>
        </section>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} />
    </>
  );
}
