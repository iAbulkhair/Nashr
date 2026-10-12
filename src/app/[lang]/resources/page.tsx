import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { VS_PAGES } from "@/lib/pages-vs";
import { listPosts } from "@/lib/blog";
import { SITE } from "@/lib/site";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Scribble from "@/components/Scribble";
import FinalCta from "@/components/FinalCta";
import { pageMeta } from "@/lib/page-meta";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  return pageMeta(lang, "/resources", { title: `${SITE[lang].resources.title} — ${dict[lang].brand}`, description: SITE[lang].resources.sub });
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang], s = SITE[lang].resources;
  const posts = listPosts(lang).slice(0, 3);
  return (
    <>
      <Nav t={t} lang={lang} />
      <main>
        <section className="section-wrap">
          <p className="eyebrow">{s.eyebrow}</p>
          <h1 className="mt-3 max-w-3xl font-display text-4xl font-bold leading-tight sm:text-6xl">
            <span className="s-ul">
              <Scribble kind="underline" seed="resources-h" />
              {s.title}
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-foreground-muted">{s.sub}</p>
        </section>
        <section className="mx-auto grid max-w-6xl gap-x-6 gap-y-8 px-4 pb-16 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {s.cards.map((c) => (
            <Link key={c.href} href={`/${lang}${c.href}`} className="s-card block" data-boil>
              <Scribble kind="box" seed={`resources-${c.href}`} fill="paper" boil />
              <h2 className="font-display text-lg font-bold">{c.t}</h2>
              <p className="mt-1 text-sm text-foreground-muted">{c.d}</p>
            </Link>
          ))}
        </section>
        {posts.length > 0 && (
          <section className="border-y-[1.5px] border-border-strong bg-background-muted">
            <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
              <h2 className="font-display text-2xl font-bold">{s.cards[0].t}</h2>
              <div className="mt-6 grid gap-x-6 gap-y-8 sm:grid-cols-3">
                {posts.map((p) => (
                  <Link key={p.slug} href={`/${lang}/blog/${p.slug}`} className="s-card block" data-boil>
                    <Scribble kind="box" seed={`resources-post-${p.slug}`} fill="paper" boil />
                    <h3 className="font-display font-bold">{p.title}</h3>
                    <p className="mt-1 text-sm text-foreground-muted">{p.desc}</p>
                  </Link>
                ))}
              </div>
            </div>
          </section>
        )}
        <section id="compare" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-14 sm:px-6">
          <h2 className="font-display text-2xl font-bold">{s.compare}</h2>
          <ul className="mt-5 flex flex-wrap gap-3">{VS_PAGES[lang].map((v) => <li key={v.slug} className="max-w-full"><Link href={`/${lang}/vs/${v.slug}`} className="s-chip inline-flex max-w-full items-center text-start"><Scribble kind="pill" seed={`resources-vs-${v.slug}`} fill="paper" ring />{v.title}</Link></li>)}</ul>
        </section>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
