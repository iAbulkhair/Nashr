"use client";
import { useEffect, useState } from "react";
import type { Question } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import { flipIndex, untilNextFlip } from "@/lib/flip-clock";
import { useReducedMotion } from "./useReducedMotion";
import styles from "./home.module.css";

/** The shared clock every flip on the page reads (see `@/lib/flip-clock`), started by the first one to run. */
let epoch: number | undefined;
const sinceEpoch = () => performance.now() - (epoch ??= performance.now());

/**
 * The questions an agent takes off the owner's head, one at a time. Decorative (`aria-hidden`): the figure exposes its
 * first question as static text. The question shown comes from the shared clock, `delayMs` behind it, so figures with
 * different delays never flip together and never drift. Under reduced motion it stays on the first question; while
 * `paused` it holds the question it is on, and when it resumes it catches up with the clock at the next flip.
 */
export default function QuestionFlip({ items, lang, delayMs = 0, paused = false }: { items: Question[]; lang: Lang; delayMs?: number; paused?: boolean }) {
  const reduced = useReducedMotion();
  // The moment on the shared clock this flip last caught up with; the question follows from it.
  const [at, setAt] = useState(0);
  const still = reduced || paused || items.length < 2;

  useEffect(() => {
    if (still) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const now = sinceEpoch();
      const wait = untilNextFlip(now, delayMs);
      // Never behind the flip it waited for (a timer can fire a hair early), and straight to where the clock is now
      // when it fired very late (a background tab).
      timer = setTimeout(() => {
        setAt(Math.max(now + wait, sinceEpoch()));
        schedule();
      }, wait);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [still, delayMs]);

  if (items.length === 0) return null;
  const shown = reduced ? 0 : flipIndex(at, delayMs, items.length);
  return (
    <span className={styles.qflip} data-testid="qflip" aria-hidden="true">
      <span key={shown} className={styles.qflipItem}>
        {items[shown][lang]}
      </span>
    </span>
  );
}
