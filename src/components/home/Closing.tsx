import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import UrlStart from "@/components/UrlStart";
import { HOME_END } from "@/lib/home-hero";
import type { Dict, Lang } from "@/lib/i18n";
import styles from "./home.module.css";

/**
 * The closing call at the end of the home page, before the footer (rule 1600): a drawn panel with an underlined
 * heading, then the cover's own call to action (rule 1228): the site's signup form (`UrlStart`) and the trial line from
 * the pricing copy. No price.
 */
export default function Closing({ lang, t }: { lang: Lang; t: Dict }) {
  return (
    <section className={`${styles.panel} ${styles.closing}`} id="start" aria-labelledby="t-start">
      <Scribble kind="box" seed="closing" fill="paper" />
      <h2 id="t-start">
        <span className={styles.ul}>
          <ScribbleStatic kind="underline" seed="closing-h" rtl={lang === "ar"} />
          {HOME_END.h[lang]}
        </span>
      </h2>
      <div className={styles.lead}>
        <UrlStart t={t} lang={lang} />
        <p className={styles.trialLine}>{t.pricing.trial}</p>
      </div>
    </section>
  );
}
