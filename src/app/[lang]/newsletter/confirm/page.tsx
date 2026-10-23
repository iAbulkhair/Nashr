import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { isLang } from "@/lib/i18n";
import { NEWSLETTER_COPY } from "@/lib/newsletter-copy";
import NewsletterToken from "@/components/NewsletterToken";

/** A mailed single-use link: never indexed. */
export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  return { title: isLang(lang) ? NEWSLETTER_COPY[lang].page.confirm.title : undefined, robots: { index: false, follow: false } };
}

/** The confirm page of the double opt-in (rules 3600-3609): the token is in the fragment, read by the client component. */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return <NewsletterToken lang={lang} mode="confirm" />;
}
