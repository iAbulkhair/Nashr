import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import { HOME_NAV } from "@/lib/home";
import Nav from "@/components/Nav";
import Cover from "@/components/home/Cover";
import Stories from "@/components/home/Stories";
import Rules from "@/components/home/Rules";
import Day from "@/components/home/Day";
import Steps from "@/components/home/Steps";
import Plans from "@/components/home/Plans";
import HomeFaq from "@/components/home/HomeFaq";
import { Seam } from "@/components/home/Decor";
import Footer from "@/components/Footer";
import styles from "@/components/home/home.module.css";

/** The homepage is prototype D (rule 516): cover and team, illustrative stories, house rules, your day, the seven steps, plans, questions. */
export default async function Home({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} sections={HOME_NAV} />
      <main className={styles.home}>
        <Cover lang={lang} brand={t.brand} />
        <Stories lang={lang} />
        <Seam kind="fly" pace={{ t: "11s", d: "-2s" }} />
        <Rules lang={lang} />
        <Seam kind="team" />
        <Day lang={lang} />
        <Seam kind="ink" />
        <Steps lang={lang} />
        <Seam kind="fly" pace={{ t: "13s", d: "-7s" }} />
        <Plans t={t} lang={lang} />
        <Seam kind="ink" />
        <HomeFaq lang={lang} />
      </main>
      <Footer t={t} />
    </>
  );
}
