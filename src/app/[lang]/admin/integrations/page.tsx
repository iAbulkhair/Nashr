import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import IntegrationsPanel from "@/components/admin/IntegrationsPanel";
import { EndedGate, EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// Founder console, section "integrations" (rule 1540): a plain 404 without the gate (src/lib/admin-gate-server.ts).
export const generateMetadata = adminScreenMeta("integrations");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin();
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <EndedGate lang={lang} keySession={keySession}><IntegrationsPanel lang={lang} /></EndedGate>;
}
