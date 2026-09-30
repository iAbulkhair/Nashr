import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, getTask, listLite } from "@/lib/brand";
import { history } from "@/lib/chat";
import ChatPanel from "@/components/app/ChatPanel";
import HomeSide from "@/components/app/HomeSide";
import { kpis, kpiSince } from "@/lib/stats";
import { listConnections } from "@/lib/connectors/store";
import { getSchedule } from "@/lib/schedule";
import { listFiles } from "@/lib/files";
import { latestBrief } from "@/lib/schedule";
import { listNotifs } from "@/lib/notifications";
import { db } from "@/lib/db";
import type { PlanItem } from "@/lib/chat";
import { loadJourney } from "@/lib/journey-load";
import { confirmedOnboard, onboardUrl } from "@/lib/onboard-confirm";
import { isAgentId } from "@/lib/agents";
import { can } from "@/lib/roles";

export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: PageProps<"/[lang]/app/chat">) {
  const { lang } = await params;
  const sp = await searchParams;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // The WhatsApp prompt saves the ACCOUNT's phone (owner only: "profile.account"), so no other role is asked for it.
  const needPhone = !u.phone && can(u, "profile.account");
  if (!(await getBrand(sc(u)))) {
    // Building the workspace is admin and owner only ("onboard"): anyone else waits on the start page, which says so.
    if (!can(u, "onboard")) redirect(`/${lang}/app/start`);
    // First run: the workspace is built inside the "Getting started" thread, not on a form, and only from the site the
    // owner confirmed on the start page. A `?onboard=` from a link goes back there as the pre-filled value to review.
    const [onboard, initial] = await Promise.all([confirmedOnboard(sc(u)), history(sc(u))]);
    if (!onboard) {
      const asked = onboardUrl(sp.onboard);
      redirect(`/${lang}/app/start${asked.length >= 4 ? `?url=${encodeURIComponent(asked)}` : ""}`);
    }
    return (
      <div className="grid min-h-0 flex-1">
        <ChatPanel t={appDict[lang]} initial={initial} credits={u.credits} lang={lang} plan={u.plan} onboardUrl={onboard} needPhone={needPhone} />
      </div>
    );
  }
  const conv = typeof sp.conv === "string" && /^[a-f0-9]{6,16}$/.test(sp.conv) ? sp.conv : undefined;
  // Any specialist in the registry (Noor is the default thread, so she needs no parameter).
  const agentParam = isAgentId(sp.agent) && sp.agent !== "noor" ? sp.agent : undefined;
  // One light read feeds both the side panel numbers and the "waiting for you" card; only that one card needs a body.
  const [initial, connections, schedule, files, brief, notifs, brand, rows, op, journey] = await Promise.all([history(sc(u), conv), listConnections(sc(u)), getSchedule(sc(u)), listFiles(sc(u)), latestBrief(sc(u)), listNotifs(u.email), getBrand(sc(u)), listLite(sc(u), kpiSince()), db.get<{ goal: string; plan: PlanItem[] }>(`onboardplan:${sc(u)}`), loadJourney(sc(u), u.email)]);
  const firstPending = rows.find((x) => x.status === "pending");
  const [k, pendingTask] = await Promise.all([kpis(sc(u), undefined, undefined, rows), firstPending ? getTask(sc(u), firstPending.id) : null]);
  const starter = op?.goal ? { goal: op.goal, first: (op.plan.find((x) => !x.added) ?? op.plan[0])?.title } : null;
  const hasProducts = files.some((f) => f.name === "products.md");
  const firstStep = !hasProducts ? "catalog" : !brand?.offers ? "offer" : connections.length === 0 ? "connect" : "batch";
  return (
    <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[1fr_320px]">
      <ChatPanel t={appDict[lang]} journey={journey} initial={initial} credits={u.credits} lang={lang} initialConv={conv} starter={starter} needPhone={needPhone} canApprove={can(u, "publish")} canBrand={can(u, "brand.write")} initialPrompt={typeof sp.prompt === "string" ? sp.prompt.slice(0, 2000) : ""} plan={u.plan} firstStep={firstStep} initialAgent={agentParam} pending={(pendingTask ? [pendingTask] : []).map((x) => ({ id: x.id, type: x.type, channel: x.channel, title: x.title, body: x.editedBody ?? x.body, status: x.status }))} pendingCount={k.pending} brief={brief?.text ?? null} />
      <div className="hidden overflow-y-auto xl:block"><HomeSide t={appDict[lang]} lang={lang} k={k} connections={connections} schedule={schedule} files={files.map((f) => ({ name: f.name, updatedAt: f.updatedAt }))} brief={brief?.text ?? null} action={notifs.find((n) => !n.read) ?? null} /></div>
    </div>
  );
}
