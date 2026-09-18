import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Arabic, Readex_Pro } from "next/font/google";
import { notFound } from "next/navigation";
import "../globals.css";
import { LANGS, dict, isLang } from "@/lib/i18n";

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
  return {
    title: lang === "ar" ? "نشر — نور، وكيلة تسويق تعمل 24/7 للخليج" : "Nashr — Noor, the 24/7 AI marketing agent for the Gulf",
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
    <html lang={lang} dir={t.dir} translate="no" className={`${readex.variable} ${plexArabic.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
