import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { isAdminCookie } from "@/lib/auth";
import AdminConsole from "@/components/app/AdminConsole";
import AdminLogin from "@/components/app/AdminLogin";

export const dynamic = "force-dynamic";

// Founder console: /{lang}/app/admin — log in once with WAITLIST_ADMIN_KEY (30-day cookie).
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (!(await isAdminCookie())) return <AdminLogin />;
  return <AdminConsole />;
}
