import { HOME } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import styles from "./home.module.css";

/**
 * The start: one field, the visitor's website. A plain GET form (same contract as `UrlStart`), so it works before or
 * without JavaScript and the URL travels into signup as `?url=`.
 */
export default function StartForm({ lang }: { lang: Lang }) {
  const label = HOME.urlPlaceholder[lang];
  return (
    <form action={`/${lang}/app/signup`} method="get" className={styles.start}>
      <input name="url" dir="ltr" inputMode="url" autoComplete="url" placeholder={label} aria-label={label} className={styles.startInput} />
      <button type="submit" className={styles.startButton}>
        {HOME.cta[lang]}
      </button>
    </form>
  );
}
