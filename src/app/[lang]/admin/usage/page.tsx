import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { adminHref } from "@/lib/admin-gate";
import Usage from "@/components/admin/Usage";
import { EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// Founder console, section "usage" (rule 870): the staff sign-in page without the gate (rule 1652, src/lib/admin-gate-server.ts).
export const generateMetadata = adminScreenMeta("usage");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin(lang, adminHref(lang, "usage"));
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <Usage lang={lang} keySession={keySession} />;
}
