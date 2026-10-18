import { NextResponse } from "next/server";
import { adminActor } from "@/lib/auth";
import { integrationsView } from "@/lib/integration-status";
import { complianceSummary } from "@/lib/connectors/shopify-compliance";
import { connectionHealth } from "@/lib/connectors/health";
import { getProvider } from "@/lib/connectors/registry";

export const dynamic = "force-dynamic";

/**
 * Founder console, Integrations (rules 1540-1549): every outside service and whether it is set up, decided only by the
 * presence of its environment variable NAMES, plus the code switches that keep it off (src/lib/integration-status.ts). A read:
 * `adminActor` first (401), no second factor (reads never need one, src/lib/admin-2fa.ts), nothing written, no audit row.
 * The answer carries names and booleans only, never a value, a length or a prefix; `no-store` so no cache keeps it.
 * Beside them, Shopify's compliance receipts (rule 2173): topic, store and time from the two fixed keys, never a
 * customer field (none is kept); null when the store cannot be read, so the list still loads.
 * And the stores cron's last connection count per platform (rules 2177-2178): numbers and the registry's platform name
 * only, busiest first, and that run's token keep-alive and Shopify `app/uninstalled` subscription counts (rules 2202, 2205, null when none is recorded); null before the
 * first run or when the read fails.
 */
export async function GET(req: Request) {
  if (!(await adminActor(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const [shopifyCompliance, health] = await Promise.all([complianceSummary().catch(() => null), connectionHealth().catch(() => null)]);
  const connections = health && {
    at: health.at,
    workspaces: health.workspaces,
    keepAlive: health.keepAlive ?? null,
    uninstallHooks: health.uninstallHooks ?? null,
    rows: Object.entries(health.providers)
      .map(([id, h]) => ({ id, name: getProvider(id)?.name ?? id, ...h }))
      .sort((a, b) => b.connected - a.connected || a.id.localeCompare(b.id)),
  };
  return NextResponse.json({ ok: true, items: integrationsView(), shopifyCompliance, connections }, { headers: { "cache-control": "no-store" } });
}
