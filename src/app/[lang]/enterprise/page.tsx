import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { SITE } from "@/lib/site";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ContactForm from "@/components/ContactForm";
import Scribble from "@/components/Scribble";
import { pageMeta } from "@/lib/page-meta";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  return pageMeta(lang, "/enterprise", { title: `${SITE[lang].enterprise.title} — ${dict[lang].brand}`, description: SITE[lang].enterprise.sub });
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang], s = SITE[lang].enterprise;
  return (
    <>
      <Nav t={t} lang={lang} />
      <main>
        <section className="section-wrap">
          <p className="eyebrow">{s.eyebrow}</p>
          <h1 className="mt-3 max-w-3xl font-display text-4xl font-bold leading-tight sm:text-6xl">
            <span className="s-ul">
              <Scribble kind="underline" seed="enterprise-h" />
              {s.title}
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-foreground-muted">{s.sub}</p>
          <a href="#contact" className="s-btn mt-8"><Scribble kind="pill" seed="enterprise-go" fill="ink" shadow ring />{s.formTitle}</a>
        </section>
        <section className="mx-auto grid max-w-6xl gap-x-6 gap-y-8 px-4 pb-16 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {s.features.map((f, i) => (
            <div key={f.t} className="s-card">
              <Scribble kind="box" seed={`enterprise-${i}`} fill="paper" />
              <h2 className="font-display text-lg font-bold">{f.t}</h2>
              <p className="mt-1 text-sm text-foreground-muted">{f.d}</p>
            </div>
          ))}
        </section>
        <section className="border-y-[1.5px] border-border-strong bg-background-muted">
          <div id="contact" className="mx-auto grid max-w-6xl scroll-mt-24 grid-cols-[minmax(0,1fr)] gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="font-display text-2xl font-bold">{s.notYetTitle}</h2>
              <ul className="mt-4 space-y-3" role="list">{s.notYet.map((x) => <li key={x} className="flex gap-3"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" aria-hidden />{x}</li>)}</ul>
            </div>
            <div className="s-card">
              <Scribble kind="box" seed="enterprise-form" fill="paper" heavy shadow />
              <h2 className="font-display text-xl font-bold">{s.formTitle}</h2>
              <div className="mt-4"><ContactForm lang={lang} kind="enterprise" page="/enterprise" /></div>
            </div>
          </div>
        </section>
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
