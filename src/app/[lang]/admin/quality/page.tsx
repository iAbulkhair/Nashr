import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import Quality from "@/components/admin/Quality";

export const dynamic = "force-dynamic";

// Founder console, section "quality" (rule 870): a plain 404 without the gate (src/lib/admin-gate-server.ts).
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const { keySession } = await requireAdmin();
  return <Quality lang={lang} keySession={keySession} />;
}
