import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { mailReady } from "@/lib/notify";
import { can } from "@/lib/roles";
import { teamView } from "@/lib/team";
import TeamPanel from "@/components/app/TeamPanel";
import { teamPerms } from "@/components/app/teamPerms";

export const dynamic = "force-dynamic";

/**
 * Members: the people who share this account (docs/superpowers/specs/2026-09-29-teams-design.md §7). Rendered from
 * `teamView`, the same body GET /api/team returns, so the page makes no request on mount. Pending invites are in it only
 * for roles that may see them; the controls follow `can()` and the /api/team routes enforce the same table.
 */
export const generateMetadata = appScreenMeta("team");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!can(u, "team.view")) notFound();
  const view = await teamView(u);
  if (!view) notFound();
  return <TeamPanel t={appDict[lang]} lang={lang} initial={view} perms={teamPerms(u)} mailOn={mailReady()} />;
}
