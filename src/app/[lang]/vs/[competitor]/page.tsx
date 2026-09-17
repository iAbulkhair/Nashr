import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { VS_PAGES, VS_SLUGS } from "@/lib/pages-vs";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import FinalCta from "@/components/FinalCta";

export function generateStaticParams() {
  return LANGS.flatMap((lang) => VS_SLUGS.map((competitor) => ({ lang, competitor })));
}
export async function generateMetadata({ params }: { params: Promise<{ lang: string; competitor: string }> }): Promise<Metadata> {
  const { lang, competitor } = await params;
  if (!isLang(lang)) return {};
  const p = VS_PAGES[lang].find((x) => x.slug === competitor);
  return p ? { title: p.title, description: p.tldr.slice(0, 160) } : {};
}

export default async function Page({ params }: { params: Promise<{ lang: string; competitor: string }> }) {
  const { lang, competitor } = await params;
  if (!isLang(lang)) notFound();
  const p = VS_PAGES[lang].find((x) => x.slug === competitor);
  if (!p) notFound();
  const t = dict[lang];
  const us = lang === "ar" ? "نور (نشر)" : "Noor (Nashr)";
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <p className="eyebrow">{lang === "ar" ? "مقارنة" : "Comparison"}</p>
        <h1 className="mt-3 font-display text-3xl font-bold leading-tight text-oasis sm:text-5xl">{p.title}</h1>
        <p className="mt-6 rounded-xl border border-saffron/40 bg-saffron/10 p-5 text-lg leading-relaxed">{p.tldr}</p>
        <div className="mt-10 overflow-x-auto rounded-xl border border-ink/10">
          <table className="w-full text-sm">
            <thead className="bg-oasis text-mist"><tr><th className="p-3 text-start"></th><th className="p-3 text-start">{p.competitor}</th><th className="p-3 text-start">{us}</th></tr></thead>
            <tbody>{p.rows.map((r) => <tr key={r.dim} className="border-t border-ink/10 odd:bg-white even:bg-salt-dim"><td className="p-3 font-medium">{r.dim}</td><td className="p-3 text-ink/70">{r.them}</td><td className="p-3 font-medium text-oasis">{r.us}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="mt-10 grid gap-6 sm:grid-cols-2">
          <div className="card"><h2 className="font-display font-medium">{lang === "ar" ? `اختر ${p.competitor} إذا:` : `Choose ${p.competitor} if:`}</h2><ul className="mt-3 space-y-2 text-sm text-ink/70">{p.chooseThem.map((x) => <li key={x}>• {x}</li>)}</ul></div>
          <div className="rounded-xl border border-oasis bg-white p-5"><h2 className="font-display font-medium text-oasis">{lang === "ar" ? "اختر نور إذا:" : "Choose Noor if:"}</h2><ul className="mt-3 space-y-2 text-sm">{p.chooseUs.map((x) => <li key={x}>• {x}</li>)}</ul></div>
        </div>
        <p className="mt-10 font-display text-2xl font-bold">{p.verdict}</p>
        {p.faq.length > 0 && <div className="mt-10 divide-y divide-ink/10 border-y border-ink/10">{p.faq.map((f) => <details key={f.q} className="py-4"><summary className="font-display font-medium">{f.q}</summary><p className="mt-2 text-sm text-ink/70">{f.a}</p></details>)}</div>}
        <p className="mt-8 text-sm text-ink/60">{lang === "ar" ? "مقارنات أخرى:" : "More comparisons:"} {VS_PAGES[lang].filter((x) => x.slug !== p.slug).map((x) => <Link key={x.slug} href={`/${lang}/vs/${x.slug}`} className="me-3 underline">{x.competitor}</Link>)}</p>
      </main>
      <FinalCta t={t} lang={lang} />
      <Footer t={t} />
    </>
  );
}
