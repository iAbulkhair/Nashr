import type { Lang } from "./i18n";

/**
 * The language a page is served in when its text exists in only some languages (rule 3313). Pure and import-free (a type
 * only), so a server page, a route handler and a test read the same answer.
 *
 * A post or a help topic that has not been translated is not a 404 and not a half-translated page: the existing version is
 * shown on the other language's URL, with a short notice in the visitor's language, and the page names the existing version
 * as its canonical address so a search engine files the text once. The page's own chrome (navigation, footer) stays in the
 * visitor's language; the text carries the `lang` and `dir` of the language it is written in.
 */

/** Arabic first: with two languages and only one present, the order never matters; with more, Arabic is the site's default. */
const ORDER: readonly Lang[] = ["ar", "en"];

export type Served = { lang: Lang; fallback: boolean };

/**
 * The language to serve a page in. `requested` when the text exists in it; otherwise the first language that has it, in the
 * site's order, marked `fallback`; `null` when it exists in none (a 404). `available` is a list the content itself declares,
 * never one read from a request.
 */
export function serve(requested: Lang, available: readonly Lang[]): Served | null {
  if (available.includes(requested)) return { lang: requested, fallback: false };
  const first = ORDER.find((l) => available.includes(l));
  return first ? { lang: first, fallback: true } : null;
}

/** The two names of a language, written in the visitor's own: «English» on an Arabic page, "Arabic" on an English one. */
const NAME: Record<Lang, Record<Lang, string>> = {
  ar: { ar: "العربية", en: "الإنجليزية" },
  en: { ar: "Arabic", en: "English" },
};

/**
 * The notice above a fallback page, in the visitor's language: this page is not available in their language yet, and what
 * follows is the version in the other one. No promise of a translation, no date, no number.
 */
export function fallbackNotice(visitor: Lang, served: Lang): string {
  return visitor === "ar"
    ? `هذه الصفحة غير متوفرة بالعربية بعد. تقرأ النسخة ${NAME.ar[served]}.`
    : `This page is not available in English yet. You are reading the ${NAME.en[served]} version.`;
}

/** The canonical path of a page (`path` begins with `/`, such as `/blog/x`): the existing version's, never the requested one's. */
export const servedPath = (served: Lang, path: string): string => `/${served}${path}`;

/** The attributes for text written in `served`, on a page whose chrome is in another language. */
export const textAttrs = (served: Lang): { lang: Lang; dir: "rtl" | "ltr" } => ({ lang: served, dir: served === "ar" ? "rtl" : "ltr" });
