import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { can } from "@/lib/roles";
import BrandForm from "@/components/app/BrandForm";
import { helpHref } from "@/lib/help";
import BrandExtras from "@/components/app/settings/BrandExtras";
import { appHref } from "@/lib/app-href";

export const generateMetadata = settingsScreenMeta("brand");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  // Owner and admins edit the brand file; members read it (PUT /api/brand checks the same `can()`). The default model's
  // one-time consent to China-hosted models is the owner's own, never a founder's (PUT /api/models checks the same).
  const brand = await getBrand(sc(u));
  const readOnly = !can(u, "brand.write");
  const t = appDict[lang];
  // The brand-file fields the old profile page edited (rule 1152): social handles, value proposition and sitemap.
  return (
    <div className="grid gap-6">
      <BrandForm t={t} lang={lang} help={helpHref(lang, "start", "dialect-and-tone")} initial={brand} readOnly={readOnly} canConfirmChina={can(u, "profile.account") && u.actor?.kind !== "founder"} />
      {brand && <BrandExtras lang={lang} readOnly={readOnly} forbidden={t.team.errors.forbidden} initial={{ social: brand.social ?? {}, valueProp: brand.valueProp ?? "", sitemap: brand.sitemap ?? "" }} />}
    </div>
  );
}
