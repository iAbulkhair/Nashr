import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import Usage from "@/components/admin/Usage";
import { EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// Founder console, section "usage" (rule 870): a plain 404 without the gate (src/lib/admin-gate-server.ts).
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin();
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <Usage lang={lang} keySession={keySession} />;
}
