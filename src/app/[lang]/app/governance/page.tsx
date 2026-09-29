import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getGov } from "@/lib/governance";
import { agentSpendFor } from "@/lib/credits";
import GovernancePanel from "@/components/app/GovernancePanel";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // This brand's credits per agent this month, from the User record the ledger writes: rendered here, never fetched on mount.
  return <GovernancePanel t={appDict[lang]} initial={await getGov(sc(u))} spend={agentSpendFor(u, sc(u))} />;
}
