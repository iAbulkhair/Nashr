import { NextResponse } from "next/server";
import { handler } from "@/lib/api-handler";
import { actorInfo, consoleRole, viaOf } from "@/lib/auth";
import { staffMay } from "@/lib/roles";
import { adminAudit } from "@/lib/admin-audit";
import { workspaceDetail } from "@/lib/admin-workspaces";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/workspaces/{email} (rules 3725-3729): one customer workspace for the founder console, read only: the overview
 * and its 30 days, the team with each member's numbers, the brands, the billing summary and the account's activity log. Same
 * order as src/app/api/admin/users/[email]/workspace/route.ts: a console actor (401), `workspace.view` for the actor's console
 * role, fail closed (403), the account found from the chosen address (404), then the audit row, and only then the answer: when
 * the log cannot be written, nothing is shown. The address is a selector only (an owner's, or a member's, which opens that
 * member's workspace); every key is built from the stored account. No write method exists here.
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
  const detail = await workspaceDetail(chosen);
  if (!detail) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  await adminAudit({
    actor: who, via: viaOf(req), section: "users", target: detail.view.owner.email, what: "workspace view", action: "workspace.view",
    extra: { page: true, ...(detail.view.openedFrom ? { openedFrom: detail.view.openedFrom } : {}) },
  });
  return NextResponse.json({ ok: true, ...detail }, { headers: { "Cache-Control": "no-store" } });
});
