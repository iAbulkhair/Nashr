import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { AGENTS } from "@/lib/agents";
import { AGENT_CAST } from "@/lib/home";
import { SITE } from "@/lib/site";
import { AGENTS_VOICE } from "@/lib/pages-voice";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import FinalCta from "@/components/FinalCta";
import UrlStart from "@/components/UrlStart";
import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import Face from "@/components/home/Face";
import { pageMeta } from "@/lib/page-meta";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  return pageMeta(lang, "/agents", { title: `${AGENTS_VOICE[lang].title} — ${dict[lang].brand}`, description: AGENTS_VOICE[lang].sub });
}

/** The quotation marks around a question the agent answers: «…» in Arabic, “…” in English. */
const quote = (lang: "ar" | "en", s: string) => (lang === "ar" ? `«${s}»` : `“${s}”`);

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang], v = AGENTS_VOICE[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main id="main" tabIndex={-1}>
        <section className="section-wrap">
          <p className="eyebrow">{SITE[lang].agents.eyebrow}</p>
          <h1 className="mt-3 max-w-3xl font-display text-4xl font-bold leading-tight sm:text-6xl">
            <span className="s-ul">
              <ScribbleStatic kind="underline" seed="agents-h" rtl={lang === "ar"} />
              {v.title}
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-foreground-muted">{v.sub}</p>
          <div className="mt-8"><UrlStart t={t} lang={lang} /></div>
        </section>
        <section className="mx-auto grid max-w-6xl gap-x-6 gap-y-8 px-4 pb-20 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {AGENTS.map((a, i) => {
            // Rule 1862: the home page's line for the agent and the first question it answers, in the home page's voice.
            const c = AGENT_CAST.find((x) => x.id === a.id);
            const q = c?.questions[0];
            return (
              <Link key={a.id} href={`/${lang}/agents/${a.id}`} className={`s-card block ${i === 0 ? "sm:col-span-2 lg:col-span-3" : ""}`} data-boil>
                <Scribble kind="box" seed={`agents-${a.id}`} fill="paper" boil />
                <div className="flex items-center gap-3">
                  <Face who={a.id} seed={`agents-face-${a.id}`} />
                  <div><h2 className="font-display text-xl font-bold">{a.name[lang]}</h2><p className="text-sm text-foreground-muted">{a.role[lang]}</p></div>
                </div>
                {c && <p className="mt-3 font-medium">{c.value[lang]}</p>}
                {q && <p className="mt-1 text-sm text-foreground-muted" data-on-mind><span className="sr-only">{v.onMind}: </span>{quote(lang, q[lang])}</p>}
              </Link>
            );
          })}
        </section>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
