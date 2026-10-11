import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import { TOOLS } from "@/lib/tools";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Scribble from "@/components/Scribble";
import { pageMeta } from "@/lib/page-meta";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  return pageMeta(lang, "/tools", { title: lang === "ar" ? `${TOOLS.length} أداة تسويق مجانية بالعربي (2026) — ذكين` : `${TOOLS.length} Free Arabic Marketing Tools (2026) — Thakeen`, description: lang === "ar" ? "هوكات، كابشنات، إعلانات سناب، سكربتات تيك توك، رسائل واتساب، منشورات Google — مجاناً بلهجتك." : "Hooks, captions, Snap ads, TikTok scripts, WhatsApp messages, Google posts — free, in your dialect." });
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <p className="eyebrow">{lang === "ar" ? "أدوات مجانية" : "Free tools"}</p>
        <h1 className="mt-3 font-display text-4xl font-bold"><span className="s-ul"><Scribble kind="underline" seed="tools-h" />{lang === "ar" ? `${TOOLS.length} أداة تسويق مجانية بالعربي` : `${TOOLS.length} free Arabic marketing tools`}</span></h1>
        <p className="mt-3 max-w-2xl text-foreground-muted">{lang === "ar" ? "كلها تعمل بنور، بلهجتك، بدون تسجيل — 5 استخدامات يومياً." : "All powered by Noor, in your dialect, no signup — 5 uses a day."}</p>
        <div className="mt-10 grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map((x) => (
            <Link key={x.slug} href={`/${lang}/tools/${x.slug}`} className="s-card block" data-boil>
              <Scribble kind="box" seed={`tools-${x.slug}`} fill="paper" boil />
              <h2 className="font-display text-lg font-bold">{x.name[lang]}</h2>
              <p className="mt-1 text-sm text-foreground-muted">{x.desc[lang]}</p>
            </Link>
          ))}
        </div>
      </main>
      <Footer t={t} />
    </>
  );
}
