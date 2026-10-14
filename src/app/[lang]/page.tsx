import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import { homeJsonLd, ldJson } from "@/lib/home-ld";
import { appOrigin } from "@/lib/origin";
import Nav from "@/components/Nav";
import Cover from "@/components/home/Cover";
import SectionChips from "@/components/home/SectionChips";
import Stories from "@/components/home/Stories";
import Rules from "@/components/home/Rules";
import Day from "@/components/home/Day";
import Gallery from "@/components/home/Gallery";
import Steps from "@/components/home/Steps";
import Plans from "@/components/home/Plans";
import HomeFaq from "@/components/home/HomeFaq";
import Closing from "@/components/home/Closing";
import { Seam } from "@/components/home/Decor";
import Footer from "@/components/Footer";
import styles from "@/components/home/home.module.css";

/**
 * The homepage's canonical and hreflang (rule 1859): `/ar` and `/en` each name themselves, the other language, and Arabic
 * as the default. Title and description stay the layout's `SITE_DEFAULT`.
 */
export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  return { alternates: { canonical: `/${lang}`, languages: { ar: "/ar", en: "/en", "x-default": "/ar" } } };
}

/** The homepage is prototype D (rule 516): cover (with the call to action and freshness chip, rules 1228-1229) and team, the section chips (rule 1854), the scenes (rule 775), house rules, your day, the live UI gallery (rule 1220), the seven steps, plans, questions, and the closing call before the footer (rule 1600). */
export default async function Home({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      {/* Organization, SoftwareApplication with the plan prices, FAQPage (rule 1859): src/lib/home-ld.ts. */}
      {homeJsonLd(lang, appOrigin()).map((ld) => <script key={String(ld["@type"])} type="application/ld+json" dangerouslySetInnerHTML={{ __html: ldJson(ld) }} />)}
      <main id="main" tabIndex={-1} className={styles.home}>
        <Cover lang={lang} t={t} />
        <SectionChips lang={lang} />
        <Seam kind="ink" />
        <Stories lang={lang} />
        <Seam kind="fly" pace={{ t: "11s", d: "-2s" }} />
        <Rules lang={lang} />
        <Seam kind="team" />
        <Day lang={lang} />
        <Seam kind="ink" />
        <Gallery lang={lang} />
        <Seam kind="fly" pace={{ t: "12s", d: "-4s" }} />
        <Steps lang={lang} />
        <Seam kind="fly" pace={{ t: "13s", d: "-7s" }} />
        <Plans t={t} lang={lang} />
        <Seam kind="ink" />
        <HomeFaq lang={lang} />
        <Seam kind="fly" pace={{ t: "14s", d: "-9s" }} />
        <Closing lang={lang} t={t} />
      </main>
      <Footer t={t} />
    </>
  );
}
