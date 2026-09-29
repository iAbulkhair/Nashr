import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { INTEGRATIONS } from "@/lib/integrations";
import { Suspense } from "react";
import IntegrationsPanel from "@/components/app/IntegrationsPanel";
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // Connecting, disconnecting, keys, page and ad-account choice and product import are owner/admin (the /api/connect
  // routes check the same `can()`); asking for an integration is open to every role.
  return <Suspense><IntegrationsPanel t={appDict[lang]} lang={lang} items={INTEGRATIONS} manage={can(u, "connectors")} /></Suspense>;
}
