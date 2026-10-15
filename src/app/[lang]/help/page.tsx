import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import HelpCenter from "@/components/HelpCenter";
import { appOrigin } from "@/lib/origin";
import { pageMeta } from "@/lib/page-meta";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  // The description is the help centre's own subtitle (src/components/HelpCenter.tsx).
  return pageMeta(lang, "/help", { title: lang === "ar" ? "مركز المساعدة — ذكين" : "Help center — Thakeen", description: lang === "ar" ? "ابحث، أو اسأل نور في الدردشة «كيف أسوي…»، أو راسلنا." : "Search, ask Noor in chat “how do I…”, or message us." });
}
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const wa = process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}` : null;
  return (<><Nav t={dict[lang]} lang={lang} /><main id="main" tabIndex={-1}><HelpCenter lang={lang} wa={wa} origin={appOrigin()} /></main><Footer t={dict[lang]} /></>);
}
