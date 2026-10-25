import { NextResponse } from "next/server";
import { handler } from "@/lib/api-handler";
import { actorInfo, consoleRole, viaOf } from "@/lib/auth";
import { staffMay } from "@/lib/roles";
import { adminAudit } from "@/lib/admin-audit";
import { workspaceView } from "@/lib/admin-workspace";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/users/{email}/workspace (rules 2077-2083): one customer workspace, read-only, for the founder console.
 * Order: a console actor (401), the `workspace.view` permission of src/lib/roles.ts for the actor's console role, which
 * fails closed (403), the account found from the chosen address (404), then the audit row, and only then the answer:
 * when the log cannot be written, nothing is shown. No write action exists here: the console owner's changes go through
 * POST /api/admin/users/{email}/workspace/edit (rules 3550-3569), a separate route with its own gates.
 */
export const GET = handler<"admin", undefined, undefined, { email: string }>({ auth: "admin" }, async ({ req, params }) => {
  const who = actorInfo(req)?.who;
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  if (!staffMay(consoleRole(req), "workspace.view")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  let chosen: string;
  try {
    chosen = decodeURIComponent(params.email ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const view = await workspaceView(chosen);
  if (!view) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  await adminAudit({
    actor: who, via: viaOf(req), section: "users", target: view.owner.email, what: "workspace view", action: "workspace.view",
    ...(view.openedFrom ? { extra: { openedFrom: view.openedFrom } } : {}),
  });
  // `may` (rule 3558): whether this caller may change the workspace (POST .../workspace/edit runs the same check again),
  // so a support staff member sees no edit buttons instead of learning it after typing a reason.
  return NextResponse.json({ ok: true, ...view, may: staffMay(consoleRole(req), "workspace.edit") }, { headers: { "Cache-Control": "no-store" } });
});
