import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { INTEGRATIONS } from "@/lib/integrations";
import IntegrationsPanel from "@/components/app/IntegrationsPanel";
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (!(await currentUser())) redirect(`/${lang}/app/login`);
  return <IntegrationsPanel t={appDict[lang]} items={INTEGRATIONS} />;
}
