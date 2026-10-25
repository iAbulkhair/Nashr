import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { staffScreenMeta } from "@/lib/screen-titles";
import { peekSetupCode } from "@/lib/staff";
import { readStaffSetupCookie } from "@/lib/staff-session";
import StaffSignIn from "@/components/admin/StaffSignIn";

export const dynamic = "force-dynamic";

export const generateMetadata = staffScreenMeta("setup");

/**
 * Redeem a setup, reset or invite code (rules 1639, 1640, 3701, 3706): email, the code and a new password, then the
 * enrolment. Public. The code never comes from a URL query, so this page takes no search parameters at all: it is typed,
 * read by the form from an invite link's fragment (`#invite=`, never sent to the server), or held in the setup hand-off
 * cookie after the founder's bootstrap. With a live hand-off the form shows the address and asks only for a password.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const code = await readStaffSetupCookie();
  const rec = code ? await peekSetupCode(code) : null;
  return <StaffSignIn lang={lang} mode="setup" handoffEmail={rec?.kind === "setup" ? rec.email : undefined} />;
}
