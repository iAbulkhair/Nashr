import { NextResponse } from "next/server";
import { adminActor } from "@/lib/auth";
import { integrationsView } from "@/lib/integration-status";

export const dynamic = "force-dynamic";

/**
 * Founder console, Integrations (rules 1540-1549): every outside service and whether it is set up, decided only by the
 * presence of its environment variable NAMES, plus the code switches that keep it off (src/lib/integration-status.ts). A read:
 * `adminActor` first (401), no second factor (reads never need one, src/lib/admin-2fa.ts), nothing written, no audit row.
 * The answer carries names and booleans only, never a value, a length or a prefix; `no-store` so no cache keeps it.
 */
export async function GET(req: Request) {
  if (!(await adminActor(req))) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, items: integrationsView() }, { headers: { "cache-control": "no-store" } });
}
