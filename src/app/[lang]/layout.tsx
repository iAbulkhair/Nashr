import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Arabic, Readex_Pro } from "next/font/google";
import { notFound } from "next/navigation";
import "../globals.css";
import { LANGS, dict, isLang } from "@/lib/i18n";
import { appOrigin } from "@/lib/origin";

const readex = Readex_Pro({ subsets: ["latin", "arabic"], weight: ["300", "500", "700"], variable: "--font-readex" });
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
    title: lang === "ar" ? "ذكين — نور، وكيلة تسويق للخليج" : "Thakeen — Noor, the AI marketing agent for the Gulf",
    description: t.hero.sub,
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
    <html lang={lang} dir={t.dir} translate="no" className={`${readex.variable} ${plexArabic.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
