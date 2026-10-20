import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { entitlements } from "@/lib/entitlements";
import { getBrand, listTasks } from "@/lib/brand";
import Inbox from "@/components/app/Inbox";
import { latestBrief } from "@/lib/schedule";
import { connectedTargets } from "@/lib/connectors/targets";
import { listConnections } from "@/lib/connectors/store";
import { loadJourney } from "@/lib/journey-load";
import { can } from "@/lib/roles";
import { availableModels, offModels } from "@/lib/media/config";
import { modelState } from "@/lib/model";
import { revisePrice } from "@/lib/revise";
import { DRAFT_TYPES, type TaskType } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export const generateMetadata = appScreenMeta("home");

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ lang }, sp = {}] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const brand = await getBrand(sc(u));
  if (!brand) redirect(`/${lang}/app/start`);
  // One round, not three. These were three awaits in argument position, so they ran one after another — the same
  // instinct as the project's rule against `await db.*` inside a loop, just without the loop.
  const [tasks, brief, connections, journey, off] = await Promise.all([listTasks(sc(u)), latestBrief(sc(u)), listConnections(sc(u)), loadJourney(sc(u), u.email, { brand }), offModels()]);
  // One draft's price per draft type (rule 2492), the same function the revise route charges with; none for a role that may not edit.
  const revisePrices: Partial<Record<TaskType, number>> = {};
  if (can(u, "drafts")) for (const type of DRAFT_TYPES) { const p = revisePrice(u, brand, type); if (p !== null) revisePrices[type] = p; }
  // The media models on offer (keys, Blob store, MEDIA_MODELS_ON, not switched off by the breaker) and the pause, read
  // per request: the page is dynamic, and the start routes check the same things again. `included` is the plan's own list of
  // video models (rule 781), passed down because the client components must not import entitlements.
  return <Inbox revisePrices={revisePrices} t={appDict[lang]} lang={lang} tasks={tasks} brief={brief?.text ?? null} connected={connectedTargets(connections)} banned={brand.banned} journey={journey} media={availableModels(undefined, off)} included={entitlements(u).media.video} credits={u.credits} plan={u.plan} paused={modelState() !== "on"} canPublish={can(u, "publish")} owner={can(u, "billing")} initialFilter={sp.view === "notnow" ? "notnow" : undefined} />;
}
