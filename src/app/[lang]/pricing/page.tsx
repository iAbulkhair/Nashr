import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Pricing from "@/components/Pricing";
import Faq from "@/components/Faq";
import WaitlistForm from "@/components/WaitlistForm";
import Footer from "@/components/Footer";

export default async function PricingPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main>
        <Pricing t={t} lang={lang} />
        <Faq t={t} />
        <WaitlistForm t={t} lang={lang} />
      </main>
      <Footer t={t} />
    </>
  );
}
