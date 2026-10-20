import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, getTask, isWaiting, listLite } from "@/lib/brand";
import { historyFor } from "@/lib/chat-history";
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
import { chatItemOf, getHandoffs, handoffViews, type Handoff, type HandoffView } from "@/lib/handoffs";
import { getGov } from "@/lib/governance";
import { chatStatus } from "@/lib/chat-allowance";
import { route } from "@/lib/models/route";
import { chatRouteFor } from "@/lib/models/overrides";
import { getConversation } from "@/lib/conversations";
import { wsKey } from "@/lib/keys";
import { acct } from "@/lib/account-id";
import { appHref } from "@/lib/app-href";

export const dynamic = "force-dynamic";

export const generateMetadata = appScreenMeta("chat");

export default async function Page({ params, searchParams }: PageProps<"/[lang]/app/b/[brand]/chat">) {
  const { lang } = await params;
  const sp = await searchParams;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  // The WhatsApp prompt saves the ACCOUNT's phone (owner only: "profile.account"), so no other role is asked for it.
  const needPhone = !u.phone && can(u, "profile.account");
  // The model picker's one-time consent to China-hosted models is the owner's own, never given while a founder
  // impersonates (PUT /api/models checks the same in code); anyone else is told only the owner can allow them.
  const canConfirmChina = can(u, "profile.account") && u.actor?.kind !== "founder";
  if (!(await getBrand(sc(u)))) {
    // Building the workspace is admin and owner only ("onboard"): anyone else waits on the start page, which says so.
    if (!can(u, "onboard")) redirect(appHref(lang, "/start", { brand: u.brandId }));
    // First run: the workspace is built inside the "Getting started" thread, not on a form, and only from the site the
    // owner confirmed on the start page. A `?onboard=` from a link goes back there as the pre-filled value to review.
    const [onboard, initial, chat] = await Promise.all([confirmedOnboard(sc(u)), historyFor(sc(u)), chatStatus(u, route("chat").model)]);
    if (!onboard) {
      const asked = onboardUrl(sp.onboard);
      redirect(appHref(lang, `/start${asked.length >= 4 ? `?url=${encodeURIComponent(asked)}` : ""}`, { brand: u.brandId }));
    }
    return (
      <div className="grid min-h-0 flex-1">
        {/* The same key as the default thread below, so the panel keeps its state when onboarding ends and the page
            re-renders with the brand file (rule 962). */}
        <ChatPanel key="default" t={appDict[lang]} initial={initial} credits={u.credits} lang={lang} plan={u.plan} onboardUrl={onboard} needPhone={needPhone} chat={chat} canConfirmChina={canConfirmChina} canInstructions={can(u, "instructions.write")} />
      </div>
    );
  }
  const conv = typeof sp.conv === "string" && /^[a-f0-9]{6,16}$/.test(sp.conv) ? sp.conv : undefined;
  // Any specialist in the registry (Noor is the default thread, so she needs no parameter).
  const agentParam = isAgentId(sp.agent) && sp.agent !== "noor" ? sp.agent : undefined;
  // One light read feeds both the side panel numbers and the "waiting for you" card; only that one card needs a body.
  // The chat allowance is the ACCOUNT's (`u` is the owner's record for every seat), shown under the box (rule 315).
  // The active conversation's record, read once: its pick sets the allowance line's ceiling and the model picker's
  // selection (the sidebar's list holds only the newest hundred, so an older conversation opened by link needs its own).
  const record = getConversation(sc(u), conv);
  const [initial, connections, schedule, files, brief, notifs, brand, rows, op, journey, chat] = await Promise.all([historyFor(sc(u), conv), listConnections(sc(u)), getSchedule(sc(u)), listFiles(sc(u)), latestBrief(sc(u)), listNotifs(acct(u)), getBrand(sc(u)), listLite(sc(u), kpiSince()), db.get<{ goal: string; plan: PlanItem[] }>(wsKey.onboardPlan(sc(u))), loadJourney(sc(u), u.email), record.then((c) => chatStatus(u, chatRouteFor(u, c).model))]);
  const active = await record;
  const firstPending = rows.find(isWaiting);
  // Majed's handoff cards in this thread (every one it names: the thread holds at most 40 messages, one card each), read
  // here with their stored state: the records in one MGET, the tasks they made in another, the settings once. A card
  // whose record is gone (180 days, or pushed off the index) is sent as null, so the page shows "no longer available"
  // without a request that could only answer 404.
  const refs = [...new Set(initial.flatMap((m) => (m.handoff ? [m.handoff.id] : [])))];
  const cards = async (): Promise<Record<string, HandoffView | null>> => {
    if (!refs.length) return {};
    const [hs, gov] = await Promise.all([getHandoffs(sc(u), refs), getGov(sc(u))]);
    const found = hs.filter((h): h is Handoff => h !== null);
    const views = new Map((await handoffViews(sc(u), found, gov)).map((v) => [v.id, v]));
    return Object.fromEntries(refs.map((id) => [id, views.get(id) ?? null]));
  };
  const [k, pendingTask, handoffs] = await Promise.all([kpis(sc(u), undefined, undefined, rows), firstPending ? getTask(sc(u), firstPending.id) : null, cards()]);
  const starter = op?.goal ? { goal: op.goal, first: (op.plan.find((x) => !x.added) ?? op.plan[0])?.title } : null;
  const hasProducts = files.some((f) => f.name === "products.md");
  const firstStep = !hasProducts ? "catalog" : !brand?.offers ? "offer" : connections.length === 0 ? "connect" : "batch";
  return (
    <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[1fr_320px]">
      {/* Keyed by the thread (rule 962): the sidebar's links to another conversation or specialist are client navigations
          to this same page, and without a key React keeps the panel's state, so the old thread stayed on screen and the
          next message went to the old conversation. A new key mounts a fresh panel on the new thread's messages. */}
      <ChatPanel key={conv ?? agentParam ?? "default"} t={appDict[lang]} journey={journey} initial={initial} credits={u.credits} lang={lang} initialConv={conv} starter={starter} needPhone={needPhone} canApprove={can(u, "publish")} canBrand={can(u, "brand.write")} canInstructions={can(u, "instructions.write")} canRun={can(u, "generate")} canDecline={can(u, "drafts")} handoffs={handoffs} initialPrompt={typeof sp.prompt === "string" ? sp.prompt.slice(0, 2000) : ""} plan={u.plan} firstStep={firstStep} initialAgent={agentParam} pending={(pendingTask ? [pendingTask] : []).map(chatItemOf)} pendingCount={k.pending} brief={brief?.text ?? null} chat={chat} canConfirmChina={canConfirmChina} active={active ? { id: active.id, model: active.model } : null} />
      <div className="hidden overflow-y-auto xl:block"><HomeSide t={appDict[lang]} lang={lang} k={k} connections={connections} schedule={schedule} files={files.map((f) => ({ name: f.name, updatedAt: f.updatedAt }))} brief={brief?.text ?? null} action={notifs.find((n) => !n.read) ?? null} /></div>
    </div>
  );
}
