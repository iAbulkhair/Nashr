import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { SETTINGS_COPY } from "@/lib/settings-nav";
import PageHeader from "@/components/ui/PageHeader";
import HelpLink from "@/components/ui/HelpLink";
import { helpHref } from "@/lib/help";
import SecuritySettings from "@/components/app/settings/SecuritySettings";
import { passkeysOn } from "@/lib/passkey-switch";
import { actingLogin } from "@/lib/own-password";

export const dynamic = "force-dynamic";
export const generateMetadata = settingsScreenMeta("security");

/**
 * Settings, Security (rules 1150, 1930, 1938, customer passkeys 2412 and 2426): `may` is `can()` on the server; PATCH
 * /api/account, POST /api/account/password-link, /api/account/sessions, /api/account/2fa and /api/account/passkeys
 * enforce it again. `enabled` is the
 * passkey off switch, read here so the card hides its add button (the routes refuse adding all the same).
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const t = appDict[lang];
  const S = SETTINGS_COPY[lang].sections.security;
  // A read error on the switch must not break password change and two-step: adding shows as off (fails closed).
  // Whether the acting login has a password (rule 3101): without one the card offers "Set a password", which mails the
  // reset link to this same address. A read error keeps the change form (the route refuses a login that has one).
  const [enabled, me] = await Promise.all([passkeysOn().catch(() => false), actingLogin(u).catch(() => null)]);
  return (
    <div className="grid gap-6">
      <PageHeader lang={lang} title={S.name} sub={S.sub} seed="settings-security" actions={<HelpLink lang={lang} href={helpHref(lang, "privacy", "two-step-and-devices")} />} />
      <SecuritySettings lang={lang} rules={t.join.rules} may={can(u, "password.change") && can(u, "sessions.revoke") && can(u, "mfa.manage") && can(u, "passkeys.manage")} owner={u.actor?.kind === "owner"} forbidden={t.team.errors.forbidden} passkeys={{ T: t.passkeys, enabled }} password={{ has: me?.hasPassword ?? true, email: me?.email ?? "" }} />
    </div>
  );
}
