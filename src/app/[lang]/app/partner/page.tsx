import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { partnerDashboard } from "@/lib/partners";
import { appOrigin } from "@/lib/origin";
import PartnerPanel from "@/components/app/PartnerPanel";
import { PARTNER_COPY } from "@/lib/partner-copy";
import ReadOnlyNote from "@/components/app/ReadOnlyNote";

export const dynamic = "force-dynamic";

/**
 * The partner's own page (rule 399): code, link, share text, referrals without any customer name or email, the
 * commission ledger, payouts and the bank details form. The account owner only (`partner`): a member of a partner's team
 * sees a note and nothing is read. An account that is not a partner is pointed at the public application page.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const S = PARTNER_COPY[lang];
  if (!can(u, "partner")) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="page-title">{S.title}</h1>
        <ReadOnlyNote className="mt-4" text={S.ownerOnly} />
      </div>
    );
  }
  const d = await partnerDashboard(u.email);
  if (!d) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="page-title">{S.title}</h1>
        <p className="mt-3 text-ink/70">{S.notPartner}</p>
        <Link href={`/${lang}/affiliates`} className="btn btn-primary mt-4 inline-block">{S.apply}</Link>
      </div>
    );
  }
  // The canonical origin, never the request's Host header: a link copied on a preview deployment must still point at
  // production (src/lib/origin.ts).
  return <PartnerPanel lang={lang} link={`${appOrigin()}/p/${d.code}`} data={d} bankEditable={can(u, "partner.bank")} />;
}
