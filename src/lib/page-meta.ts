import type { Metadata } from "next";
import { SLOGAN } from "./home";
import type { Lang } from "./i18n";

/**
 * The founder's slogan (decision of 2026-10-01): `SLOGAN.line1` in src/lib/home.ts, «ذكين. الذكي المكين.» and its
 * approved English, "Thakeen. Smart. Steadfast.". The homepage's h1 draws it as the wordmark and `HERO.tbox` (Cover.tsx);
 * tests/home-copy.test.ts keeps the two in step.
 */
export const SLOGAN_AR = SLOGAN.line1.ar;

/**
 * The site's default title and description, shown by any page without metadata of its own (the homepage) and copied by
 * Next into og:title and og:description for its share card (founder decision 2026-10-01). The title is the slogan in the
 * page's language; the description is the slogan followed by what the product is. In Arabic that phrase is masculine
 * («وكيل تسويق مبني للخليج») to agree with ذكين; the footer's feminine tagline describes Noor and stays in the footer.
 * Neither names an agent or a model: the share card speaks for the product, and the image says the same
 * (src/app/[lang]/opengraph-image.png and its alt text; tests/share-meta.test.ts).
 */
export const SITE_DEFAULT: Record<Lang, { title: string; description: string }> = {
  ar: { title: SLOGAN.line1.ar, description: `${SLOGAN.line1.ar} وكيل تسويق مبني للخليج.` },
  en: { title: SLOGAN.line1.en, description: `${SLOGAN.line1.en} A marketing agent built for the Gulf.` },
};

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
export function pageMeta(lang: Lang, path: string, m: { title: string; description?: string; bilingual?: boolean; served?: Lang }): Metadata {
  // Rule 3313: a page whose text exists only in `served` (not the URL's language) names that version as canonical and is no
  // alternate of anything, so the text is filed once and the missing language's URL is not offered as a translation.
  const fallback = m.served !== undefined && m.served !== lang;
  const alternates: NonNullable<Metadata["alternates"]> = { canonical: `/${fallback ? m.served : lang}${path}` };
  // Without its own `languages`, a page would inherit the layout's hreflang, which points at the two home pages.
  if (m.bilingual !== false && !fallback) alternates.languages = { ar: `/ar${path}`, en: `/en${path}` };
  return { title: m.title, ...(m.description ? { description: m.description } : {}), alternates };
}
