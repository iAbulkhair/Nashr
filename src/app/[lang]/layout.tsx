import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Arabic } from "next/font/google";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import "../globals.css";
import { LANGS, dict, isLang } from "@/lib/i18n";
import { appOrigin } from "@/lib/origin";
import { SITE_DEFAULT } from "@/lib/page-meta";
import { THEME_SCRIPT } from "@/lib/theme";
import ScribbleDir from "@/components/ScribbleDir";
import ThemeScope from "@/components/ThemeScope";

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
// Body text (rule 1585): 700 is loaded because `font-bold` and the CSS `font-weight: 700` rules are used across the site;
// without it the browser drew a synthetic bold from 600. Preloads (rule 1586) are only what the first screen needs:
// `subsets` names what is preloaded, not what is served, so the Latin faces still arrive through their unicode-range
// when a page uses them, and the mono face (codes and figures, none on the home page) is not preloaded at all.
const plexArabic = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["400", "500", "600", "700"], variable: "--font-plex-arabic" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", preload: false });

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
    // Home-screen install (rule 682): the name under the icon, a plain status bar (the app header is paper). Next writes
    // `mobile-web-app-capable` for `capable`; older iOS reads only the apple- name, so `other` adds it. The manifest and
    // the apple-touch-icon come from src/app/manifest.ts and src/app/apple-icon.png.
    appleWebApp: { capable: true, title: t.brand, statusBarStyle: "default" },
    other: { google: "notranslate", "apple-mobile-web-app-capable": "yes" },
    openGraph: { siteName: t.brand, type: "website", locale: lang === "ar" ? "ar_SA" : "en_US", alternateLocale: lang === "ar" ? "en_US" : "ar_SA" },
    twitter: { card: "summary_large_image" },
  };
}

export default async function RootLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  // Theme before the first paint (rules 1203-1204, 1214): the server always sends light; the head script reads the viewer's
  // `thakeen_theme` cookie (or the old `nashr_theme`) and the device setting and sets `data-theme` before the body is parsed, so a dark page never
  // flashes light and the page stays statically prerendered (no cookies() here). suppressHydrationWarning covers only
  // that one attribute on <html>. One `ThemeScope` here serves every page in the language, public, app and console.
  return (
    <html lang={lang} dir={t.dir} translate="no" data-theme="light" suppressHydrationWarning className={`${thmanyah.variable} ${plexArabic.variable} ${plexMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeScope />
        {/* Scribbles draw in the page's direction from the first paint (rule 1869). */}
        <ScribbleDir rtl={t.dir === "rtl"}>{children}</ScribbleDir>
      </body>
    </html>
  );
}
