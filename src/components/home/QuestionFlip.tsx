"use client";
import { useEffect, useState } from "react";
import type { Question } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import { useReducedMotion } from "./useReducedMotion";
import styles from "./home.module.css";

/** Spec §7.3: one question visible, a new one every 2.4 s. */
const FLIP_MS = 2400;

/**
 * One clock for every flip on the page, started by the first one to run. Each flip reads its question from this clock
 * instead of counting its own timer ticks, so timers that fire late (a busy page, a throttled background tab) never
 * pull the figures' stagger apart: they would all end up flipping together.
 */
let epoch: number | undefined;
const sinceEpoch = () => performance.now() - (epoch ??= performance.now());

/**
 * The questions an agent takes off the owner's head, one at a time. Decorative (`aria-hidden`): the figure exposes its
 * first question as static text. Question `n` shows from `delayMs + n × 2.4 s` on the shared clock, so figures with
 * different delays never flip together. Under reduced motion it stays on the first question; while `paused` it holds
 * the question it is on, and when it resumes it catches up with the clock at the next flip.
 */
export default function QuestionFlip({ items, lang, delayMs = 0, paused = false }: { items: Question[]; lang: Lang; delayMs?: number; paused?: boolean }) {
  const reduced = useReducedMotion();
  const [tick, setTick] = useState(0);
  const still = reduced || paused || items.length < 2;

  useEffect(() => {
    if (still) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const t = sinceEpoch() - delayMs;
      const next = Math.floor(t / FLIP_MS) + 1;
      timer = setTimeout(() => {
        // A timer that fired very late (a background tab) jumps straight to where the clock is now.
        setTick(Math.max(next, Math.floor((sinceEpoch() - delayMs) / FLIP_MS)));
        schedule();
      }, next * FLIP_MS - t);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [still, delayMs]);

  if (items.length === 0) return null;
  const shown = reduced ? 0 : Math.max(0, tick) % items.length;
  return (
    <span className={styles.qflip} data-testid="qflip" aria-hidden="true">
      <span key={shown} className={styles.qflipItem}>
        {items[shown][lang]}
      </span>
    </span>
  );
}
