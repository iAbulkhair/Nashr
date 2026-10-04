import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

/*
 * The homepage's one motion switch (WCAG 2.2.2). The pause button in the lineup's head writes it; the floating doodles
 * and the seams between sections stop on the attribute it sets, so pausing stops everything that moves on its own. It lives in this module
 * rather than in React context so the page itself stays a server component. Playing by default, and on the server.
 */
let paused = false;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Pauses the page's motion if it is playing, or plays it if it is paused. */
export function toggleMotion(): void {
  paused = !paused;
  // The CSS-only decoration (floats, seams) stops on `html[data-motion="off"]` without needing React.
  if (paused) document.documentElement.dataset.motion = "off";
  else delete document.documentElement.dataset.motion;
  listeners.forEach((l) => l());
}

/** True while the visitor has paused the page's motion. */
export function useMotionPaused(): boolean {
  return useSyncExternalStore(subscribe, () => paused, () => false);
}

/**
 * True while the element is on screen (at least `threshold` of it) and the tab is showing. `initial` is the answer
 * before the first observation arrives, on the server and in the first client render alike, so the two agree.
 */
export function useShowing(ref: RefObject<HTMLElement | null>, { threshold = 0, initial = false } = {}): boolean {
  const [showing, setShowing] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let onScreen = false;
    const update = () => setShowing(onScreen && document.visibilityState === "visible");
    const observer = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        update();
      },
      { threshold },
    );
    observer.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref, threshold]);
  return showing;
}
