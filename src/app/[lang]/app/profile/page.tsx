import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { appDict } from "@/lib/app-i18n";
import ProfilePanel from "@/components/app/ProfilePanel";
export const dynamic = "force-dynamic";
export const generateMetadata = appScreenMeta("profile");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (!(await currentUser())) redirect(`/${lang}/app/login`);
  return <ProfilePanel t={appDict[lang]} lang={lang} />;
}
