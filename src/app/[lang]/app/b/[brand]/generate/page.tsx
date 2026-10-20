import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import GeneratePanel from "@/components/app/GeneratePanel";
import { can } from "@/lib/roles";
import { topupsSold } from "@/lib/pricing";
import { appHref } from "@/lib/app-href";

export const generateMetadata = appScreenMeta("generate");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  if (!(await getBrand(sc(u)))) redirect(appHref(lang, "/start", { brand: u.brandId }));
  return <GeneratePanel t={appDict[lang]} lang={lang} credits={u.credits} owner={can(u, "billing")} topups={topupsSold(u.plan)} />;
}
