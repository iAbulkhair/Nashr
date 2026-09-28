import { notFound } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Story from "@/components/home/Story";
import Lineup from "@/components/home/Lineup";
import Dictionary from "@/components/home/Dictionary";
import Truths from "@/components/home/Truths";
import Pricing from "@/components/Pricing";
import Faq from "@/components/Faq";
import Footer from "@/components/Footer";
import styles from "@/components/home/home.module.css";

export default async function Home({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className={styles.home}>
        <Story lang={lang} />
        <Lineup lang={lang} />
        <Dictionary lang={lang} />
        <Truths lang={lang} />
        <Pricing t={t} lang={lang} />
        <Faq t={t} />
      </main>
      <Footer t={t} />
    </>
  );
}
