import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import HelpCenter from "@/components/HelpCenter";
import { appOrigin } from "@/lib/origin";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  return { title: lang === "ar" ? "مركز المساعدة — ذكين" : "Help center — Thakeen" };
}
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const wa = process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}` : null;
  return (<><Nav t={dict[lang]} lang={lang} /><main><HelpCenter lang={lang} wa={wa} origin={appOrigin()} /></main><Footer t={dict[lang]} /></>);
}
