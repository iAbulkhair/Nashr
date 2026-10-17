import { adminScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin-gate-server";
import { adminHref } from "@/lib/admin-gate";
import { adminTestOptions, consoleState } from "@/lib/skills-admin";
import { appDict } from "@/lib/app-i18n";
import { pickSkillsDict } from "@/lib/skills-admin-dict";
import SkillsAdminPanel from "@/components/admin/SkillsAdminPanel";
import { EndedGate, EndedNotice } from "@/components/admin/shared";

export const dynamic = "force-dynamic";
export const generateMetadata = adminScreenMeta("skills");

// Founder console, section "skills" (rules 958-959): the staff sign-in page without the gate (rule 1652, src/lib/admin-gate-server.ts). The props
// are the server's own reads (`consoleState`, the same function GET /api/admin/skills answers with); nothing comes from the request.
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const gate = await requireAdmin(lang, adminHref(lang, "skills"));
  if (gate.ended) return <EndedNotice lang={lang} keySession />;
  const { keySession } = gate;
  const initial = await consoleState();
  return <EndedGate lang={lang} keySession={keySession}><SkillsAdminPanel lang={lang} keySession={keySession} initial={initial} testOptions={adminTestOptions()} dict={pickSkillsDict(appDict[lang])} /></EndedGate>;
}
