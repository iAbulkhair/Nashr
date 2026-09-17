import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { history } from "@/lib/chat";
import ChatPanel from "@/components/app/ChatPanel";
import HomeSide from "@/components/app/HomeSide";
import { kpis } from "@/lib/stats";
import { listConnections } from "@/lib/connectors/store";
import { getSchedule } from "@/lib/schedule";
import { listFiles } from "@/lib/files";

export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ conv?: string; prompt?: string }> }) {
  const { lang } = await params;
  const sp = await searchParams;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!(await getBrand(sc(u)))) redirect(`/${lang}/app/start`);
  const conv = typeof sp.conv === "string" && /^[a-f0-9]{6,16}$/.test(sp.conv) ? sp.conv : undefined;
  const [initial, k, connections, schedule, files] = await Promise.all([history(sc(u), conv), kpis(sc(u)), listConnections(u.email), getSchedule(sc(u)), listFiles(sc(u))]);
  return (
    <div className="grid gap-4 2xl:grid-cols-[1fr_300px]">
      <ChatPanel t={appDict[lang]} initial={initial} credits={u.credits} lang={lang} initialConv={conv} initialPrompt={typeof sp.prompt === "string" ? sp.prompt.slice(0, 2000) : ""} plan={u.plan} />
      <div className="hidden 2xl:block"><HomeSide t={appDict[lang]} lang={lang} k={k} connections={connections} schedule={schedule} files={files.map((f) => ({ name: f.name, updatedAt: f.updatedAt }))} /></div>
    </div>
  );
}
