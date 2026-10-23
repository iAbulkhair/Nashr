import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { SETTINGS_COPY } from "@/lib/settings-nav";
import PageHeader from "@/components/ui/PageHeader";
import AccountSettings from "@/components/app/settings/AccountSettings";
import { getBrand } from "@/lib/brand";
import { acct } from "@/lib/account-id";
import { workspaceLabel } from "@/lib/workspace-name";

export const dynamic = "force-dynamic";
export const generateMetadata = settingsScreenMeta("account");

/**
 * Settings, Account (rule 1143): rendered from the session, never fetched on mount. The name and language are the acting
 * person's (a member's own record); the phone is the account's and goes to the owner only (`profile.account`), as
 * GET /api/profile already does. The workspace name (rules 3115-3118) is the owner's too: the name the switcher shows
 * (`workspaceLabel`, from the session's account and its default brand), changed through PUT /api/account/workspace.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const a = u.actor;
  const owner = can(u, "profile.account");
  const S = SETTINGS_COPY[lang].sections.account;
  const workspaceName = owner ? workspaceLabel(u, await getBrand(acct(u))) : undefined;
  return (
    <div className="grid gap-6">
      <PageHeader lang={lang} title={S.name} sub={S.sub} seed="settings-account" />
      <AccountSettings
        lang={lang}
        forbidden={appDict[lang].team.errors.forbidden}
        initial={{ name: a?.name ?? u.name, email: a?.email ?? u.email, lang: a?.lang ?? u.lang, owner, canChangeEmail: can(u, "email.change"), ...(owner ? { phone: u.phone ?? "", workspaceName } : {}) }}
      />
    </div>
  );
}
