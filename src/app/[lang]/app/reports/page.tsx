import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, listTasks } from "@/lib/brand";
import { kpis } from "@/lib/stats";
import { agentById } from "@/lib/agents";
import ReportsPanel from "@/components/app/ReportsPanel";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!(await getBrand(sc(u)))) redirect(`/${lang}/app/start`);
  const [k, tasks] = await Promise.all([kpis(sc(u)), listTasks(sc(u))]);
  const dana = agentById("dana").tasks;
  const items = tasks.filter((t) => dana.includes(t.type)).slice(0, 20).map((t) => ({ id: t.id, type: t.type, title: t.title, status: t.status, createdAt: t.createdAt }));
  return <ReportsPanel t={appDict[lang]} lang={lang} k={k} items={items} credits={u.credits} />;
}
