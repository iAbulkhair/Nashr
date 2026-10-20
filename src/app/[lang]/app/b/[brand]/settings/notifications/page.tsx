import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser, sc } from "@/lib/auth";
import { can } from "@/lib/roles";
import { readPrefs } from "@/lib/notify-prefs";
import { getDigest } from "@/lib/notif-digest";
import { acct } from "@/lib/account-id";
import { SETTINGS_COPY } from "@/lib/settings-nav";
import PageHeader from "@/components/ui/PageHeader";
import NotifyPrefsSettings from "@/components/app/settings/NotifyPrefsSettings";
import { appHref } from "@/lib/brand-path";

export const dynamic = "force-dynamic";
export const generateMetadata = settingsScreenMeta("notifications");

/**
 * Settings, Notifications (rule 1144): the choices that apply to the active brand, read from the session's scope (the
 * brand's record, else the account's, as the senders read them), in either stored shape. Only the owner changes them
 * (PUT /api/notifications/prefs checks `profile.account`); the bell's feed stays at /app/notifications. The digest email
 * (rule 2355) is the account's choice, read from `notifydigest:{account}` and saved by PUT /api/notifications/digest.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  const S = SETTINGS_COPY[lang].sections.notifications;
  const [prefs, digest] = await Promise.all([readPrefs(sc(u), u.email), getDigest(acct(u))]);
  return (
    <div className="grid gap-6">
      <PageHeader lang={lang} title={S.name} sub={S.sub} seed="settings-notifications" />
      <NotifyPrefsSettings lang={lang} initial={prefs} digest={digest} canEdit={can(u, "profile.account")} />
    </div>
  );
}
