import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import { Agents, Calendar, Industries, Integrations } from "@/components/Sections";
import { Cta, Deliverables, HeroUrl, Highlights, OldWay, Pillars, Runs, Teammate } from "@/components/Landing";
import Pricing from "@/components/Pricing";
import Faq from "@/components/Faq";
import Footer from "@/components/Footer";

export default async function Home({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main>
        <HeroUrl t={t} lang={lang} />
        <Agents t={t} />
        <Highlights t={t} />
        <Teammate t={t} />
        <OldWay t={t} />
        <Runs t={t} />
        <Deliverables t={t} />
        <Pillars t={t} />
        <Industries t={t} lang={lang} />
        <Integrations t={t} />
        <Calendar t={t} />
        <Pricing t={t} lang={lang} />
        <Faq t={t} />
        <Cta t={t} lang={lang} />
      </main>
      <Footer t={t} />
    </>
  );
}
