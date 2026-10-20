import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { listActivity, publicActivity } from "@/lib/activity";
import ActivityPanel from "@/components/app/ActivityPanel";
import { appHref } from "@/lib/app-href";

export const dynamic = "force-dynamic";

export const generateMetadata = appScreenMeta("activity");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  // The first page of this brand's activity log, rendered here and never fetched on mount. Every login of the account
  // opens this page and the rows are serialized into it, so `by` goes out through `publicBy` (no `imp`).
  const first = await listActivity(sc(u));
  return <ActivityPanel t={appDict[lang]} lang={lang} initial={first.rows.map(publicActivity)} next={first.next} />;
}
