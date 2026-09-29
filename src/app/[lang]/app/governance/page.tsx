import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getGov, historyView, listGovHistory } from "@/lib/governance";
import { agentSpendFor } from "@/lib/credits";
import { CAPS } from "@/lib/db";
import GovernancePanel from "@/components/app/GovernancePanel";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // This brand's credits per agent this month, from the User record the ledger writes, and the change history of this
  // brand's settings: rendered here, never fetched on mount.
  const [gov, history] = await Promise.all([getGov(sc(u)), listGovHistory(sc(u))]);
  return <GovernancePanel t={appDict[lang]} lang={lang} initial={gov} spend={agentSpendFor(u, sc(u))} history={historyView(history)} historyCap={CAPS.govHistory} />;
}
