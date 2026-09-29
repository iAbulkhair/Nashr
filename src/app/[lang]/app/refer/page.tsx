import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { referralStats, registerCode } from "@/lib/referral";
import ReferPanel from "@/components/app/ReferPanel";
import ReadOnlyNote from "@/components/app/ReadOnlyNote";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // The referral code, the people it brought in and the credits earned are the owner's (GET /api/referral refuses other
  // roles). Nothing is read for anyone else, so no owner data reaches their page.
  if (!can(u, "referral")) {
    const t = appDict[lang];
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="page-title">{t.refer.title}</h1>
        <ReadOnlyNote className="mt-4" text={t.refer.ownerOnly} />
      </div>
    );
  }
  await registerCode(u.email);
  const s = await referralStats(u.email);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "nashr-tau.vercel.app"}`;
  return <ReferPanel t={appDict[lang]} lang={lang} code={s.code} count={s.count} earned={s.earned} origin={origin} />;
}
