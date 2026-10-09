import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { isAdminCookie } from "@/lib/auth";
import { requireAdmin } from "@/lib/admin-gate-server";
import Overview from "@/components/admin/Overview";
import AdminLogin from "@/components/app/AdminLogin";

export const dynamic = "force-dynamic";

// Founder console: /{lang}/admin (rule 870). Opens for founder accounts (ADMIN_EMAILS) signed in normally. Everyone else
// gets a plain 404, so the console does not advertise itself. The key form (WAITLIST_ADMIN_KEY) is only shown at
// /{lang}/admin?login=1 and its API is rate limited. A right key opens a server-side key session (src/lib/auth.ts
// `createAdminSession`, 15 minutes idle, 12 hours at most); each page load renews it, and the sidebar offers to end it.
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ login?: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (!(await isAdminCookie())) {
    if ((await searchParams).login !== "1") notFound();
    return <AdminLogin lang={lang} />;
  }
  const { keySession } = await requireAdmin();
  return <Overview lang={lang} keySession={keySession} />;
}
