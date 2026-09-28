"use client";
import { useState, type CSSProperties } from "react";
import type { CastMember } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import { flipDelay } from "@/lib/flip-clock";
import Doodle from "./Doodle";
import QuestionFlip from "./QuestionFlip";
import styles from "./home.module.css";

/**
 * One cast member standing in the lineup. The founder's order of importance: the value line (largest), then the name,
 * then the questions flipping above the head. The flipping layer is decorative; the value, the name and the first
 * question are exposed as static text.
 *
 * Hovered or focused, the figure turns to face you and holds its question; it also holds it while the lineup rests
 * (`hold`: off screen, in a hidden tab, or paused by the visitor). When it speaks (`say`), its bubble covers the
 * question slot. The slot is sized from before the first paint for every line this figure can say (`lines`), so a
 * bubble never moves the layout or gets clipped. The bubble is `aria-hidden`, and the button keeps its name; the
 * lineup announces what a pressed figure answers.
 */
export default function Figure({
  member,
  lang,
  index,
  lines,
  say,
  hold,
  onPress,
}: {
  member: CastMember;
  lang: Lang;
  index: number;
  lines: string[];
  say?: string;
  hold: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const facing = hovered || focused;
  const name = member.name[lang];
  const value = member.value[lang];
  const first = member.questions[0];
  const described = first ? `figure-q-${member.id}` : undefined;
  return (
    <button
      type="button"
      className={styles.figure}
      style={{ "--i": index } as CSSProperties}
      data-testid="figure"
      data-cast={member.id}
      data-talking={say ? "" : undefined}
      aria-label={`${name} — ${value}`}
      aria-describedby={described}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={onPress}
    >
      <span className={styles.qslot}>
        <span className={styles.qsizer} aria-hidden="true">
          {member.questions.map((q) => (
            <span key={q.en} className={styles.qflipItem}>
              {q[lang]}
            </span>
          ))}
          {lines.map((line) => (
            <span key={line} className={styles.talkBubble}>
              {line}
            </span>
          ))}
        </span>
        {member.questions.length > 0 && <QuestionFlip items={member.questions} lang={lang} delayMs={flipDelay(index)} paused={facing || hold} />}
        {say && (
          <span key={say} className={styles.talkBubble} data-testid="bubble" aria-hidden="true">
            {say}
          </span>
        )}
      </span>
      <span className={styles.figureArt}>
        <Doodle who={member.id} pose={facing ? "turn" : "stand"} />
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
