import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { isAdminCookie } from "@/lib/auth";
import AdminConsole from "@/components/app/AdminConsole";
import AdminLogin from "@/components/app/AdminLogin";

export const dynamic = "force-dynamic";

// Founder console: /{lang}/app/admin — opens for founder accounts (ADMIN_EMAILS) when logged in normally; key login (WAITLIST_ADMIN_KEY) as fallback.
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (!(await isAdminCookie())) return <AdminLogin lang={lang} />;
  return <AdminConsole lang={lang} />;
}
