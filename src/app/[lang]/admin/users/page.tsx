import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import Users from "@/components/admin/Users";
import { EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// Founder console, section "users" (rule 870): a plain 404 without the gate (src/lib/admin-gate-server.ts).
export const generateMetadata = adminScreenMeta("users");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin();
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <Users lang={lang} keySession={keySession} />;
}
