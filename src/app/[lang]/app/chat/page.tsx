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
import { latestBrief } from "@/lib/schedule";
import { listNotifs } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ conv?: string; prompt?: string }> }) {
  const { lang } = await params;
  const sp = await searchParams;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!(await getBrand(sc(u)))) redirect(`/${lang}/app/start`);
  const conv = typeof sp.conv === "string" && /^[a-f0-9]{6,16}$/.test(sp.conv) ? sp.conv : undefined;
  const [initial, k, connections, schedule, files, brief, notifs, brand] = await Promise.all([history(sc(u), conv), kpis(sc(u)), listConnections(u.email), getSchedule(sc(u)), listFiles(sc(u)), latestBrief(sc(u)), listNotifs(u.email), getBrand(sc(u))]);
  const hasProducts = files.some((f) => f.name === "products.md");
  const firstStep = !hasProducts ? "catalog" : !brand?.offers ? "offer" : connections.length === 0 ? "connect" : "batch";
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <ChatPanel t={appDict[lang]} initial={initial} credits={u.credits} lang={lang} initialConv={conv} initialPrompt={typeof sp.prompt === "string" ? sp.prompt.slice(0, 2000) : ""} plan={u.plan} firstStep={firstStep} wide />
      <div className="hidden xl:block"><HomeSide t={appDict[lang]} lang={lang} k={k} connections={connections} schedule={schedule} files={files.map((f) => ({ name: f.name, updatedAt: f.updatedAt }))} brief={brief?.text ?? null} action={notifs.find((n) => !n.read) ?? null} /></div>
    </div>
  );
}
