import { NextResponse } from "next/server";
import { adminActor } from "@/lib/auth";
import { integrationsView } from "@/lib/integration-status";
import { complianceSummary } from "@/lib/connectors/shopify-compliance";

export const dynamic = "force-dynamic";

/**
 * Founder console, Integrations (rules 1540-1549): every outside service and whether it is set up, decided only by the
 * presence of its environment variable NAMES, plus the code switches that keep it off (src/lib/integration-status.ts). A read:
 * `adminActor` first (401), no second factor (reads never need one, src/lib/admin-2fa.ts), nothing written, no audit row.
 * The answer carries names and booleans only, never a value, a length or a prefix; `no-store` so no cache keeps it.
 * Beside them, Shopify's compliance receipts (rule 2173): topic, store and time from the two fixed keys, never a
 * customer field (none is kept); null when the store cannot be read, so the list still loads.
 */
export async function GET(req: Request) {
  if (!(await adminActor(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const shopifyCompliance = await complianceSummary().catch(() => null);
  return NextResponse.json({ ok: true, items: integrationsView(), shopifyCompliance }, { headers: { "cache-control": "no-store" } });
}
