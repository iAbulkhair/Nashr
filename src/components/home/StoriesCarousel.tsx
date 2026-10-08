"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Scribble from "@/components/Scribble";
import { STORIES } from "@/lib/stories";
import type { Lang } from "@/lib/i18n";
import styles from "./home.module.css";

/**
 * The stories' slide track: CSS scroll-snap does the sliding (so swipe, trackpad and keyboard scroll work with no
 * script), and these buttons and dots only call `scrollTo` on it. Without script every slide is still reachable by
 * scrolling. Each slide is one `<li>` child, announced as "Slide n of N".
 */
export default function StoriesCarousel({ lang, count, children }: { lang: Lang; count: number; children: ReactNode }) {
  const track = useRef<HTMLUListElement>(null);
  const [at, setAt] = useState(0);
  const rtl = lang === "ar";

  const sync = useCallback(() => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    setAt(Math.min(count - 1, Math.max(0, Math.round(Math.abs(el.scrollLeft) / el.clientWidth))));
  }, [count]);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    el.addEventListener("scroll", sync, { passive: true });
    return () => el.removeEventListener("scroll", sync);
  }, [sync]);

  const go = (i: number) => {
    const el = track.current;
    if (!el) return;
    const n = Math.min(count - 1, Math.max(0, i));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: (rtl ? -1 : 1) * n * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div className={styles.stCarousel} role="group" aria-roledescription="carousel" aria-label={STORIES.h[lang]}>
      <ul className={styles.stTrack} ref={track} role="list" tabIndex={0} aria-label={STORIES.h[lang]}>
        {children}
      </ul>
      <div className={styles.stCtl}>
        <button type="button" className={`s-btn ${styles.stArrow}`} onClick={() => go(at - 1)} disabled={at === 0} aria-label={STORIES.prev[lang]}>
          <Scribble kind="pill" seed="st-prev" fill="paper" ring />
          <span aria-hidden="true">{rtl ? "→" : "←"}</span>
        </button>
        <ol className={styles.stDots} role="list">
          {Array.from({ length: count }, (_, i) => (
            <li key={i}>
              <button type="button" className={i === at ? `${styles.stDot} ${styles.stDotOn}` : styles.stDot} onClick={() => go(i)} aria-label={`${STORIES.slide[lang]} ${i + 1} ${STORIES.of[lang]} ${count}`} aria-current={i === at ? "true" : undefined} />
            </li>
          ))}
        </ol>
        <button type="button" className={`s-btn ${styles.stArrow}`} onClick={() => go(at + 1)} disabled={at === count - 1} aria-label={STORIES.next[lang]}>
          <Scribble kind="pill" seed="st-next" fill="paper" ring />
          <span aria-hidden="true">{rtl ? "←" : "→"}</span>
        </button>
      </div>
    </div>
  );
}
