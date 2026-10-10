import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { can } from "@/lib/roles";
import BrandForm from "@/components/app/BrandForm";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // Owner and admins edit the brand file; members read it (PUT /api/brand checks the same `can()`). The default model's
  // one-time consent to China-hosted models is the owner's own, never a founder's (PUT /api/models checks the same).
  return <BrandForm t={appDict[lang]} lang={lang} initial={await getBrand(sc(u))} readOnly={!can(u, "brand.write")} canConfirmChina={can(u, "profile.account") && u.actor?.kind !== "founder"} />;
}
