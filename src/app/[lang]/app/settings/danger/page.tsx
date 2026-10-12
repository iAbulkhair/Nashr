import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { SETTINGS_COPY } from "@/lib/settings-nav";
import PageHeader from "@/components/ui/PageHeader";
import DangerZone from "@/components/app/settings/DangerZone";

export const dynamic = "force-dynamic";
export const generateMetadata = settingsScreenMeta("danger");

/** Settings, Danger zone (rule 1149): who may delete comes from `can()`, which refuses a founder viewing the account. */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const t = appDict[lang];
  const S = SETTINGS_COPY[lang].sections.danger;
  return (
    <div className="grid gap-6">
      <PageHeader lang={lang} title={S.name} sub={S.sub} seed="settings-danger" />
      <DangerZone
        lang={lang}
        email={u.actor?.email ?? u.email}
        owner={u.actor?.role === "owner"}
        canDelete={can(u, "account.delete")}
        impersonating={u.actor?.kind === "founder"}
        logoutLabel={t.nav.logout}
        failText={{ forbidden: t.team.errors.forbidden, failed: t.team.errors.failed }}
      />
    </div>
  );
}
