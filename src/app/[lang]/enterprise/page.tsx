import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { SITE } from "@/lib/site";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ContactForm from "@/components/ContactForm";
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
        <section className="bg-oasis-deep text-mist">
          <div className="section-wrap">
            <p className="eyebrow eyebrow-accent">{s.eyebrow}</p>
            <h1 className="mt-3 max-w-3xl font-display text-4xl font-bold leading-tight sm:text-6xl">{s.title}</h1>
            <p className="mt-5 max-w-2xl text-lg text-mist-dim">{s.sub}</p>
            <a href="#contact" className="btn btn-accent btn-lg mt-8">{s.formTitle}</a>
          </div>
          <div className="border-t-[1.5px] border-ink" aria-hidden />
        </section>
        <section className="mx-auto grid max-w-6xl gap-4 px-4 py-16 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {s.features.map((f) => <div key={f.t} className="card card-sm"><h2 className="font-display font-medium text-oasis">{f.t}</h2><p className="mt-1 text-sm text-ink/70">{f.d}</p></div>)}
        </section>
        <section className="bg-salt-dim">
          <div id="contact" className="mx-auto grid max-w-6xl scroll-mt-24 gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="font-display text-2xl font-bold">{s.notYetTitle}</h2>
              <ul className="mt-4 space-y-3">{s.notYet.map((x) => <li key={x} className="flex gap-3 text-ink/80"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sadu" />{x}</li>)}</ul>
            </div>
            <div className="card"><h2 className="font-display text-xl font-bold text-oasis">{s.formTitle}</h2><div className="mt-4"><ContactForm lang={lang} kind="enterprise" page="/enterprise" /></div></div>
          </div>
        </section>
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
