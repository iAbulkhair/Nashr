"use client";
import { usePathname } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { appHref, brandFromPath } from "@/lib/app-href";

/**
 * Builds app links for the page being shown: the language and the brand come from the URL, else `fallbackBrand`
 * (a page that is not under `/b/{id}` yet, rule R-C8). Use it instead of writing `/${lang}/app/...` by hand.
 */
export function useAppHref(fallbackBrand?: string | null): (rest: string) => string {
  const pathname = usePathname() || "";
  const lang: Lang = /^\/en(\/|$)/.test(pathname) ? "en" : "ar";
  const brand = brandFromPath(pathname) ?? fallbackBrand ?? null;
  return (rest: string) => appHref(lang, rest, { brand });
}
