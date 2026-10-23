import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { getPostServed } from "@/lib/blog";
import { CARD_SIZE, cardAlt, shareCard } from "@/lib/share-card";

/**
 * The share image of one blog post (rule 3142): the post's own title on the shared card (src/lib/share-card.tsx). It replaces
 * the site card for this segment only; the page keeps setting no `openGraph` of its own, so the shared link's title and
 * description still come from the post (tests/share-meta.test.ts, e2e/public-pages.spec.ts). Built at build time, one per
 * post and language: Next takes the parameters from the page's own `generateStaticParams` (with `generateImageMetadata` it
 * writes the static parameters itself, and a second export would be a duplicate).
 */
export const size = CARD_SIZE;
export const contentType = "image/png";

type Params = { params: Promise<{ lang: string; slug: string }> };

/** The alternative text is the page's own, so it is given here rather than as one static `alt` for every post. */
export async function generateImageMetadata({ params }: Params) {
  const { lang, slug } = await params;
  const r = isLang(lang) ? getPostServed(lang, slug) : null;
  return [{ id: "card", size: CARD_SIZE, contentType: "image/png", alt: r ? cardAlt(r.served.lang, "blog", r.post.title) : "" }];
}

export default async function Image({ params }: Params) {
  const { lang, slug } = await params;
  if (!isLang(lang)) notFound();
  // Rule 3313: a post that exists in one language draws its card in that language, on the other language's address too.
  const r = getPostServed(lang, slug);
  if (!r) notFound();
  return shareCard({ lang: r.served.lang, kind: "blog", title: r.post.title });
}
