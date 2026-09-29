import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { listActivity } from "@/lib/activity";
import ActivityPanel from "@/components/app/ActivityPanel";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // The first page of this brand's activity log, rendered here and never fetched on mount.
  const first = await listActivity(sc(u));
  return <ActivityPanel t={appDict[lang]} lang={lang} initial={first.rows} next={first.next} />;
}
