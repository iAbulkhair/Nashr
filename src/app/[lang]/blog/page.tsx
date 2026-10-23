import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import { listPosts } from "@/lib/blog";
import { allTags, filterByTag, tagFromParam } from "@/lib/blog-tags";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import { PostTags } from "@/components/PostTags";

type Props = { params: Promise<{ lang: string }>; searchParams: Promise<{ tag?: string | string[] }> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { lang } = await params;
  const tag = tagFromParam((await searchParams).tag);
  const ar = lang === "ar";
  return {
    title: ar ? "المدونة — أدلة تسويق للخليج | ذكين" : "Blog — Gulf marketing guides | Thakeen",
    description: ar ? "أدلة عملية للتسويق في السعودية والخليج: المواسم، القنوات، والقطاعات." : "Practical guides to marketing in Saudi Arabia and the Gulf: seasons, channels and sectors.",
    // A filtered view is the same guides in a shorter list (rule 3140): its canonical is the whole index and it is kept out of search results.
    alternates: { canonical: `/${lang}/blog`, languages: { ar: "/ar/blog", en: "/en/blog" } },
    ...(tag ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function Page({ params, searchParams }: Props) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  const ar = lang === "ar";
  const tag = tagFromParam((await searchParams).tag);
  const all = listPosts(lang);
  const posts = filterByTag(all, tag);
  return (
    <>
      <Nav t={t} lang={lang} />
      <main id="main" tabIndex={-1} className="page-wrap">
        <h1 className="font-display text-4xl font-bold"><span className="s-ul"><ScribbleStatic kind="underline" seed="blog-h" rtl={ar} />{ar ? "المدونة" : "Blog"}</span></h1>
        <PostTags lang={lang} tags={allTags(all, lang)} active={tag} label={ar ? "تصفية حسب الوسم" : "Filter by tag"} allLabel={ar ? "كل المقالات" : "All posts"} />
        {posts.length === 0 ? (
          // Rule 3140: a tag nobody carries (a typo, or a link to a tag that was dropped) says so and leads back to the full list.
          <p className="mt-10 text-foreground-muted" data-testid="blog-empty">
            {ar ? "لا توجد مقالات بهذا الوسم." : "No posts carry this tag."}{" "}
            <Link href={`/${lang}/blog`} className="font-bold text-foreground underline">{ar ? "عرض كل المقالات" : "Show all posts"}</Link>
          </p>
        ) : (
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
        )}
      </main>
      <Footer t={t} />
    </>
  );
}
