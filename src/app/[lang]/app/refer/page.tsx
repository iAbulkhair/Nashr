import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { referralStats, registerCode } from "@/lib/referral";
import ReferPanel from "@/components/app/ReferPanel";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  await registerCode(u.email);
  const s = await referralStats(u.email);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "nashr-tau.vercel.app"}`;
  return <ReferPanel t={appDict[lang]} lang={lang} code={s.code} count={s.count} earned={s.earned} origin={origin} />;
}
