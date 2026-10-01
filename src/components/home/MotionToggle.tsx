"use client";
import { HOME } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import { toggleMotion, useMotionPaused } from "./motion";
import styles from "./home.module.css";

/**
 * The page's pause button (WCAG 2.2.2), on the story's stage and in the lineup's head. Both copies read and write the
 * one switch in `./motion`. The label says what pressing it will do; both labels share one grid cell, so the button
 * keeps its size, and the hidden one is left out of its name. Without JavaScript it is hidden (see the CSS).
 */
export default function MotionToggle({ lang, className }: { lang: Lang; className?: string }) {
  const paused = useMotionPaused();
  return (
    <button type="button" className={className ? `${styles.motionToggle} ${className}` : styles.motionToggle} onClick={toggleMotion}>
      <span data-on={!paused || undefined}>{HOME.motionPause[lang]}</span>
      <span data-on={paused || undefined}>{HOME.motionPlay[lang]}</span>
    </button>
  );
}
