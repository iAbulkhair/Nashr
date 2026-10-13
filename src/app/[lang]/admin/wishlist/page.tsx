import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { adminHref } from "@/lib/admin-gate";
import WishlistPanel from "@/components/admin/WishlistPanel";
import { EndedGate, EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// Founder console, section "wishlist" (rule 870): the staff sign-in page without the gate (rule 1652, src/lib/admin-gate-server.ts).
export const generateMetadata = adminScreenMeta("wishlist");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin(lang, adminHref(lang, "wishlist"));
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <EndedGate lang={lang} keySession={keySession}><WishlistPanel lang={lang} /></EndedGate>;
}
