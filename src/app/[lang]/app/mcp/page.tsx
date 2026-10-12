import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import McpPanel from "@/components/app/McpPanel";
import { DRAFTS_PER_HOUR } from "@/lib/rate";
import { appOrigin } from "@/lib/origin";
export const dynamic = "force-dynamic";
export const generateMetadata = appScreenMeta("mcp");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // The canonical origin, never the request's Host header: the URL pasted into Claude must equal the resource the OAuth
  // metadata names (`resourceMetadata().resource` in src/lib/oauth.ts), or clients that check it refuse to connect.
  const origin = appOrigin();
  // Tokens and connected apps are owner credentials in v1 (/api/mcp/token and /api/mcp/grants refuse other roles).
  return <McpPanel lang={lang} origin={origin} canToken={can(u, "mcp.token")} canGrants={can(u, "oauth.grants")} draftsPerHour={DRAFTS_PER_HOUR} />;
}
