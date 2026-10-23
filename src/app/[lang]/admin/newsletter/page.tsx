import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { adminHref } from "@/lib/admin-gate";
import NewsletterPanel from "@/components/admin/NewsletterPanel";
import { EndedGate, EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// Founder console, section "newsletter" (rules 870, 3600-3609): the staff sign-in page without the gate (rule 1652, src/lib/admin-gate-server.ts).
export const generateMetadata = adminScreenMeta("newsletter");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin(lang, adminHref(lang, "newsletter"));
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <EndedGate lang={lang} keySession={keySession}><NewsletterPanel lang={lang} /></EndedGate>;
}
