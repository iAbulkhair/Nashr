import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { staffScreenMeta } from "@/lib/screen-titles";
import { getStaff } from "@/lib/staff";
import { SW } from "@/lib/staff-words";
import { EndedNotice } from "@/components/admin/shared";
import StaffAccount from "@/components/admin/StaffAccount";

export const dynamic = "force-dynamic";

export const generateMetadata = staffScreenMeta("account");

/** The signed-in staff member's own account (rules 1632, 1634): password, recovery codes, sign out. Staff only. */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin(lang, `/${lang}/admin/account`);
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const S = SW[lang];
  if (!gate.staff) {
    return (
      <section className="grid gap-2">
        <h1 className="font-display text-2xl font-bold">{S.accountTitle}</h1>
        <p className="text-sm text-foreground-muted">{S.staffOnly} <a className="underline" href={`/${lang}/admin/login`}>{S.toSignIn}</a></p>
      </section>
    );
  }
  const me = await getStaff(gate.staff.email);
  const left = Array.isArray(me?.rc) ? me.rc.length : 0;
  return <StaffAccount lang={lang} email={gate.staff.email} name={gate.staff.name} recoveryLeft={left} />;
}
