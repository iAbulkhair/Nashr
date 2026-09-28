import { HOME, TRUTHS } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import StartForm from "./StartForm";
import styles from "./home.module.css";

/** What's true today: four facts the product does now, then the start form, always visible and usable without JS. */
export default function Truths({ lang }: { lang: Lang }) {
  return (
    <section className={styles.truths} aria-labelledby="truths-title">
      <h2 id="truths-title" className={styles.truthsTitle}>
        {HOME.truthsTitle[lang]}
      </h2>
      <ul className={styles.truthList}>
        {TRUTHS.map((t) => (
          <li key={t.title.en} className={styles.truth}>
            <h3 className={styles.truthTitle}>{t.title[lang]}</h3>
            <p className={styles.truthBody}>{t.body[lang]}</p>
          </li>
        ))}
      </ul>
      <StartForm lang={lang} />
    </section>
  );
}
