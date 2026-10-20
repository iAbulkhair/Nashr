import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { INSPO } from "@/lib/inspo";
import InspoPanel from "@/components/app/InspoPanel";
import { appHref } from "@/lib/app-href";
export const generateMetadata = appScreenMeta("inspo");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (!(await currentUser())) redirect(appHref(lang, "/login"));
  return <InspoPanel t={appDict[lang]} lang={lang} items={INSPO} />;
}
