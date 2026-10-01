import type { Metadata } from "next";
import { dict, type Lang } from "./i18n";

/** The founder's slogan (decision of 2026-10-01). Arabic only: there is no approved English slogan in src/lib/i18n.ts. */
export const SLOGAN_AR = "ذكين. الذكي المكين.";

/**
 * The site's default title and description, shown by any page without metadata of its own (the homepage) and copied by
 * Next into og:title and og:description for its share card (founder decision 2026-10-01). Arabic is the public name with
 * the slogan; English is the name with the site's existing English tagline (the footer's), since no English slogan has
 * been approved. Neither names an agent or a model: the share card speaks for the product, and the image says the same
 * (src/app/[lang]/opengraph-image.png and its alt text; tests/share-meta.test.ts).
 */
export const SITE_DEFAULT: Record<Lang, { title: string; description: string }> = {
  ar: { title: SLOGAN_AR, description: `${SLOGAN_AR} ${dict.ar.footer.tagline}` },
  en: { title: `Thakeen — ${dict.en.footer.tagline.replace(/\.$/, "")}`, description: `Thakeen. ${dict.en.footer.tagline}` },
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
export function pageMeta(lang: Lang, path: string, m: { title: string; description?: string; bilingual?: boolean }): Metadata {
  const alternates: NonNullable<Metadata["alternates"]> = { canonical: `/${lang}${path}` };
  // Without its own `languages`, a page would inherit the layout's hreflang, which points at the two home pages.
  if (m.bilingual !== false) alternates.languages = { ar: `/ar${path}`, en: `/en${path}` };
  return { title: m.title, ...(m.description ? { description: m.description } : {}), alternates };
}
