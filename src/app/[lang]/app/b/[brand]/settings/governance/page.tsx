import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getGov, historyView, listGovHistory } from "@/lib/governance";
import { agentSpendFor } from "@/lib/credits";
import { CAPS } from "@/lib/db";
import { can } from "@/lib/roles";
import GovernancePanel from "@/components/app/GovernancePanel";
import { autoQueue } from "@/lib/handoff-auto";
import { appHref } from "@/lib/app-href";

export const dynamic = "force-dynamic";

export const generateMetadata = settingsScreenMeta("governance");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  // This brand's credits per agent this month, from the User record the ledger writes, and the change history of this
  // brand's settings: rendered here, never fetched on mount.
  // Every role reads the settings and their history; only the owner changes or restores them (PUT /api/governance and
  // POST /api/governance/rollback refuse the other roles for the same action).
  const [gov, history] = await Promise.all([getGov(sc(u)), listGovHistory(sc(u))]);
  // What Majed's auto-run may start next (empty while it is off): the owner can decline any of it here, including an
  // item whose card has scrolled out of its thread.
  const queue = await autoQueue(sc(u), gov);
  return <GovernancePanel t={appDict[lang]} lang={lang} initial={gov} spend={agentSpendFor(u, sc(u))} history={historyView(history)} historyCap={CAPS.govHistory} readOnly={!can(u, "governance.write")} queue={queue} canDecline={can(u, "drafts")} />;
}
