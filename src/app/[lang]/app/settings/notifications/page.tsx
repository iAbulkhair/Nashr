import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser, sc } from "@/lib/auth";
import { can } from "@/lib/roles";
import { readPrefs } from "@/lib/notify-prefs";
import { SETTINGS_COPY } from "@/lib/settings-nav";
import PageHeader from "@/components/ui/PageHeader";
import NotifyPrefsSettings from "@/components/app/settings/NotifyPrefsSettings";

export const dynamic = "force-dynamic";
export const generateMetadata = settingsScreenMeta("notifications");

/**
 * Settings, Notifications (rule 1144): the choices that apply to the active brand, read from the session's scope (the
 * brand's record, else the account's, as the senders read them), in either stored shape. Only the owner changes them
 * (PUT /api/notifications/prefs checks `profile.account`); the bell's feed stays at /app/notifications.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const S = SETTINGS_COPY[lang].sections.notifications;
  return (
    <div className="grid gap-6">
      <PageHeader lang={lang} title={S.name} sub={S.sub} seed="settings-notifications" />
      <NotifyPrefsSettings lang={lang} initial={await readPrefs(sc(u), u.email)} canEdit={can(u, "profile.account")} />
    </div>
  );
}
