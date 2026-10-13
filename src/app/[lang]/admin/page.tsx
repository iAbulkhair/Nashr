import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { isAdminCookie } from "@/lib/auth";
import { requireAdmin } from "@/lib/admin-gate-server";
import { adminHref } from "@/lib/admin-gate";
import Overview from "@/components/admin/Overview";
import AdminLogin from "@/components/app/AdminLogin";
import { EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// Founder console: /{lang}/admin (rule 870). Opens for a staff session (rules 1630-1654), a key session, or (expand only,
// rule 1649) a founder account (ADMIN_EMAILS) signed in normally. Everyone else is sent to the staff sign-in page
// (rule 1652, which replaced the plain 404). The key form (WAITLIST_ADMIN_KEY) is only shown at
// /{lang}/admin?login=1 and its API is rate limited. A right key opens a server-side key session (src/lib/auth.ts
// `createAdminSession`, 15 minutes idle, 12 hours at most); each page load renews it, and the sidebar offers to end it.
export const generateMetadata = adminScreenMeta("overview");

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ login?: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if ((await searchParams).login === "1" && !(await isAdminCookie())) return <AdminLogin lang={lang} />;
  const gate = await requireAdmin(lang, adminHref(lang, "overview"));
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <Overview lang={lang} keySession={keySession} />;
}
