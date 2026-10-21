"use client";
import { usePathname } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { brandFromPath } from "@/lib/brand-path";
import { withBrandQuery } from "@/lib/brand-fetch";
import { handleOfPath } from "@/lib/ws-path";
import { useAppLink, useWsHandle } from "./WorkspaceContext";

/**
 * Builds app links for the page being shown: the language, the workspace and the brand come from the URL, else the
 * shell's workspace and `fallbackBrand` (a page that is not under `/b/{id}` yet, rule R-C8). Use it instead of writing
 * `/${lang}/app/...` by hand. The same builder as `useAppLink` (WorkspaceContext.tsx), the language read from the path;
 * with `MULTI_ORG` off it is Part C's brand link.
 */
export function useBrandHref(fallbackBrand?: string | null): (rest: string) => string {
  const pathname = usePathname() || "";
  const lang: Lang = /^\/en(\/|$)/.test(pathname) ? "en" : "ar";
  return useAppLink(lang, fallbackBrand);
}

/**
 * `apiHref` for a link drawn in the markup (R-C13): the brand and the workspace come from `usePathname()` (the workspace
 * else the shell's), which the server render knows, so the server HTML and the first client render give the same `href`.
 * A click handler reads `apiHref` (the browser's location) instead.
 */
export function useApiHref(): (path: string) => string {
  const pathname = usePathname() || "";
  const ctxHandle = useWsHandle();
  const brand = brandFromPath(pathname);
  const handle = handleOfPath(pathname) ?? ctxHandle;
  return (path: string) => withBrandQuery(path, brand, handle);
}
