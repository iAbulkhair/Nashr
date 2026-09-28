import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, listTasks } from "@/lib/brand";
import Inbox from "@/components/app/Inbox";
import { latestBrief } from "@/lib/schedule";
import { connectedTargets } from "@/lib/connectors/targets";
import { listConnections } from "@/lib/connectors/store";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!(await getBrand(sc(u)))) redirect(`/${lang}/app/start`);
  // One round, not three. These were three awaits in argument position, so they ran one after another — the same
  // instinct as the project's rule against `await db.*` inside a loop, just without the loop.
  const [tasks, brief, connections] = await Promise.all([listTasks(sc(u)), latestBrief(sc(u)), listConnections(sc(u))]);
  return <Inbox t={appDict[lang]} lang={lang} tasks={tasks} brief={brief?.text ?? null} connected={connectedTargets(connections)} />;
}
