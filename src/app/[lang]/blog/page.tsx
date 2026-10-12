import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import { listPosts } from "@/lib/blog";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Scribble from "@/components/Scribble";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const ar = lang === "ar";
  return {
    title: ar ? "المدونة — أدلة تسويق للخليج | ذكين" : "Blog — Gulf marketing guides | Thakeen",
    description: ar ? "أدلة عملية للتسويق في السعودية والخليج: المواسم، القنوات، والقطاعات." : "Practical guides to marketing in Saudi Arabia and the Gulf: seasons, channels and sectors.",
    alternates: { canonical: `/${lang}/blog`, languages: { ar: "/ar/blog", en: "/en/blog" } },
  };
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  const posts = listPosts(lang);
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className="page-wrap">
        <h1 className="font-display text-4xl font-bold"><span className="s-ul"><Scribble kind="underline" seed="blog-h" />{lang === "ar" ? "المدونة" : "Blog"}</span></h1>
        <ul className="mt-10 grid gap-8">
          {posts.map((p) => (
            <li key={p.slug}>
              <Link href={`/${lang}/blog/${p.slug}`} className="s-card block" data-boil>
                <Scribble kind="box" seed={`blog-${p.slug}`} fill="paper" boil />
                <h2 className="font-display text-2xl font-bold">{p.title}</h2>
                <p className="mt-2 text-foreground-muted">{p.desc}</p>
                <p className="mt-1 font-mono text-xs text-foreground-muted" dir="ltr">{p.date}</p>
              </Link>
            </li>
          ))}
        </ul>
      </main>
      <Footer t={t} />
    </>
  );
}
