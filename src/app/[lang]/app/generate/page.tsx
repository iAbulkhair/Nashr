import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import GeneratePanel from "@/components/app/GeneratePanel";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!(await getBrand(u.email))) redirect(`/${lang}/app/onboarding`);
  return <GeneratePanel t={appDict[lang]} lang={lang} credits={u.credits} />;
}
