import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, listLiteDays } from "@/lib/brand";
import CalendarPanel, { type CalendarRow } from "@/components/app/CalendarPanel";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const [tasks, brand] = await Promise.all([listLiteDays(sc(u), 365), getBrand(sc(u))]);
  // Project before serialising: everything below crosses the wire to the browser inside the RSC payload.
  const rows: CalendarRow[] = tasks.map((x) => ({ id: x.id, title: x.title, channel: x.channel, status: x.status, scheduledFor: x.scheduledFor, createdAt: x.createdAt, preview: x.preview }));
  return <CalendarPanel t={appDict[lang]} lang={lang} tasks={rows} channels={brand?.channels ?? []} />;
}
