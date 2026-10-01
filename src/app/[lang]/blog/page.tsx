import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import { listPosts } from "@/lib/blog";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

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
        <h1 className="font-display text-4xl font-bold text-oasis">{lang === "ar" ? "المدونة" : "Blog"}</h1>
        <ul className="mt-10 grid gap-8">
          {posts.map((p) => (
            <li key={p.slug}>
              <Link href={`/${lang}/blog/${p.slug}`} className="font-display text-2xl font-medium hover:text-oasis">{p.title}</Link>
              <p className="mt-2 text-ink/70">{p.desc}</p>
              <p className="mt-1 font-mono text-xs text-ink/50" dir="ltr">{p.date}</p>
            </li>
          ))}
        </ul>
      </main>
      <Footer t={t} />
    </>
  );
}
