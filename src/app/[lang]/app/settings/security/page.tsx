import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { SETTINGS_COPY } from "@/lib/settings-nav";
import PageHeader from "@/components/ui/PageHeader";
import SecuritySettings from "@/components/app/settings/SecuritySettings";

export const dynamic = "force-dynamic";
export const generateMetadata = settingsScreenMeta("security");

/** Settings, Security (rule 1150): `may` is `can()` on the server; PATCH /api/account and POST /api/account/sessions enforce it again. */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const t = appDict[lang];
  const S = SETTINGS_COPY[lang].sections.security;
  return (
    <div className="grid gap-6">
      <PageHeader lang={lang} title={S.name} sub={S.sub} seed="settings-security" />
      <SecuritySettings lang={lang} rules={t.join.rules} may={can(u, "password.change") && can(u, "sessions.revoke")} owner={u.actor?.kind === "owner"} forbidden={t.team.errors.forbidden} />
    </div>
  );
}
