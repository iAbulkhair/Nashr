import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { SETTINGS_COPY } from "@/lib/settings-nav";
import PageHeader from "@/components/ui/PageHeader";
import AccountSettings from "@/components/app/settings/AccountSettings";
import AvatarUpload from "@/components/app/settings/AvatarUpload";
import { getAvatar } from "@/lib/avatar";
import LogoUpload from "@/components/app/settings/LogoUpload";
import { getLogo } from "@/lib/workspace-logo";
import { aidOf } from "@/lib/membership";

export const dynamic = "force-dynamic";
export const generateMetadata = settingsScreenMeta("account");

/**
 * Settings, Account (rule 1143): rendered from the session, never fetched on mount. The name and language are the acting
 * person's (a member's own record); the phone is the account's and goes to the owner only (`profile.account`), as
 * GET /api/profile already does.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const a = u.actor;
  const owner = can(u, "profile.account");
  const S = SETTINGS_COPY[lang].sections.account;
  // Rule 3502: the acting person's picture. Only the person themself changes it: a founder impersonating or a token cannot.
  const self = a && (a.kind === "owner" || a.kind === "member");
  // Rule 3610: the workspace's logo, the session's account only; everyone sees it, `workspace.logo` changes it.
  const [avatar, logo] = await Promise.all([a ? getAvatar(a.pid) : Promise.resolve(null), getLogo(aidOf(u))]);
  return (
    <div className="grid gap-6">
      <PageHeader lang={lang} title={S.name} sub={S.sub} seed="settings-account" />
      <AvatarUpload lang={lang} name={a?.name ?? u.name} email={a?.email ?? u.email} initial={avatar} canEdit={!!self} />
      <LogoUpload lang={lang} name={u.workspaceName?.trim() || u.name} initial={logo} canEdit={can(u, "workspace.logo")} />
      <AccountSettings
        lang={lang}
        forbidden={appDict[lang].team.errors.forbidden}
        initial={{ name: a?.name ?? u.name, email: a?.email ?? u.email, lang: a?.lang ?? u.lang, owner, canChangeEmail: can(u, "email.change"), ...(owner ? { phone: u.phone ?? "" } : {}) }}
      />
    </div>
  );
}
