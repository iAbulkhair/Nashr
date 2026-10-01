import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { LEGAL } from "@/lib/legal";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const ar = lang === "ar";
  return {
    title: ar ? "سياسة الخصوصية — ذكين" : "Privacy Policy — Thakeen",
    description: ar ? "ما البيانات التي يجمعها ذكين، وأين تُخزَّن، ومن يصل إليها، وكيف تحذف حسابك." : "What Thakeen collects, where it is stored, who can reach it, and how to delete your account.",
    alternates: { canonical: `/${lang}/privacy`, languages: { ar: "/ar/privacy", en: "/en/privacy" } },
  };
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  const doc = LEGAL[lang].privacy;
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className="page-wrap">
        <h1 className="page-title">{doc.title}</h1>
        <p className="mt-2 text-sm text-ink/50">{doc.updated}</p>
        {doc.sections.map((s) => (
          <section key={s.h} className="mt-8">
            <h2 className="font-display text-xl font-medium">{s.h}</h2>
            {s.p.map((p, i) => <p key={i} className="mt-2 leading-relaxed text-ink/80">{p}</p>)}
          </section>
        ))}
      </main>
      <Footer t={t} />
    </>
  );
}
