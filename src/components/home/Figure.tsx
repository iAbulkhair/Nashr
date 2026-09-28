import type { CastMember } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import Doodle from "./Doodle";
import QuestionFlip from "./QuestionFlip";
import styles from "./home.module.css";

/** Figures flip one after another: 7 × 343 ms spreads the seven agents across one 2.4 s flip (spec §7.3). */
const STAGGER_MS = 343;

/**
 * One cast member standing in the lineup. The founder's order of importance: the value line (largest), then the name,
 * then the questions flipping above the head. The flipping layer is decorative; the value, the name and the first
 * question are exposed as static text.
 */
export default function Figure({ member, lang, index }: { member: CastMember; lang: Lang; index: number }) {
  const name = member.name[lang];
  const value = member.value[lang];
  const first = member.questions[0];
  const described = first ? `figure-q-${member.id}` : undefined;
  return (
    <button type="button" className={styles.figure} data-testid="figure" data-cast={member.id} aria-label={`${name} — ${value}`} aria-describedby={described}>
      <span className={styles.qslot}>{member.questions.length > 0 && <QuestionFlip items={member.questions} lang={lang} delayMs={index * STAGGER_MS} />}</span>
      <span className={styles.figureArt}>
        <Doodle who={member.id} />
      </span>
      <span className={styles.value}>{value}</span>
      <span className={styles.name}>{name}</span>
      {first && (
        <span id={described} className={styles.srOnly}>
          {first[lang]}
        </span>
      )}
    </button>
  );
}
