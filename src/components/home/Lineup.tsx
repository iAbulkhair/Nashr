import { CAST, HOME } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import Figure from "./Figure";
import styles from "./home.module.css";

/**
 * The team standing in a row, Noor first in the reading direction (from the right in Arabic). Under 760 px the row
 * becomes a strip that scrolls inside its own box, so the page itself never scrolls sideways. The AI label is permanent
 * (spec §7.1, disclosure).
 */
export default function Lineup({ lang }: { lang: Lang }) {
  return (
    <section className={styles.lineup} data-testid="lineup" aria-labelledby="lineup-label">
      <p id="lineup-label" className={styles.aiLabel}>
        {HOME.aiLabel[lang]}
      </p>
      <div className={styles.strip}>
        <ul className={styles.row}>
          {CAST.map((member, index) => (
            <li key={member.id} className={styles.cell}>
              <Figure member={member} lang={lang} index={index} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
