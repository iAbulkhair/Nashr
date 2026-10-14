import Scribble from "@/components/Scribble";
import { HOME_NAV, HOME_NAV_LABEL } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import styles from "./SectionChips.module.css";

/**
 * The homepage's section chips under the cover (rule 1854): a row of hand-drawn pills, one per section in page order,
 * each a 44px in-page link. On a narrow screen the row scrolls sideways inside itself and never widens the page. It is a
 * list, not a `<nav>`: the site has one menu (src/components/Nav.tsx), and this is the page's own table of contents.
 */
export default function SectionChips({ lang }: { lang: Lang }) {
  return (
    <ul className={styles.chips} role="list" aria-label={HOME_NAV_LABEL[lang]} data-section-chips>
      {HOME_NAV.map((n) => (
        <li key={n.href}>
          <a href={n.href} className={`s-chip ${styles.chip}`}>
            <Scribble kind="pill" seed={`chip-${n.href}`} fill="paper" ring />
            {n.label[lang]}
          </a>
        </li>
      ))}
    </ul>
  );
}
