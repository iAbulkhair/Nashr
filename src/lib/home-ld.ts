import { HOME_FAQ } from "./home";
import { dict, type Lang } from "./i18n";
import { PLAN_PRICE_SAR, PRICES_INCLUDE_VAT, SELF_SERVE_PLANS } from "./pricing";
import { SITE_DEFAULT } from "./page-meta";

/**
 * The homepage's structured data (rule 1859, site critique 2026-10-14): the organisation, the product with one offer per
 * self-serve plan, and the homepage's questions. Every value is read from the site's own sources: the brand from the
 * dictionary, the description from `SITE_DEFAULT`, each price from `PLAN_PRICE_SAR` in SAR a month with VAT as
 * `PRICES_INCLUDE_VAT` says, each question and answer from `HOME_FAQ`. No rating, review count, customer or logo: there are
 * none to report, and an invented one is against the house rules.
 */
export function homeJsonLd(lang: Lang, origin: string): Record<string, unknown>[] {
  const t = dict[lang];
  const home = `${origin}/${lang}`;
  const org = { "@type": "Organization", "@id": `${origin}/#organization`, name: t.brand, url: origin, logo: `${origin}/icons/icon-512.png` };
  const offers = SELF_SERVE_PLANS.map((id) => {
    const price = String(PLAN_PRICE_SAR[id]);
    return {
      "@type": "Offer",
      name: t.pricing.plans.find((p) => p.id === id)?.name ?? id,
      price,
      priceCurrency: "SAR",
      url: `${origin}/${lang}/pricing`,
      priceSpecification: { "@type": "UnitPriceSpecification", price, priceCurrency: "SAR", billingDuration: "P1M", unitCode: "MON", valueAddedTaxIncluded: PRICES_INCLUDE_VAT },
    };
  });
  return [
    { "@context": "https://schema.org", ...org },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: t.brand,
      url: home,
      description: SITE_DEFAULT[lang].description,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      inLanguage: lang,
      publisher: { "@id": org["@id"] },
      offers,
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      inLanguage: lang,
      mainEntity: HOME_FAQ.map((f) => ({ "@type": "Question", name: f.q[lang], acceptedAnswer: { "@type": "Answer", text: f.a[lang] } })),
    },
  ];
}

/**
 * One blog post's structured data (rule 1978): an Article in the page's language with its headline, description and
 * publication date from the post's own front matter (checked at build time, src/lib/blog.ts), its address, and the
 * organisation as author and publisher, the same `@id` the homepage declares. No author person, rating or image is made
 * up: the posts are the company's, signed by nobody.
 */
export function articleJsonLd(lang: Lang, origin: string, p: { slug: string; title: string; desc: string; date: string }): Record<string, unknown> {
  const t = dict[lang];
  const url = `${origin}/${lang}/blog/${p.slug}`;
  const org = { "@type": "Organization", "@id": `${origin}/#organization`, name: t.brand, url: origin, logo: { "@type": "ImageObject", url: `${origin}/icons/icon-512.png` } };
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: p.title.slice(0, 110),
    description: p.desc,
    datePublished: p.date,
    dateModified: p.date,
    inLanguage: lang,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    author: org,
    publisher: org,
  };
}

/** JSON for a `<script type="application/ld+json">`: `<` is escaped so no string can close the script element. */
export const ldJson = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");
