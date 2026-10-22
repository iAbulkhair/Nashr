import { NextResponse } from "next/server";
import { handler } from "@/lib/api-handler";
import { actorInfo, consoleRole, normalizeEmail, viaOf } from "@/lib/auth";
import { handlesReady } from "@/lib/ws-handle";
import { staffMay } from "@/lib/roles";
import { adminAudit } from "@/lib/admin-audit";
import { peopleView } from "@/lib/admin-people";
import { MULTI_ORG } from "@/lib/multi-org";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/people/{email} (multi-workspace M3, rules 2130 and 2755): one person, read only, for the founder console.
 * Order: a console actor (401), `MULTI_ORG` (404 while off), the `workspace.view` permission of src/lib/roles.ts for the
 * actor's console role, which fails closed (403), CONNECT_SECRET (503 `not_configured`), the person found from the chosen
 * address through `getLogin` (404, audited as "people view (not found)"), then the audit row, and only then the answer:
 * when the log cannot be written, nothing is shown. No write action.
 */
export const GET = handler<"admin", undefined, undefined, { email: string }>({ auth: "admin" }, async ({ req, params }) => {
  const who = actorInfo(req)?.who;
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  if (!MULTI_ORG) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!staffMay(consoleRole(req), "workspace.view")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  // Handles are derived from CONNECT_SECRET: without it the view answers a clean 503 and reads nothing (M3 fix round).
  if (!handlesReady()) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  let chosen: string | null;
  try {
    chosen = decodeURIComponent(params.email ?? "");
  } catch {
    chosen = null;
  }
  const view = chosen === null ? null : await peopleView(chosen);
  if (!view) {
    // A lookup that finds nobody is audited too (review B finding 6): probing which addresses exist leaves a trail.
    const target = chosen === null ? "(undecodable)" : normalizeEmail(chosen).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 254);
    await adminAudit({ actor: who, via: viaOf(req), section: "users", target, what: "people view (not found)", action: "workspace.view" });
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  await adminAudit({ actor: who, via: viaOf(req), section: "users", target: view.person.email, what: "people view", action: "workspace.view" });
  return NextResponse.json({ ok: true, ...view }, { headers: { "Cache-Control": "no-store" } });
});
