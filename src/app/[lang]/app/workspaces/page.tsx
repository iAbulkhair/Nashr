import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentPerson } from "@/lib/auth";
import { MULTI_ORG } from "@/lib/multi-org";
import { appScreenMeta } from "@/lib/screen-titles";
import { listWorkspaces } from "@/lib/workspaces";
import WorkspacesPanel from "@/components/app/WorkspacesPanel";

export const dynamic = "force-dynamic";
export const generateMetadata = appScreenMeta("workspaces");

/**
 * `/{lang}/app/workspaces` (multi-workspace M2, docs/specs/2026-10-18-multi-org.md sections 7 and 16): the person's
 * workspaces, create, and the "no workspace" state the app layout sends a person to when their workspace is gone. A
 * person-level page (outside `w/{handle}`), behind `currentPerson()`. With `MULTI_ORG` off it does not exist.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang) || !MULTI_ORG) notFound();
  const me = await currentPerson();
  if (!me) redirect(`/${lang}/app/login`);
  const rows = await listWorkspaces(me.person, me.acct);
  return <WorkspacesPanel t={appDict[lang].workspaces} lang={lang} initial={rows} canCreate={!!me.person.emailVerifiedAt} />;
}
