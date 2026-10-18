import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { backArrow } from "@/lib/format";
import { dict, isLang, LANGS, type Lang } from "@/lib/i18n";
import { HELP, helpHref, helpTopic, helpTopics, type HelpTopic } from "@/lib/help";
import { helpFaqJsonLd, ldJson } from "@/lib/home-ld";
import { appOrigin } from "@/lib/origin";
import { pageMeta } from "@/lib/page-meta";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";

/** One page per help topic (rule 2140), built at build time for both languages; any other id is the branded 404. */
export function generateStaticParams() {
  return LANGS.flatMap((lang) => HELP.map((t) => ({ lang, topic: t.id })));
}

/** The topic's own questions, as many as fit a search snippet: the description says only what the page answers (rule 2143). */
function describe(lang: Lang, t: HelpTopic): string {
  let out = `${t.title[lang]}: ${t.items[0].q[lang]}`;
  for (const i of t.items.slice(1)) {
    if (out.length + i.q[lang].length + 3 > 160) break;
    out += ` · ${i.q[lang]}`;
  }
  return out;
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string; topic: string }> }): Promise<Metadata> {
  const { lang, topic } = await params;
  const t = helpTopic(topic);
  if (!t || !isLang(lang)) return {};
  return pageMeta(lang, `/help/${t.id}`, { title: `${t.title[lang]} — ${lang === "ar" ? "مساعدة ذكين" : "Thakeen help"}`, description: describe(lang, t) });
}

export default async function Page({ params }: { params: Promise<{ lang: string; topic: string }> }) {
  const { lang, topic } = await params;
  if (!isLang(lang)) notFound();
  const origin = appOrigin();
  // Answers that name the MCP address are filled with the canonical origin, exactly as on /help.
  const t = helpTopics(origin).find((x) => x.id === topic);
  if (!t) notFound();
  const ar = lang === "ar";
  return (
    <>
      <Nav t={dict[lang]} lang={lang} />
      <main id="main" tabIndex={-1} className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ldJson(helpFaqJsonLd(lang, origin, t)) }} />
        <Link href={`/${lang}/help`} className="text-sm font-bold text-foreground underline">{`${backArrow(lang)} ${ar ? "مركز المساعدة" : "Help center"}`}</Link>
        <h1 className="mt-4 font-display text-3xl font-bold leading-tight sm:text-4xl"><span className="s-ul"><ScribbleStatic kind="underline" seed={`help-topic-h-${t.id}`} rtl={ar} />{t.title[lang]}</span></h1>
        <div className="mt-8 divide-y divide-foreground/15 border-y-[1.5px] border-border-strong">
          {t.items.map((i) => (
            // The slug is the answer's permanent anchor (rule 2141): `/{lang}/help/{topic}#{slug}` lands on it.
            <section key={i.slug} id={i.slug} className="scroll-mt-24 py-5" aria-labelledby={`${i.slug}-q`}>
              <h2 id={`${i.slug}-q`} className="font-display text-lg font-bold">{i.q[lang]}</h2>
              <p className="mt-2 text-sm leading-relaxed text-foreground-muted" dir="auto">{i.a[lang]}</p>
              <a href={helpHref(lang, t.id, i.slug)} className="mt-2 inline-block text-xs font-bold text-foreground-muted underline">{ar ? "رابط هذه الإجابة" : "Link to this answer"}</a>
            </section>
          ))}
        </div>
        <section className="mt-12">
          <h2 className="font-display text-xl font-bold">{ar ? "مواضيع أخرى" : "Other topics"}</h2>
          <div className="mt-4 flex flex-wrap gap-3">
            {HELP.filter((x) => x.id !== t.id).map((x) => <Link key={x.id} href={helpHref(lang, x.id)} className="s-chip inline-flex items-center"><Scribble kind="pill" seed={`help-more-${x.id}`} fill="paper" ring />{x.title[lang]}</Link>)}
          </div>
          <p className="mt-8 text-sm text-foreground-muted">{ar ? "ما لقيت جوابك؟ اسأل نور في الدردشة، أو راسلنا من " : "No answer here? Ask Noor in chat, or message us from the "}<Link href={`/${lang}/help`} className="font-bold text-foreground underline">{ar ? "مركز المساعدة" : "help center"}</Link>.</p>
        </section>
      </main>
      <Footer t={dict[lang]} />
    </>
  );
}
