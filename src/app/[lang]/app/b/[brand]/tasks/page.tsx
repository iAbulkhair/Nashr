import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getSchedule } from "@/lib/schedule";
import { ROUTINES, routineLastRuns, routinesHeld, routinesPaused } from "@/lib/routines";
import { can } from "@/lib/roles";
import TasksPanel from "@/components/app/TasksPanel";
import { appHref } from "@/lib/brand-path";
export const dynamic = "force-dynamic";
export const generateMetadata = appScreenMeta("tasks");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  // Server-rendered, so the page makes no request on mount.
  const [schedule, last, held, paused] = await Promise.all([getSchedule(sc(u)), routineLastRuns(sc(u)), routinesHeld(sc(u)), routinesPaused(sc(u))]);
  const routines = ROUTINES.map((r) => ({ id: r.id, agent: r.agent, type: r.type, cadence: r.cadence, last: last[r.id], ...(held[r.id] ? { held: true } : {}), ...(paused[r.id] ? { paused: true } : {}) }));
  // Switching scheduled work on spends credits with no request, so it is owner/admin (PUT /api/schedule checks the same
  // `can()`); "Run now" is an explicit request and stays open to every role.
  return <TasksPanel t={appDict[lang]} initial={schedule} routines={routines} readOnly={!can(u, "schedule.write")} />;
}
