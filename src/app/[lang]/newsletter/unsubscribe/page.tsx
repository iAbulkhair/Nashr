import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { isLang } from "@/lib/i18n";
import { NEWSLETTER_COPY } from "@/lib/newsletter-copy";
import NewsletterToken from "@/components/NewsletterToken";

/** A mailed link: never indexed. */
export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  return { title: isLang(lang) ? NEWSLETTER_COPY[lang].page.unsubscribe.title : undefined, robots: { index: false, follow: false } };
}

/** The unsubscribe page (rules 3600-3609): no login; the token is in the fragment and the client component posts it at once. */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return <NewsletterToken lang={lang} mode="unsubscribe" />;
}
