"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Scribble from "@/components/Scribble";
import type { Lang } from "@/lib/i18n";
import styles from "./home.module.css";

/**
 * Whether the bar shows (rule 1845): only once the cover's form has scrolled up past the top of the screen, and never
 * while the closing call or the footer is on screen, so it never covers another way to start or the footer's links.
 */
const noSubscribe = () => () => {};

/** How far below the screen the form observer's root reaches: past the bottom of any page this tall. */
export const FAR_BELOW = 100_000;

export const barShows =(s: { formAbove: boolean; endShowing: boolean }) => s.formAbove && !s.endShowing;

/**
 * The phone's start bar (rule 1845): a sentinel that sits where the cover's form ends, and a bar fixed to the bottom of
 * the screen with the same start as the nav's button. CSS hides it from 700px up. Until the bar is wanted it is
 * `hidden`, so neither a screen reader nor the tab order meets a second start button. The bar is portalled to `body`:
 * every home panel is its own stacking context (`isolation: isolate`), so inside the cover the next panels would paint
 * over it.
 */
export default function StickyStart({ lang, label }: { lang: Lang; label: string }) {
  const sentinel = useRef<HTMLSpanElement>(null);
  const [formAbove, setFormAbove] = useState(false);
  const [endShowing, setEndShowing] = useState(false);
  // `body` exists only in the browser; the server and the hydrating render draw no bar.
  const host = useSyncExternalStore(noSubscribe, () => document.body, () => null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    // The root reaches far below the screen, so the sentinel counts as "in" until it passes the top edge. With the form
    // under the team (rule 1892) it starts below the first screen, and a jump past it (a nav anchor, a fast fling) went
    // from below to above without ever meeting the screen: a plain observer saw no change and the bar never showed.
    const form = new IntersectionObserver(([e]) => setFormAbove(!e.isIntersecting && e.boundingClientRect.top < 0), {
      rootMargin: `0px 0px ${FAR_BELOW}px 0px`,
    });
    form.observe(el);
    const seen = new Set<Element>();
    const end = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) seen.add(e.target);
        else seen.delete(e.target);
      }
      setEndShowing(seen.size > 0);
    });
    document.querySelectorAll("#start, main ~ footer").forEach((n) => end.observe(n));
    return () => {
      form.disconnect();
      end.disconnect();
    };
  }, []);
  const on = barShows({ formAbove, endShowing });
  return (
    <>
      <span ref={sentinel} className={styles.stickySentinel} aria-hidden="true" />
      {host &&
        createPortal(
          <div className={styles.sticky} data-testid="sticky-start" hidden={!on}>
            <Link href={`/${lang}/app/signup`} className={`s-btn ${styles.stickyBtn}`}>
              <Scribble kind="pill" seed="sticky-start" fill="ink" shadow ring />
              {label}
            </Link>
          </div>,
          host,
        )}
    </>
  );
}
