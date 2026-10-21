import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { appHref, isBrandId, isBrandPath } from "@/lib/brand-path";
import { pageHref } from "@/lib/page-href";
import { LEGACY_SETTINGS, settingsHref } from "@/lib/settings-nav";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

/** The request's query again, every value of a repeated key kept, in order. Empty, or `?…`. */
function queryOf(sp: Search): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) for (const x of v) q.append(k, x);
    else if (typeof v === "string") q.append(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * An app path no folder claims (rule 891). The brand pages moved under `/{lang}/app/b/{id}` (rule 885); their old paths
 * (`/app/tasks?id=1`, `/app/settings/brand`, a link in a mail sent last week, a bookmark) and the three old names that
 * now land on brand settings sections (`onboarding`, `integrations`, `governance`, which the proxy leaves here) answer a
 * 307 to the same page under the session's last chosen brand, query kept, in one hop. A 307 like the proxy's legacy
 * redirects (rule 1141): a rollback finds the old pages again and no browser keeps the move for good. Anything else is
 * the app's 404, as before this page existed (`src/app/[lang]/[...rest]` answered it).
 *
 * The brand comes from the session only (`u.brandId`), never from the request. With `MULTI_ORG` on, an old path inside
 * `w/{handle}` keeps that handle (`pageHref`; `currentUser()` has checked it is one of the caller's workspaces). Each segment is encoded again before it
 * is matched, so a decoded `?`, `#` or `/` inside a segment never becomes a query or another section.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string; legacy: string[] }>; searchParams: Promise<Search> }) {
  const [{ lang, legacy }, sp] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  if (!isBrandId(u.brandId)) notFound();
  // An empty, "." or ".." segment names no page: it would only walk the redirect into another section.
  if (legacy.some((seg) => seg === "" || seg === "." || seg === "..")) notFound();
  const [query, href] = [queryOf(sp), await pageHref(lang)];
  const name = legacy.length === 1 ? legacy[0] : "";
  if (name && Object.hasOwn(LEGACY_SETTINGS, name)) redirect(settingsHref((p) => href(p, u.brandId), LEGACY_SETTINGS[name]) + query);
  const rest = `/${legacy.map(encodeURIComponent).join("/")}`;
  if (!isBrandPath(rest)) notFound();
  redirect(href(rest + query, u.brandId));
}
