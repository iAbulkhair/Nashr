import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { adminHref } from "@/lib/admin-gate";
import PartnersPanel from "@/components/admin/PartnersPanel";
import { EndedGate, EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// Founder console, section "partners" (rule 870): the staff sign-in page without the gate (rule 1652, src/lib/admin-gate-server.ts).
export const generateMetadata = adminScreenMeta("partners");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin(lang, adminHref(lang, "partners"));
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <EndedGate lang={lang} keySession={keySession}><PartnersPanel lang={lang} /></EndedGate>;
}
