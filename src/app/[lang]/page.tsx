import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import { HOME_NAV } from "@/lib/home";
import Nav from "@/components/Nav";
import Cover from "@/components/home/Cover";
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

/** The homepage is prototype D (rule 516): cover (with the call to action and freshness chip, rules 1228-1229) and team, the scenes (rule 775), house rules, your day, the live UI gallery (rule 1220), the seven steps, plans, questions, and the closing call before the footer (rule 1600). */
export default async function Home({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} sections={HOME_NAV} />
      <main className={styles.home}>
        <Cover lang={lang} t={t} />
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
