"use client";
import { useRef, useSyncExternalStore } from "react";
import type { Lang } from "@/lib/i18n";
import { THEME_COPY, THEME_EVENT, THEME_PREFS, legacyThemeExpiry, readThemePref, themeCookie, type ThemePref } from "@/lib/theme";
import { tabStep } from "@/components/ui/Tabs";

function subscribe(cb: () => void) {
  window.addEventListener(THEME_EVENT, cb);
  return () => window.removeEventListener(THEME_EVENT, cb);
}
const snapshot = (): ThemePref => readThemePref(document.cookie);
const serverSnapshot = (): ThemePref => "system";

/** Saves the choice on this browser and tells `ThemeScope` to repaint (rule 1204). */
export function chooseTheme(pref: ThemePref) {
  document.cookie = themeCookie(pref, location.protocol === "https:");
  document.cookie = legacyThemeExpiry();
  window.dispatchEvent(new Event(THEME_EVENT));
}

/**
 * Light, dark or the device's setting (rule 1204): a `role="radiogroup"` of three buttons, the chosen one `aria-checked`
 * and the only one in the Tab order; the arrows move and choose, mirrored in a right-to-left row (`tabStep`, rule 1113).
 * 44px tall on touch screens; the choice is marked by fill and weight, not colour alone. The server renders "system"
 * and the browser reads the cookie after hydration, so the markup never mismatches.
 */
export default function ThemeToggle({ lang, size = "md", className = "" }: { lang: Lang; size?: "sm" | "md"; className?: string }) {
  const value = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const c = THEME_COPY[lang];
  function onKey(e: React.KeyboardEvent<HTMLElement>, i: number) {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const next = tabStep(e.key, i, THEME_PREFS.length, rtl);
    if (next === null) return;
    e.preventDefault();
    chooseTheme(THEME_PREFS[next]);
    refs.current[next]?.focus();
  }
  const pad = size === "sm" ? "px-2.5 text-xs pointer-fine:min-h-7" : "px-3.5 text-sm pointer-fine:min-h-8 pointer-fine:text-xs";
  return (
    <div role="radiogroup" aria-label={c.label} className={`inline-flex items-center gap-0.5 rounded-full border-[1.5px] border-border-strong bg-surface p-0.5 ${className}`}>
      {THEME_PREFS.map((p, i) => {
        const on = p === value;
        return (
          <button
            key={p}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => chooseTheme(p)}
            onKeyDown={(e) => onKey(e, i)}
            className={`min-h-[var(--hit-min)] rounded-full ${pad} ${on ? "bg-inverse font-semibold text-inverse-foreground" : "text-foreground-muted hover:text-foreground"}`}
          >
            {c[p]}
          </button>
        );
      })}
    </div>
  );
}
