"use client";
import { useEffect, useState } from "react";
import type { Question } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import { useReducedMotion } from "./useReducedMotion";
import styles from "./home.module.css";

/** Spec §7.3: one question visible, a new one every 2.4 s. */
const FLIP_MS = 2400;

/**
 * The questions an agent takes off the owner's head, one at a time. Decorative (`aria-hidden`): the figure exposes its
 * first question as static text. Starts advancing `delayMs` after mount, so figures never flip together. Under reduced
 * motion it stays on the first question; while `paused` it holds the question it is on.
 */
export default function QuestionFlip({ items, lang, delayMs = 0, paused = false }: { items: Question[]; lang: Lang; delayMs?: number; paused?: boolean }) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const still = reduced || paused || items.length < 2;

  useEffect(() => {
    if (still) return;
    let every: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      every = setInterval(() => setIndex((n) => (n + 1) % items.length), FLIP_MS);
    }, delayMs);
    return () => {
      clearTimeout(start);
      if (every) clearInterval(every);
    };
  }, [still, delayMs, items.length]);

  if (items.length === 0) return null;
  const shown = reduced ? 0 : index % items.length;
  return (
    <span className={styles.qflip} data-testid="qflip" aria-hidden="true">
      <span key={shown} className={styles.qflipItem}>
        {items[shown][lang]}
      </span>
    </span>
  );
}
