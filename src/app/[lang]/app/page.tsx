import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { appHref, isBrandId } from "@/lib/brand-path";
import { pageHref } from "@/lib/page-href";

export const dynamic = "force-dynamic";

/**
 * `/{lang}/app` (rule 891, R-C5): the inbox moved to `/{lang}/app/b/{id}`, so this address goes to the inbox of the
 * session's last chosen brand (`u.brandId`), whatever the number of brands. The installed app's start URL, sign-in,
 * lifecycle mails and old bookmarks all land here. Nothing is read from the request but the session.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  // Never a loop back to this page: a brand id always reads as one (rule 886), else the 404.
  if (!isBrandId(u.brandId)) notFound();
  // With `MULTI_ORG` on, `/{lang}/app/w/{handle}` lands here too (the proxy's rewrite) and keeps its handle (`pageHref`).
  redirect((await pageHref(lang))("", u.brandId));
}
