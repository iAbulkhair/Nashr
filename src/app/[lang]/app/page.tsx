import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { getBrand, listTasks } from "@/lib/brand";
import Inbox from "@/components/app/Inbox";
import { latestBrief } from "@/lib/schedule";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!(await getBrand(u.email))) redirect(`/${lang}/app/start`);
  return <Inbox t={appDict[lang]} lang={lang} tasks={await listTasks(u.email)} brief={(await latestBrief(u.email))?.text ?? null} />;
}
