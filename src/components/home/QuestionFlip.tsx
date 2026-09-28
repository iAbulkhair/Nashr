"use client";
import { useEffect, useRef, useState } from "react";
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
 * first question as static text. Under reduced motion it stays on the first question; while `paused` it holds the
 * question it is on.
 *
 * `phase="shared"` (the lineup): the question comes from the page's shared clock, `delayMs` behind it, so figures with
 * different delays never flip together and never drift; after a pause it catches up with the clock at its next flip.
 * `phase="resume"` (the story): after a pause it carries on from the question on screen and flips 2.4 s later.
 */
export default function QuestionFlip({
  items,
  lang,
  delayMs = 0,
  paused = false,
  phase = "shared",
}: {
  items: Question[];
  lang: Lang;
  delayMs?: number;
  paused?: boolean;
  phase?: "shared" | "resume";
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(0);
  // The question on screen, for a flip that resumes from it.
  const onScreen = useRef(0);
  const still = reduced || paused || items.length < 2;

  useEffect(() => {
    onScreen.current = shown;
  }, [shown]);

  useEffect(() => {
    if (still) return;
    const resume = phase === "resume";
    const from = resume ? onScreen.current : 0;
    const origin = performance.now();
    const clock = resume ? () => performance.now() - origin : sinceEpoch;
    const delay = resume ? 0 : delayMs;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const now = clock();
      const wait = untilNextFlip(now, delay);
      // Never behind the flip it waited for (a timer can fire a hair early), and straight to where the clock is now
      // when it fired very late (a background tab).
      timer = setTimeout(() => {
        setShown(flipIndex(Math.max(now + wait, clock()), delay, items.length, from));
        schedule();
      }, wait);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [still, phase, delayMs, items.length]);

  if (items.length === 0) return null;
  const index = reduced ? 0 : shown % items.length;
  return (
    <span className={styles.qflip} data-testid="qflip" aria-hidden="true">
      <span key={index} className={styles.qflipItem}>
        {items[index][lang]}
      </span>
    </span>
  );
}
