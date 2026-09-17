import Link from "next/link";
import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import { listPosts } from "@/lib/blog";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  const posts = listPosts(lang);
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
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
