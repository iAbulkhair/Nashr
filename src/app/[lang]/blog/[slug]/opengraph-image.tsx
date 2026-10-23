import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { getPost } from "@/lib/blog";
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
  const post = isLang(lang) ? getPost(lang, slug) : null;
  return [{ id: "card", size: CARD_SIZE, contentType: "image/png", alt: post && isLang(lang) ? cardAlt(lang, "blog", post.title) : "" }];
}

export default async function Image({ params }: Params) {
  const { lang, slug } = await params;
  if (!isLang(lang)) notFound();
  const post = getPost(lang, slug);
  if (!post) notFound();
  return shareCard({ lang, kind: "blog", title: post.title });
}
