import type { Lang } from "@/lib/i18n";

/**
 * The wordmark «ذكين» with the long, sent-out kaf and the round noon (rule 317). The kaf comes from the heading face's own
 * Stylistic Alternates (`.wordmark-kaf` in globals.css), never from kashida. The feature changes the final noon too, so it
 * goes on the kaf alone; splitting plain text across spans breaks the letter joining in Safari, so the letters are written
 * in their joined presentation forms (initial kaf U+FEDB, medial yeh U+FEF4, final noon U+FEE6). Screen readers, search
 * and copy get the plain name from aria-label. English, or any other name, renders as plain text.
 */
export default function Wordmark({ lang, name }: { lang: Lang; name: string }) {
  if (lang !== "ar" || name !== "ذكين") return <>{name}</>;
  return (
    <span role="img" aria-label={name}>
      <span aria-hidden="true">
        ذ<span className="wordmark-kaf">{"\uFEDB"}</span>{"\uFEF4\uFEE6"}
      </span>
    </span>
  );
}
