import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Scribble from "@/components/Scribble";
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
        <p className="eyebrow"><Link href={`/${lang}/affiliates`} className="font-bold text-foreground hover:underline">{doc.back}</Link></p>
        <h1 className="mt-3 font-display text-3xl font-bold leading-tight sm:text-4xl"><span className="s-ul"><Scribble kind="underline" seed="partner-terms-h" />{doc.title}</span></h1>
        <p className="mt-2 text-sm text-foreground-muted" dir="auto">{doc.updated}</p>
        <p className="mt-4 leading-relaxed">{doc.intro}</p>
        {doc.sections.map((s) => (
          <section key={s.id} id={s.id} className="mt-8">
            <h2 className="font-display text-xl font-bold">{s.h}</h2>
            {s.p.length === 1
              ? <p className="mt-2 leading-relaxed">{s.p[0]}</p>
              : <ul className="mt-2 list-disc space-y-1 ps-5 leading-relaxed">{s.p.map((p) => <li key={p}>{p}</li>)}</ul>}
          </section>
        ))}
      </main>
      <Footer t={t} />
    </>
  );
}
