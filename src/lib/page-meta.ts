import type { Metadata } from "next";
import type { Lang } from "./i18n";

/**
 * Metadata for one public page at `/{lang}{path}` (#45): its own title and description, its canonical URL, and hreflang
 * alternates when the page exists in both languages. Relative URLs resolve against `metadataBase` (the canonical origin,
 * set in src/app/[lang]/layout.tsx).
 *
 * Deliberately no `openGraph` or `twitter` here. The layout's share fields have no title or description, so Next fills
 * og:title, og:description and the twitter card from this title and description, and the share image from
 * `src/app/[lang]/opengraph-image.png` reaches every page. A page-level `openGraph` object would replace the layout's
 * whole, image included (Next merges metadata shallowly), so tests/share-meta.test.ts refuses one.
 */
export function pageMeta(lang: Lang, path: string, m: { title: string; description?: string; bilingual?: boolean }): Metadata {
  const alternates: NonNullable<Metadata["alternates"]> = { canonical: `/${lang}${path}` };
  // Without its own `languages`, a page would inherit the layout's hreflang, which points at the two home pages.
  if (m.bilingual !== false) alternates.languages = { ar: `/ar${path}`, en: `/en${path}` };
  return { title: m.title, ...(m.description ? { description: m.description } : {}), alternates };
}
