import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { adminHref } from "@/lib/admin-gate";
import WorkspacePage from "@/components/admin/WorkspacePage";
import { EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";

// One customer workspace (rules 3725-3729). The address in the path is only a selector: the page asks GET
// /api/admin/workspaces/{email}, which finds the account from the stored record and writes the audit row first.
export const generateMetadata = adminScreenMeta("users");

export default async function Page({ params }: { params: Promise<{ lang: string; email: string }> }) {
  const { lang, email } = await params;
  if (!isLang(lang)) notFound();
  let chosen: string;
  try { chosen = decodeURIComponent(email); } catch { notFound(); }
  const gate = await requireAdmin(lang, `${adminHref(lang, "users")}/${encodeURIComponent(chosen)}`);
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  return <WorkspacePage lang={lang} keySession={keySession} email={chosen.slice(0, 254)} />;
}
