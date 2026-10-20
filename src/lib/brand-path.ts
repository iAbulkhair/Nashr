import type { Lang } from "./i18n";

/**
 * Brand ids in app URLs (rules 889-890, brand id in the URL "Part C").
 *
 * Pure on purpose: no React, no db, no server import. The proxy, server pages and client components all import it.
 * That is also why the brand id shape lives here and not in `stored.ts` (which pulls in the logger): `stored.ts`
 * imports `BRAND_ID_RE` from this file, so `isBrandId` and the `ActiveBrandId` schema cannot drift apart.
 */

/** Header the browser fetch wrapper (`installBrandFetch`) sets from the page's `/b/{id}` segment. The server still checks the brand against the caller's scope. */
export const BRAND_HEADER = "x-thakeen-brand";

/**
 * A brand id: "default" or the eight base-36 characters `createBrand` writes. Wider than that on purpose (letters,
 * digits, `_`, `-`, up to 64) so an older id still reads, but narrow enough that an id can sit in a path segment:
 * no `/`, no `%`, no dot, so `..%2f` and path tricks never pass.
 */
export const BRAND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isBrandId(v: unknown): v is string {
  return typeof v === "string" && BRAND_ID_RE.test(v);
}

/**
 * The paths after `/{lang}/app` that live under `b/{id}`. `""` is the inbox. A page under one of these (a record id, a
 * sub-path) is a brand path too. Everything else (billing, team, account, admin) stays on the unprefixed path.
 */
export const BRAND_SECTIONS: readonly string[] = [
  "",
  "chat",
  "conversations",
  "tasks",
  "calendar",
  "files",
  "generate",
  "reports",
  "activity",
  "todo",
  "inspo",
  "instructions",
  "start",
  "settings/brand",
  "settings/connections",
  "settings/governance",
  // Per-brand notification preferences (`profile:{sc(u)}`), R-C10.
  "settings/notifications",
];

/** `rest` with no query or hash, a leading `/` or empty, and no trailing `/`. */
function cleanPath(rest: string): string {
  const cut = rest.search(/[?#]/);
  const p = cut === -1 ? rest : rest.slice(0, cut);
  const trimmed = p.replace(/\/+$/, "");
  return trimmed === "" || trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** The section a path belongs to ("" for the inbox, null when it is not a brand path). The longest match wins. */
function sectionOf(rest: string): string | null {
  const p = cleanPath(rest);
  if (p === "") return "";
  let best: string | null = null;
  for (const s of BRAND_SECTIONS) {
    if (s === "") continue;
    const at = `/${s}`;
    if ((p === at || p.startsWith(`${at}/`)) && (best === null || s.length > best.length)) best = s;
  }
  return best;
}

/** `rest` is the path after `/{lang}/app` (leading `/` or empty, no query). True when it names a brand section or a path under one. */
export function isBrandPath(rest: string): boolean {
  return sectionOf(rest) !== null;
}

/**
 * The workspace handle segment draft PR #418 (multi-workspace) puts after `/app`: `/{lang}/app/w/{handle}/…`. Part C does
 * not read or issue handles; it only tolerates the segment and keeps it, so the two features compose without a rewrite.
 * Same shape as #418's handle (`w_` and sixteen base-32 characters).
 */
const HANDLE_RE = /^w_[a-z2-7]{16}$/;

/** The id in `/{lang}/app/b/{id}(/...)` or `/{lang}/app/w/{handle}/b/{id}(/...)`, only when it is a brand id. The segment is not decoded, so an encoded trick is no id. */
export function brandFromPath(pathname: string): string | null {
  const m = /^\/(?:ar|en)\/app(?:\/w\/w_[a-z2-7]{16})?\/b\/([^/?#]+)(?:[/?#]|$)/.exec(pathname);
  return m && isBrandId(m[1]) ? m[1] : null;
}

/** The one place that builds the `/{lang}/app` prefix, with `/w/{handle}` after it when a handle is kept (see HANDLE_RE). */
function appPrefix(lang: Lang, handle?: string | null): string {
  return typeof handle === "string" && HANDLE_RE.test(handle) ? `/${lang}/app/w/${handle}` : `/${lang}/app`;
}

/**
 * A link into the app. `rest` is the path after `/{lang}/app` and may carry a query and a hash. A brand section with a
 * brand becomes `/{lang}/app/b/{brand}{rest}` (inbox: `/{lang}/app/b/{brand}`); a brand section without one, or any
 * other path, stays on `/{lang}/app{rest}` (the legacy path, which redirects to the brand path).
 */
export function appHref(lang: Lang, rest: string, ctx?: { brand?: string | null; handle?: string | null }): string {
  const cut = rest.search(/[?#]/);
  const suffix = cut === -1 ? "" : rest.slice(cut);
  const path = cleanPath(rest);
  const brand = ctx?.brand;
  if (isBrandId(brand) && isBrandPath(path)) return `${appPrefix(lang, ctx?.handle)}/b/${brand}${path}${suffix}`;
  return `${appPrefix(lang, ctx?.handle)}${path}${suffix}`;
}

/**
 * The same page under another brand. A path deeper than a section root (a record id) falls back to the section root,
 * since the record belongs to the old brand; the query is dropped; a non-brand path goes to the inbox of `to`.
 */
export function switchBrandPath(pathname: string, to: string): string {
  const m = /^\/(ar|en)\/app(?:\/w\/(w_[a-z2-7]{16}))?(\/[^?#]*)?/.exec(pathname);
  const lang: Lang = m && m[1] === "en" ? "en" : "ar";
  const handle = m?.[2] ?? null;
  const rest = m?.[3] ?? "";
  const inBrand = /^\/b\/([^/]+)(\/.*)?$/.exec(rest);
  if (!inBrand || !isBrandId(inBrand[1])) return appHref(lang, "", { brand: to, handle });
  const section = sectionOf(inBrand[2] ?? "");
  return appHref(lang, section ? `/${section}` : "", { brand: to, handle });
}
