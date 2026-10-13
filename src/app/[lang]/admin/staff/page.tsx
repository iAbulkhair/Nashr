import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { staffScreenMeta } from "@/lib/screen-titles";
import { customerPathOff } from "@/lib/staff";
import { SW } from "@/lib/staff-words";
import { EndedNotice } from "@/components/admin/shared";
import StaffAdmin from "@/components/admin/StaffAdmin";

export const dynamic = "force-dynamic";

export const generateMetadata = staffScreenMeta("staff");

/**
 * Staff management (rules 1638-1640, 1650): a staff owner lists, adds, turns off and on, resets and changes roles, and
 * can close the customer-account way in; a break-glass key session sees the list and can issue a reset code only.
 * Everyone else with console access sees a notice. The API checks all of it again (src/app/api/admin/staff/route.ts).
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin(lang, `/${lang}/admin/staff`);
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const S = SW[lang];
  const owner = gate.staff?.role === "owner";
  if (!owner && !gate.keySession) {
    return (
      <section className="grid gap-2">
        <h1 className="font-display text-2xl font-bold">{S.staffTitle}</h1>
        <p className="text-sm text-foreground-muted">{S.ownersOnly}</p>
      </section>
    );
  }
  return <StaffAdmin lang={lang} me={gate.staff?.email ?? null} keySession={!owner} pathOff={await customerPathOff()} />;
}
