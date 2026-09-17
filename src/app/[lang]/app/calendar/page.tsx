import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, listTasks } from "@/lib/brand";
import CalendarPanel from "@/components/app/CalendarPanel";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const [tasks, brand] = await Promise.all([listTasks(sc(u)), getBrand(sc(u))]);
  return <CalendarPanel t={appDict[lang]} lang={lang} tasks={tasks} channels={brand?.channels ?? []} />;
}
