import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { staffScreenMeta } from "@/lib/screen-titles";
import StaffSignIn from "@/components/admin/StaffSignIn";

export const dynamic = "force-dynamic";

export const generateMetadata = staffScreenMeta("setup");

/**
 * Redeem a setup or reset code (rules 1639, 1640): email, the code and a new password, then the enrolment. Public. The
 * code is typed into the form and never read from the URL, so this page takes no search parameters at all.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return <StaffSignIn lang={lang} mode="setup" />;
}
