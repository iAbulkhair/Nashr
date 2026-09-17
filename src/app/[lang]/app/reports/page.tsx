import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, listTasks } from "@/lib/brand";
import { kpis, rangeWindow } from "@/lib/stats";
import { agentById } from "@/lib/agents";
import { scopeMetrics } from "@/lib/evals";
import { listConnections } from "@/lib/connectors/store";
import ReportsPanel from "@/components/app/ReportsPanel";

export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const { lang } = await params;
  const { range, from, to } = await searchParams;
  const win = rangeWindow(range ?? "7", from, to);
  const days = Math.max(1, Math.round((win.to.getTime() - win.from.getTime()) / 864e5));
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!(await getBrand(sc(u)))) redirect(`/${lang}/app/start`);
  const [k, tasks, quality, connections] = await Promise.all([kpis(sc(u), undefined, win), listTasks(sc(u)), scopeMetrics(sc(u), u.email, days), listConnections(u.email)]);
  const dana = agentById("dana").tasks;
  const items = tasks.filter((t) => dana.includes(t.type)).slice(0, 20).map((t) => ({ id: t.id, type: t.type, title: t.title, status: t.status, createdAt: t.createdAt }));
  return <ReportsPanel t={appDict[lang]} lang={lang} k={k} items={items} credits={u.credits} quality={quality} range={range ?? "7"} connected={connections.map((c) => c.provider)} />;
}
