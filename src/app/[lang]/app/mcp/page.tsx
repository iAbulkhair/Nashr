import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import McpPanel from "@/components/app/McpPanel";
import { DRAFTS_PER_HOUR } from "@/lib/rate";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const h = await headers();
  const origin = process.env.APP_ORIGIN ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  // Tokens and connected apps are owner credentials in v1 (/api/mcp/token and /api/mcp/grants refuse other roles).
  return <McpPanel lang={lang} origin={origin} canToken={can(u, "mcp.token")} canGrants={can(u, "oauth.grants")} draftsPerHour={DRAFTS_PER_HOUR} />;
}
