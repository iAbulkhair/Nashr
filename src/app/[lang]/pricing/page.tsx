import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Pricing from "@/components/Pricing";
import Faq from "@/components/Faq";
import FinalCta from "@/components/FinalCta";
import Footer from "@/components/Footer";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const ar = lang === "ar";
  return {
    title: ar ? "الأسعار والخطط — نشر" : "Pricing and plans — Nashr",
    description: ar ? "خطط نشر الشهرية وما يشمله كل مستوى من كريدت ووكلاء وقنوات." : "Nashr's monthly plans, and what credits, agents and channels each tier includes.",
    alternates: { canonical: `/${lang}/pricing`, languages: { ar: "/ar/pricing", en: "/en/pricing" } },
  };
}

export default async function PricingPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main>
        <Pricing t={t} lang={lang} headingLevel={1} />
        <Faq t={t} />
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} />
    </>
  );
}
