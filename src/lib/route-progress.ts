/**
 * The top progress bar's state (rule 2005), kept apart from React so a test can drive it with fake timers.
 *
 * `start` is called when the App Router begins a navigation (src/instrumentation-client.ts, `onRouterTransitionStart`);
 * `finish` when the new address is on screen (the bar's component sees the path or the query change). A fast navigation
 * never shows the bar: it waits `showAfter` first. One that never finishes (a navigation the router dropped) ends by
 * itself after `maxMs`, so the bar is never stuck on screen.
 */
export type ProgressPhase = "idle" | "waiting" | "running" | "ending";

export const PROGRESS_MS = { showAfter: 150, maxMs: 10_000, fade: 250 } as const;

/** The window event the router hook sends; the bar listens for it. A plain event, so no module is shared between bundles. */
export const PROGRESS_EVENT = "thakeen:route-start";

/**
 * Should a navigation to `target` show the bar? Only one that changes the page: another path or another query on this
 * origin. A jump to an anchor on the same page, the same address again, or a malformed URL do not.
 */
export function startsProgress(target: string, here: string): boolean {
  let to: URL, from: URL;
  try {
    from = new URL(here);
    to = new URL(target, from);
  } catch {
    return false;
  }
  if (to.origin !== from.origin) return false;
  return to.pathname !== from.pathname || to.search !== from.search;
}

export function progressStore(ms: { showAfter: number; maxMs: number; fade: number } = PROGRESS_MS) {
  let phase: ProgressPhase = "idle";
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const subs = new Set<() => void>();
  const set = (p: ProgressPhase) => {
    if (p === phase) return;
    phase = p;
    subs.forEach((f) => f());
  };
  const clear = () => { timers.forEach(clearTimeout); timers.clear(); };
  const later = (f: () => void, n: number) => { const t = setTimeout(() => { timers.delete(t); f(); }, n); timers.add(t); };
  const store = {
    start(): void {
      if (phase === "waiting" || phase === "running") return;
      clear();
      set("waiting");
      later(() => set("running"), ms.showAfter);
      later(() => store.finish(), ms.maxMs);
    },
    finish(): void {
      if (phase === "idle" || phase === "ending") return;
      clear();
      if (phase === "waiting") { set("idle"); return; }
      set("ending");
      later(() => set("idle"), ms.fade);
    },
    phase: (): ProgressPhase => phase,
    subscribe(f: () => void): () => void {
      subs.add(f);
      return () => { subs.delete(f); };
    },
  };
  return store;
}
