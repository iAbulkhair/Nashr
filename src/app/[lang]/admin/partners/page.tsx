import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import AdminConsole from "@/components/app/AdminConsole";

export const dynamic = "force-dynamic";

// Founder console, section "partners" (rule 870): a plain 404 without the gate (src/lib/admin-gate-server.ts).
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const { keySession } = await requireAdmin();
  return <AdminConsole lang={lang} keySession={keySession} section="partners" />;
}
