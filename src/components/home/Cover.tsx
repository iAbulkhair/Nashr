import Scribble from "@/components/Scribble";
import Wordmark from "@/components/Wordmark";
import { HERO } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import { Float } from "./Decor";
import Lineup from "./Lineup";
import styles from "./home.module.css";

/**
 * Prototype D's cover (rule 516): the issue stamp, the masthead (the wordmark, then its second line boxed in ink), the
 * offer with its lemon swash, a hint pointing down at the team, and the team itself. The hint has a mouse and a touch
 * wording; CSS shows the one the device can do.
 */
export default function Cover({ lang, brand }: { lang: Lang; brand: string }) {
  return (
    <section className={`${styles.panel} ${styles.cover}`} id="team" aria-labelledby="t-cover">
      <Scribble kind="box" seed="cover" fill="paper" />
      <Float kind="star" />
      <span className={`s-stamp ${styles.issue}`}>
        <Scribble kind="stamp" seed="issue" fill="paper" />
        {HERO.issue[lang]}
      </span>
      <div className={styles.ctop}>
        <h1 className={styles.mast} id="t-cover">
          <span className={styles.logo}>
            <Wordmark lang={lang} name={brand} />.
          </span>{" "}
          <span className={styles.tbox}>
            <Scribble kind="box" seed="tbox" fill="ink" />
            {HERO.tbox[lang]}
          </span>
        </h1>
        <p className={styles.offer}>
          {HERO.offer[lang]}{" "}
          <span className={styles.sw}>
            <Scribble kind="swash" seed="offer" fill="lemon" />
            {HERO.offerSwash[lang]}
          </span>
        </p>
        <p className={styles.hint}>
          <svg viewBox="0 0 40 28" aria-hidden="true">
            <path d="M36 2 C38 15 30 23 11 25 M17 19 L11 25 L18 28" />
          </svg>
          <span className={styles.hintMouse}>{HERO.hintMouse[lang]}</span>
          <span className={styles.hintTouch}>{HERO.hintTouch[lang]}</span>
        </p>
      </div>
      <Lineup lang={lang} />
    </section>
  );
}
