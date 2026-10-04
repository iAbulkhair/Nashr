import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Arabic } from "next/font/google";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import "../globals.css";
import { LANGS, dict, isLang } from "@/lib/i18n";
import { appOrigin } from "@/lib/origin";
import { SITE_DEFAULT } from "@/lib/page-meta";

// Thmanyah Serif Display («ثمانية للعناوين») for headings and large type; body text stays IBM Plex Sans Arabic.
// The Thmanyah Font License (font.thmanyah.com/licenses) allows websites only as part of a packaged product: the files
// stay unmodified under src/app/fonts and reach the browser only through the build, never from public/ (rule 317).
const thmanyah = localFont({
  src: [
    { path: "../fonts/thmanyah-serif-display/thmanyahserifdisplay-Medium.woff2", weight: "500", style: "normal" },
    { path: "../fonts/thmanyah-serif-display/thmanyahserifdisplay-Bold.woff2", weight: "700", style: "normal" },
    { path: "../fonts/thmanyah-serif-display/thmanyahserifdisplay-Black.woff2", weight: "900", style: "normal" },
  ],
  variable: "--font-thmanyah",
  display: "swap",
});
const plexArabic = IBM_Plex_Sans_Arabic({ subsets: ["latin", "arabic"], weight: ["400", "500", "600"], variable: "--font-plex-arabic" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });

export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  const t = dict[lang];
  // Share cards (#45). The base makes relative URLs (canonical, hreflang, the og:image below) absolute on the canonical
  // origin. openGraph and twitter deliberately carry no title or description: Next fills them from each page's own
  // `title` and `description`, so a shared pricing or blog link shows that page, not the brand word. A page that sets its
  // own `openGraph` replaces this object whole and loses the share image from `opengraph-image.png` in this segment, so
  // pages set only title, description and alternates (src/lib/page-meta.ts; tests/share-meta.test.ts).
  return {
    metadataBase: new URL(appOrigin()),
    // The public name and the founder's slogan (2026-10-01), not an agent's tagline: src/lib/page-meta.ts `SITE_DEFAULT`.
    title: SITE_DEFAULT[lang].title,
    description: SITE_DEFAULT[lang].description,
    alternates: { languages: { ar: "/ar", en: "/en" } },
    other: { google: "notranslate" },
    openGraph: { siteName: t.brand, type: "website", locale: lang === "ar" ? "ar_SA" : "en_US", alternateLocale: lang === "ar" ? "en_US" : "ar_SA" },
    twitter: { card: "summary_large_image" },
  };
}

export default async function RootLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  return (
    <html lang={lang} dir={t.dir} translate="no" className={`${thmanyah.variable} ${plexArabic.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
