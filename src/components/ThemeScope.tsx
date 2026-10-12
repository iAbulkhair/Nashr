"use client";
import { useEffect } from "react";
import { THEME_EVENT, applyTheme, readThemePref, resolveTheme } from "@/lib/theme";

/**
 * Keeps `data-theme` right after the first paint (rule 1203). The head script sets it on a full load; this covers client
 * navigation into and out of the app and the console (a soft navigation does not rerun the head script), a change of the
 * device setting while the page is open, and a new choice from `ThemeToggle`. Leaving the app for a public page puts the
 * light theme back. Renders nothing.
 */
export default function ThemeScope() {
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const sync = () => applyTheme(resolveTheme(readThemePref(document.cookie), !!mq?.matches, location.pathname));
    sync();
    mq?.addEventListener?.("change", sync);
    window.addEventListener(THEME_EVENT, sync);
    return () => {
      mq?.removeEventListener?.("change", sync);
      window.removeEventListener(THEME_EVENT, sync);
      applyTheme("light");
    };
  }, []);
  return null;
}
