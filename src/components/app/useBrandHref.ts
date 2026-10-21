"use client";
import { usePathname } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { appHref, brandFromPath } from "@/lib/brand-path";
import { withBrandQuery } from "@/lib/brand-fetch";

/**
 * Builds app links for the page being shown: the language and the brand come from the URL, else `fallbackBrand`
 * (a page that is not under `/b/{id}` yet, rule R-C8). Use it instead of writing `/${lang}/app/...` by hand.
 * Named `useBrandHref` so it cannot collide with the workspace-handle link hook of draft #418.
 */
export function useBrandHref(fallbackBrand?: string | null): (rest: string) => string {
  const pathname = usePathname() || "";
  const lang: Lang = /^\/en(\/|$)/.test(pathname) ? "en" : "ar";
  const brand = brandFromPath(pathname) ?? fallbackBrand ?? null;
  return (rest: string) => appHref(lang, rest, { brand });
}

/**
 * `apiHref` for a link drawn in the markup (R-C13): the brand comes from `usePathname()`, which the server render knows, so
 * the server HTML and the first client render give the same `href`. A click handler reads `apiHref` (the browser's
 * location) instead.
 */
export function useApiHref(): (path: string) => string {
  const brand = brandFromPath(usePathname() || "");
  return (path: string) => withBrandQuery(path, brand);
}
