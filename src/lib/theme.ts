/**
 * Light, dark or the device's choice (rules 1203-1205, UI/UX report §5.2). The choice is the viewer's, kept in the
 * first-party cookie `nashr_theme` on this browser (like `nashr_lang`): no account field, nothing stored on the server,
 * so no stored shape changes. Pure helpers: the head script in src/app/[lang]/layout.tsx is built from the same
 * constants, and `ThemeScope` / `ThemeToggle` (client) call these.
 *
 * Scope: every page under /{lang}, public pages too (rule 1214, the founder's yes on 2026-10-12; it replaces "public pages
 * stay light" from rules 1203 and 1227). Light stays the default for a viewer who never chose and whose device is light
 * (report §8.1: our buyer reads the site on a phone in daylight). Outside /{lang} (the OAuth consent page) stays light.
 */
export const THEME_COOKIE = "nashr_theme";
export const THEME_PREFS = ["system", "light", "dark"] as const;
export type ThemePref = (typeof THEME_PREFS)[number];
export type Theme = "light" | "dark";
/** The event `ThemeToggle` fires after it writes the cookie, so `ThemeScope` re-applies without a reload. */
export const THEME_EVENT = "nashr-theme";

export const isThemePref = (v: unknown): v is ThemePref => typeof v === "string" && (THEME_PREFS as readonly string[]).includes(v);

const COOKIE_RE = /(?:^|;\s*)nashr_theme=(system|light|dark)(?:;|$)/;
/** The choice in a `document.cookie` string; "system" when there is none or it is not one of the three. */
export function readThemePref(cookie: string | null | undefined): ThemePref {
  return (COOKIE_RE.exec(cookie ?? "")?.[1] as ThemePref | undefined) ?? "system";
}

/** The paths that follow the choice: every page in either language, public pages, the app and the console (rule 1214). */
export const THEMED_PATH = /^\/(?:ar|en)(?:\/|$)/;

/** The theme to paint. */
export function resolveTheme(pref: ThemePref, systemDark: boolean, path: string): Theme {
  if (!THEMED_PATH.test(path)) return "light";
  return pref === "dark" || (pref === "system" && systemDark) ? "dark" : "light";
}

/** The cookie line the toggle writes: a year, the whole site, lax, Secure on https. Holds only the word. */
export function themeCookie(pref: ThemePref, secure: boolean): string {
  return `${THEME_COOKIE}=${pref}; path=/; max-age=31536000; samesite=lax${secure ? "; secure" : ""}`;
}

/**
 * Runs in <head> before the body is parsed, so the first paint already has the right theme (Next's guide "Preventing
 * flash before hydration", themes, cookie variant: the page stays statically prerendered). Reads only the cookie,
 * `matchMedia` and the path; any error leaves the light default.
 */
export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,m=${COOKIE_RE.toString()}.exec(document.cookie),p=m?m[1]:"system",s=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;d.setAttribute("data-theme",${THEMED_PATH.toString()}.test(location.pathname)&&(p==="dark"||(p==="system"&&s))?"dark":"light")}catch(e){}})()`;

/** Applies a theme to the page (client only). */
export function applyTheme(theme: Theme, root: { setAttribute(n: string, v: string): void } = document.documentElement) {
  root.setAttribute("data-theme", theme);
}

/** The words for the three choices. */
export const THEME_COPY = {
  ar: { label: "المظهر", system: "حسب الجهاز", light: "فاتح", dark: "داكن", sub: "يُحفظ على هذا الجهاز. «حسب الجهاز» يتبع إعداد جهازك.", title: "المظهر" },
  en: { label: "Appearance", system: "System", light: "Light", dark: "Dark", sub: "Saved on this device. System follows your device's setting.", title: "Appearance" },
} as const;
