import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import BrandsPanel from "@/components/app/BrandsPanel";
export const dynamic = "force-dynamic";
export const generateMetadata = settingsScreenMeta("brands");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // Everyone switches their own active brand; adding, renaming and archiving are owner/admin (POST /api/brands checks it).
  return <BrandsPanel lang={lang} manage={can(u, "brands.manage")} readOnlyNote={appDict[lang].readOnly.admin} />;
}
