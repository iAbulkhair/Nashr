import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { listNotifs } from "@/lib/notifications";
import NotificationsPanel from "@/components/app/NotificationsPanel";

export const dynamic = "force-dynamic";

export const generateMetadata = appScreenMeta("notifications");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  return <NotificationsPanel t={appDict[lang]} initial={await listNotifs(u.email)} />;
}
