import { PROGRESS_EVENT, startsProgress } from "@/lib/route-progress";

/**
 * Runs in the browser before hydration (Next 16 `instrumentation-client`). Only the router hook is here: when the App
 * Router starts a navigation that changes the page, the top progress bar is told through a window event (rule 2005).
 * Kept tiny: Next warns when this file takes more than 16ms.
 */
export function onRouterTransitionStart(url: string) {
  try {
    if (startsProgress(url, window.location.href)) window.dispatchEvent(new CustomEvent(PROGRESS_EVENT));
  } catch {
    // The bar is decoration: a failure here must never touch the navigation.
  }
}
