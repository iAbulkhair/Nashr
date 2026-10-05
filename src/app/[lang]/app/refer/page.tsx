import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { referralStats, registerCode } from "@/lib/referral";
import ReferPanel from "@/components/app/ReferPanel";
import ReadOnlyNote from "@/components/app/ReadOnlyNote";
import { appOrigin } from "@/lib/origin";
import Scribble from "@/components/Scribble";
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
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="refer-t1" />{t.refer.title}</span></h1>
        <ReadOnlyNote className="mt-4" text={t.refer.ownerOnly} />
      </div>
    );
  }
  await registerCode(u.email);
  const s = await referralStats(u.email);
  // The canonical origin, not the request's Host header: a link shared from a preview deployment or an alias must still
  // point at the production domain, and a Host header is whatever the client sent.
  const origin = appOrigin();
  return <ReferPanel t={appDict[lang]} lang={lang} code={s.code} count={s.count} earned={s.earned} origin={origin} />;
}
