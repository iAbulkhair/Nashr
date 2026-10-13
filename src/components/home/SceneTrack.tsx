"use client";

import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Scribble from "@/components/Scribble";
import type { Lang } from "@/lib/i18n";
import { toggleMotion, useMotionPaused, useReducedMotion, useShowing } from "./motion";
import styles from "./home.module.css";

/** How long a slide stays before the row moves on by itself. */
export const AUTO_MS = 6000;

/**
 * Whether the row advances by itself (WCAG 2.2.2): never for a visitor who asks for less motion or who paused the page's
 * motion or this slider, and not while a mouse rests on the slides, a keyboard sits in them, or the row is off screen.
 */
export const autoplays = (s: { reduced: boolean; paused: boolean; held: boolean; over: boolean; focused: boolean; showing: boolean; n: number }) =>
  !s.reduced && !s.paused && !s.held && !s.over && !s.focused && s.showing && s.n > 1;

/** Smooth only when the visitor allows motion and the page's pause button has not turned it off (motion.ts). */
const smooth = () =>
  typeof window !== "undefined" && document.documentElement.dataset.motion !== "off" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto";

/** The slide a step lands on when the row loops: -1 from the first is the last, `n` from the last is the first. */
export const wrapIndex = (i: number, n: number) => (n > 0 ? ((i % n) + n) % n : 0);

/**
 * The scenes' slider (rule 775): one slide per child, side by side in a scroll-snapping row, so a swipe, the scrollbar or
 * the arrow keys move it without script. The script adds previous and next buttons and one dot per slide, and follows
 * the scroll to mark the slide in view. The buttons loop: next on the last slide goes to the first, previous on the
 * first goes to the last, so neither is ever disabled. With script, motion allowed and the row on screen it also moves
 * on by itself every `AUTO_MS`; its own pause button stops that, and so do the page's pause button, a resting mouse and
 * keyboard focus in the slides (`autoplays`). In Arabic the row runs right to left, where `scrollLeft` counts down from 0.
 */
export default function SceneTrack({
  lang,
  label,
  prev,
  next,
  slide,
  pause,
  play,
  children,
}: {
  lang: Lang;
  label: string;
  prev: string;
  next: string;
  slide: string;
  pause: string;
  play: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const car = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  const [over, setOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = useMotionPaused();
  const showing = useShowing(car, { threshold: 0.3 });
  const reduced = useReducedMotion();
  const slides = Children.toArray(children);
  const n = slides.length;
  // Western digits in both languages (rule 1584), written by hand so the server and the browser always agree.
  const num = (i: number) => String(i + 1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const follow = () => setAt(Math.min(n - 1, Math.round(Math.abs(el.scrollLeft) / (el.clientWidth || 1))));
    el.addEventListener("scroll", follow, { passive: true });
    return () => el.removeEventListener("scroll", follow);
  }, [n]);

  const go = useCallback(
    (i: number) => {
      const el = ref.current;
      if (!el) return;
      const k = wrapIndex(i, n);
      // A step past either end jumps across the row: sweeping back over every slide would be a long, busy scroll.
      el.scrollTo({ left: (getComputedStyle(el).direction === "rtl" ? -1 : 1) * k * el.clientWidth, behavior: k !== i ? "auto" : smooth() });
      setAt(k);
    },
    [n],
  );

  const auto = autoplays({ reduced, paused, held, over, focused, showing, n });
  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(() => go(at + 1), AUTO_MS);
    return () => window.clearTimeout(t);
  }, [auto, at, go]);

  // What the button shows is what pressing it does. If the page's pause button had stopped the motion, play starts it too.
  const stopped = held || paused;
  const toggleAuto = () => {
    if (paused) {
      toggleMotion();
      setHeld(false);
    } else setHeld(!held);
  };
  // Keyboard focus in the slides or the arrows holds the row; a mouse click, and the play button itself, do not.
  const holdsRow = (t: EventTarget) => t instanceof HTMLElement && !t.hasAttribute("data-auto") && t.matches(":focus-visible");

  return (
    <div
      ref={car}
      className={styles.car}
      onFocus={(e) => setFocused(holdsRow(e.target))}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
    >
      <div
        ref={ref}
        className={styles.track}
        tabIndex={0}
        role="region"
        aria-roledescription={lang === "ar" ? "عرض شرائح" : "carousel"}
        aria-label={label}
        aria-live={auto ? "off" : "polite"}
        onPointerEnter={(e) => e.pointerType === "mouse" && setOver(true)}
        onPointerLeave={() => setOver(false)}
      >
        {slides.map((s, i) => (
          <div key={i} className={styles.slide} role="group" aria-roledescription={lang === "ar" ? "شريحة" : "slide"} aria-label={`${slide} ${num(i)} / ${num(n - 1)}`}>
            {s}
          </div>
        ))}
      </div>
      <div className={styles.carNav}>
        <button type="button" className={`${styles.arrow} ${styles.autoBtn}`} data-auto onClick={toggleAuto} aria-label={stopped ? play : pause}>
          <Scribble kind="circleLoop" seed="car-auto" fill="paper" />
          <svg className={styles.glyph} viewBox="0 0 24 24" aria-hidden="true">
            {stopped ? <path d="M8 5 L18 12 L8 19 Z" /> : <path d="M9 6 V18 M15 6 V18" />}
          </svg>
        </button>
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
