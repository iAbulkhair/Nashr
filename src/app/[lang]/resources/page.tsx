import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { VS_PAGES } from "@/lib/pages-vs";
import { listPosts } from "@/lib/blog";
import { SITE } from "@/lib/site";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
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
        <section className="bg-oasis-deep text-mist">
          <div className="section-wrap">
            <p className="eyebrow eyebrow-accent">{s.eyebrow}</p>
            <h1 className="mt-3 font-display text-4xl font-bold leading-tight sm:text-6xl">{s.title}</h1>
            <p className="mt-5 max-w-2xl text-lg text-mist-dim">{s.sub}</p>
          </div>
          <div className="sadu" aria-hidden />
        </section>
        <section className="mx-auto grid max-w-6xl gap-4 px-4 py-16 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {s.cards.map((c) => <Link key={c.href} href={`/${lang}${c.href}`} className="card transition hover:border-oasis"><h2 className="font-display text-lg font-medium text-oasis">{c.t}</h2><p className="mt-1 text-sm text-ink/70">{c.d}</p></Link>)}
        </section>
        {posts.length > 0 && (
          <section className="bg-salt-dim">
            <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
              <h2 className="font-display text-2xl font-bold">{s.cards[0].t}</h2>
              <div className="mt-5 grid gap-4 sm:grid-cols-3">{posts.map((p) => <Link key={p.slug} href={`/${lang}/blog/${p.slug}`} className="card card-sm transition hover:border-oasis"><h3 className="font-display font-medium text-oasis">{p.title}</h3><p className="mt-1 text-sm text-ink/70">{p.desc}</p></Link>)}</div>
            </div>
          </section>
        )}
        <section id="compare" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-14 sm:px-6">
          <h2 className="font-display text-2xl font-bold">{s.compare}</h2>
          <ul className="mt-4 flex flex-wrap gap-2">{VS_PAGES[lang].map((v) => <li key={v.slug}><Link href={`/${lang}/vs/${v.slug}`} className="inline-block rounded-full border border-oasis/30 px-3 py-1.5 text-sm text-oasis hover:bg-oasis hover:text-mist">{v.title}</Link></li>)}</ul>
        </section>
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} lang={lang} />
    </>
  );
}
