import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { LEGAL } from "@/lib/legal";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  const doc = LEGAL[lang].terms;
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
