import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { adminHref } from "@/lib/admin-gate";
import Users from "@/components/admin/Users";
import { EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// The account table (rule 1178), where every founder action on an account lives: plan, seats, deal, allowance, suspension.
// Until rule 3720 it was the users section's page; the customers list (one row per workspace) took that place and links here.
export const generateMetadata = adminScreenMeta("users");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin(lang, `${adminHref(lang, "users")}/accounts`);
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <Users lang={lang} keySession={keySession} />;
}
