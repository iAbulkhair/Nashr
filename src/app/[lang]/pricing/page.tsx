import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Pricing from "@/components/Pricing";
import CreditCalculator from "@/components/CreditCalculator";
import Faq from "@/components/Faq";
import FinalCta from "@/components/FinalCta";
import Footer from "@/components/Footer";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const ar = lang === "ar";
  return {
    title: ar ? "الأسعار والخطط — ذكين" : "Pricing and plans — Thakeen",
    description: ar ? "خطط ذكين الشهرية وما يشمله كل مستوى من كريدت ووكلاء وقنوات." : "Thakeen's monthly plans, and what credits, agents and channels each tier includes.",
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
        {/* Razan's credit calculator (rules 1885-1887): /pricing only, a section of the page beside the cards. */}
        <div className="mt-16">
          <CreditCalculator t={t} lang={lang} level={2} />
        </div>
        <Faq t={t} />
        <FinalCta t={t} lang={lang} />
      </main>
      <Footer t={t} />
    </>
  );
}
