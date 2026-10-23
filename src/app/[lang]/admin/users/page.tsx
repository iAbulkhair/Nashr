import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { adminHref } from "@/lib/admin-gate";
import Customers from "@/components/admin/Customers";
import { EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// Founder console, section "users" (rule 870): the staff sign-in page without the gate (rule 1652, src/lib/admin-gate-server.ts).
// Since rule 3720 the default view is the customers list, one row per workspace; the account table (every founder action on
// an account) is at /users/accounts.
export const generateMetadata = adminScreenMeta("users");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin(lang, adminHref(lang, "users"));
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <Customers lang={lang} keySession={keySession} />;
}
