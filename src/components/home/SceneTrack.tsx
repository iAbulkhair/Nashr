"use client";

import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import Scribble from "@/components/Scribble";
import type { Lang } from "@/lib/i18n";
import styles from "./home.module.css";

/** Smooth only when the visitor allows motion and the page's pause button has not turned it off (motion.ts). */
const smooth = () =>
  typeof window !== "undefined" && document.documentElement.dataset.motion !== "off" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto";

/** The slide a step lands on when the row loops: -1 from the first is the last, `n` from the last is the first. */
export const wrapIndex = (i: number, n: number) => (n > 0 ? ((i % n) + n) % n : 0);

/**
 * The scenes' slider (rule 775): one slide per child, side by side in a scroll-snapping row, so a swipe, the scrollbar or
 * the arrow keys move it without script. The script adds previous and next buttons and one dot per slide, and follows
 * the scroll to mark the slide in view. The buttons loop: next on the last slide goes to the first, previous on the
 * first goes to the last, so neither is ever disabled. In Arabic the row runs right to left, where `scrollLeft` counts
 * down from 0.
 */
export default function SceneTrack({ lang, label, prev, next, slide, children }: { lang: Lang; label: string; prev: string; next: string; slide: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const slides = Children.toArray(children);
  const n = slides.length;
  // Digits by hand, not Intl: the server and the browser carry different number data for Arabic (see src/lib/dates.ts).
  const num = (i: number) => (lang === "ar" ? String(i + 1).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[+d]) : String(i + 1));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const follow = () => setAt(Math.min(n - 1, Math.round(Math.abs(el.scrollLeft) / (el.clientWidth || 1))));
    el.addEventListener("scroll", follow, { passive: true });
    return () => el.removeEventListener("scroll", follow);
  }, [n]);

  const go = (i: number) => {
    const el = ref.current;
    if (!el) return;
    const k = wrapIndex(i, n);
    el.scrollTo({ left: (getComputedStyle(el).direction === "rtl" ? -1 : 1) * k * el.clientWidth, behavior: smooth() });
    setAt(k);
  };

  return (
    <div className={styles.car}>
      <div ref={ref} className={styles.track} tabIndex={0} role="region" aria-roledescription={lang === "ar" ? "عرض شرائح" : "carousel"} aria-label={label}>
        {slides.map((s, i) => (
          <div key={i} className={styles.slide} role="group" aria-roledescription={lang === "ar" ? "شريحة" : "slide"} aria-label={`${slide} ${num(i)} / ${num(n - 1)}`}>
            {s}
          </div>
        ))}
      </div>
      <div className={styles.carNav}>
        <button type="button" className={styles.arrow} onClick={() => go(at - 1)} aria-label={prev}>
          <Scribble kind="circleLoop" seed="car-prev" fill="paper" />
          <svg className={styles.chev} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5 L8 12 L15 19" />
          </svg>
        </button>
        <ol className={styles.pips} role="list">
          {slides.map((_, i) => (
            <li key={i}>
              <button type="button" className={styles.pip} onClick={() => go(i)} aria-current={i === at ? "true" : undefined} aria-label={`${slide} ${num(i)}`} />
            </li>
          ))}
        </ol>
        <button type="button" className={styles.arrow} onClick={() => go(at + 1)} aria-label={next}>
          <Scribble kind="circleLoop" seed="car-next" fill="paper" />
          <svg className={styles.chev} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 5 L16 12 L9 19" />
          </svg>
        </button>
      </div>
    </div>
  );
}
