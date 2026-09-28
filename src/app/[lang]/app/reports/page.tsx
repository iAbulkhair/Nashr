import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, listLite } from "@/lib/brand";
import { kpis, kpiSince, rangeWindow } from "@/lib/stats";
import { agentById } from "@/lib/agents";
import { scopeMetrics } from "@/lib/evals";
import { listConnections } from "@/lib/connectors/store";
import { getSalesSnapshot } from "@/lib/store-sales";
import ReportsPanel from "@/components/app/ReportsPanel";

export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: PageProps<"/[lang]/app/reports">) {
  const { lang } = await params;
  const { range: rawRange, from, to } = await searchParams;
  // The selected pill is echoed back to the panel, so it has to be a single value: a repeated "?range=" arrives as
  // an array and would otherwise be rendered as one.
  const range = typeof rawRange === "string" ? rawRange : "7";
  const win = rangeWindow(range, from, to);
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!(await getBrand(sc(u)))) redirect(`/${lang}/app/start`);
  const tasks = await listLite(sc(u), kpiSince(win));
  const [k, quality, connections, store] = await Promise.all([kpis(sc(u), undefined, win, tasks), scopeMetrics(sc(u), win), listConnections(sc(u)), getSalesSnapshot(sc(u))]);
  const dana = agentById("dana").tasks;
  const items = tasks.filter((t) => dana.includes(t.type)).slice(0, 20).map((t) => ({ id: t.id, type: t.type, title: t.title, status: t.status, createdAt: t.createdAt }));
  return <ReportsPanel t={appDict[lang]} lang={lang} k={k} items={items} credits={u.credits} quality={quality} range={range} connected={connections.map((c) => c.provider)} store={store} />;
}
