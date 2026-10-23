import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { cardQuestions, helpTopic } from "@/lib/help";
import { CARD_SIZE, cardAlt, shareCard } from "@/lib/share-card";

/**
 * The share image of one help topic (rule 3142): the topic's title and its own questions on the shared card
 * (src/lib/share-card.tsx), the same words its page description uses. It replaces the site card for this segment only; the
 * page sets no `openGraph` of its own, so the shared link's title and description still come from the topic
 * (tests/share-meta.test.ts). Built at build time, one per topic and language: Next takes the parameters from the page's own
 * `generateStaticParams` (with `generateImageMetadata` it writes the static parameters itself).
 */
export const size = CARD_SIZE;
export const contentType = "image/png";

type Params = { params: Promise<{ lang: string; topic: string }> };

export async function generateImageMetadata({ params }: Params) {
  const { lang, topic } = await params;
  const t = helpTopic(topic);
  return [{ id: "card", size: CARD_SIZE, contentType: "image/png", alt: t && isLang(lang) ? cardAlt(lang, "help", t.title[lang]) : "" }];
}

export default async function Image({ params }: Params) {
  const { lang, topic } = await params;
  if (!isLang(lang)) notFound();
  const t = helpTopic(topic);
  if (!t) notFound();
  return shareCard({ lang, kind: "help", title: t.title[lang], description: cardQuestions(lang, t) });
}
