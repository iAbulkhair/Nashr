import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { PARTNER_TERMS } from "@/lib/partner-terms";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const ar = lang === "ar";
  return {
    title: ar ? "شروط برنامج الشركاء — ذكين" : "Partner programme terms — Thakeen",
    description: ar
      ? "شروط برنامج الشركاء في ذكين: من يمكنه الانضمام، العمولة، خصم العميل، الصرف، الضرائب، وما لا يُسمح به."
      : "The Thakeen partner programme terms: who can join, commission, the customer discount, payouts, taxes and what is not allowed.",
    alternates: { canonical: `/${lang}/affiliates/terms`, languages: { ar: "/ar/affiliates/terms", en: "/en/affiliates/terms" } },
  };
}

/** The public partner programme terms (rule 413), in Arabic and English; the application form links here (rule 414). */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  const doc = PARTNER_TERMS[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className="page-wrap" data-partner-terms>
        <p className="eyebrow"><Link href={`/${lang}/affiliates`} className="hover:underline">{doc.back}</Link></p>
        <h1 className="page-title mt-3">{doc.title}</h1>
        <p className="mt-2 text-sm text-ink/50" dir="auto">{doc.updated}</p>
        <p className="mt-4 leading-relaxed text-ink/80">{doc.intro}</p>
        {doc.sections.map((s) => (
          <section key={s.id} id={s.id} className="mt-8">
            <h2 className="font-display text-xl font-medium">{s.h}</h2>
            {s.p.length === 1
              ? <p className="mt-2 leading-relaxed text-ink/80">{s.p[0]}</p>
              : <ul className="mt-2 space-y-1 leading-relaxed text-ink/80">{s.p.map((p) => <li key={p}>• {p}</li>)}</ul>}
          </section>
        ))}
      </main>
      <Footer t={t} />
    </>
  );
}
