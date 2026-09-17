import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { history } from "@/lib/chat";
import ChatPanel from "@/components/app/ChatPanel";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!(await getBrand(sc(u)))) redirect(`/${lang}/app/start`);
  return <ChatPanel t={appDict[lang]} initial={await history(sc(u))} credits={u.credits} lang={lang} />;
}
