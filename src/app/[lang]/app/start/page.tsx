import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import StartWizard from "@/components/app/StartWizard";

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ url?: string }> }) {
  const { lang } = await params;
  const { url } = await searchParams;
  if (!isLang(lang)) notFound();
  if (!(await currentUser())) redirect(`/${lang}/app/login`);
  return <StartWizard t={appDict[lang]} lang={lang} initialUrl={typeof url === "string" ? url.slice(0, 300) : ""} />;
}
