import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, listTasks } from "@/lib/brand";
import { history } from "@/lib/chat";
import ChatPanel from "@/components/app/ChatPanel";
import HomeSide from "@/components/app/HomeSide";
import { kpis } from "@/lib/stats";
import { listConnections } from "@/lib/connectors/store";
import { getSchedule } from "@/lib/schedule";
import { listFiles } from "@/lib/files";
import { latestBrief } from "@/lib/schedule";
import { listNotifs } from "@/lib/notifications";
import { db } from "@/lib/db";
import type { PlanItem } from "@/lib/chat";

export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ conv?: string; prompt?: string; agent?: string; onboard?: string }> }) {
  const { lang } = await params;
  const sp = await searchParams;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!(await getBrand(sc(u)))) {
    // First run: the workspace is built inside the "Getting started" thread, not on a form.
    const onboard = typeof sp.onboard === "string" ? sp.onboard.trim().slice(0, 300) : "";
    if (onboard.length < 4) redirect(`/${lang}/app/start`);
    return (
      <div className="grid min-h-0 flex-1">
        <ChatPanel t={appDict[lang]} initial={await history(sc(u))} credits={u.credits} lang={lang} plan={u.plan} onboardUrl={onboard} needPhone={!u.phone} />
      </div>
    );
  }
  const conv = typeof sp.conv === "string" && /^[a-f0-9]{6,16}$/.test(sp.conv) ? sp.conv : undefined;
  const agentParam = typeof sp.agent === "string" && ["sami", "razan", "faris", "dana", "majed", "layan"].includes(sp.agent) ? sp.agent : undefined;
  const [initial, k, connections, schedule, files, brief, notifs, brand, tasks] = await Promise.all([history(sc(u), conv), kpis(sc(u)), listConnections(u.email), getSchedule(sc(u)), listFiles(sc(u)), latestBrief(sc(u)), listNotifs(u.email), getBrand(sc(u)), listTasks(sc(u))]);
  const op = await db.get<{ goal: string; plan: PlanItem[] }>(`onboardplan:${sc(u)}`);
  const starter = op?.goal ? { goal: op.goal, first: (op.plan.find((x) => !x.added) ?? op.plan[0])?.title } : null;
  const pendingTasks = tasks.filter((x) => x.status === "pending");
  const hasProducts = files.some((f) => f.name === "products.md");
  const firstStep = !hasProducts ? "catalog" : !brand?.offers ? "offer" : connections.length === 0 ? "connect" : "batch";
  return (
    <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[1fr_320px]">
      <ChatPanel t={appDict[lang]} initial={initial} credits={u.credits} lang={lang} initialConv={conv} starter={starter} needPhone={!u.phone} initialPrompt={typeof sp.prompt === "string" ? sp.prompt.slice(0, 2000) : ""} plan={u.plan} firstStep={firstStep} initialAgent={agentParam} pending={pendingTasks.slice(0, 1).map((x) => ({ id: x.id, type: x.type, channel: x.channel, title: x.title, body: x.editedBody ?? x.body, status: x.status }))} pendingCount={pendingTasks.length} brief={brief?.text ?? null} />
      <div className="hidden overflow-y-auto xl:block"><HomeSide t={appDict[lang]} lang={lang} k={k} connections={connections} schedule={schedule} files={files.map((f) => ({ name: f.name, updatedAt: f.updatedAt }))} brief={brief?.text ?? null} action={notifs.find((n) => !n.read) ?? null} /></div>
    </div>
  );
}
