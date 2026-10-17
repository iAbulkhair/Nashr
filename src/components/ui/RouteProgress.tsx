"use client";
import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { PROGRESS_EVENT, progressStore, type ProgressPhase } from "@/lib/route-progress";

const idle = (): ProgressPhase => "idle";

function Bar() {
  const [store] = useState(() => progressStore());
  const phase = useSyncExternalStore(store.subscribe, store.phase, idle);
  const path = usePathname();
  const query = useSearchParams()?.toString() ?? "";
  useEffect(() => {
    const on = () => store.start();
    window.addEventListener(PROGRESS_EVENT, on);
    return () => window.removeEventListener(PROGRESS_EVENT, on);
  }, [store]);
  // The new address is on screen: the navigation is done.
  useEffect(() => { store.finish(); }, [store, path, query]);
  if (phase !== "running" && phase !== "ending") return null;
  return <div aria-hidden className={`route-progress ${phase === "ending" ? "is-done" : ""}`} />;
}

/**
 * The top progress bar during route changes (rule 2005): a thin bar along the top edge, in the ink token so it follows
 * light and dark, growing from the start side (right in Arabic). Decoration only, hidden from screen readers: the screen's
 * own loading status (`RouteLoading`) is what they hear. Under reduced motion it does not move. No dependency: the router
 * hook in src/instrumentation-client.ts starts it.
 */
export default function RouteProgress() {
  return <Suspense fallback={null}><Bar /></Suspense>;
}
