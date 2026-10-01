import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Arabic } from "next/font/google";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import "../globals.css";
import { LANGS, dict, isLang } from "@/lib/i18n";

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
  return {
    title: lang === "ar" ? "ذكين — نور، وكيلة تسويق للخليج" : "Thakeen — Noor, the AI marketing agent for the Gulf",
    description: t.hero.sub,
    alternates: { languages: { ar: "/ar", en: "/en" } },
    other: { google: "notranslate" },
    openGraph: { title: t.brand, description: t.hero.sub, locale: lang === "ar" ? "ar_SA" : "en_US" },
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
