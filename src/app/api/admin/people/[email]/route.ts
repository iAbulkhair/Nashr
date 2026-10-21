import { NextResponse } from "next/server";
import { handler } from "@/lib/api-handler";
import { actorInfo, consoleRole, viaOf } from "@/lib/auth";
import { staffMay } from "@/lib/roles";
import { adminAudit } from "@/lib/admin-audit";
import { peopleView } from "@/lib/admin-people";
import { MULTI_ORG } from "@/lib/multi-org";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/people/{email} (multi-workspace M3, rules 2130 and 2755): one person, read only, for the founder console.
 * Order: a console actor (401), `MULTI_ORG` (404 while off), the `workspace.view` permission of src/lib/roles.ts for the
 * actor's console role, which fails closed (403), the person found from the chosen address through `getLogin` (404),
 * then the audit row, and only then the answer: when the log cannot be written, nothing is shown. No write action.
 */
export const GET = handler<"admin", undefined, undefined, { email: string }>({ auth: "admin" }, async ({ req, params }) => {
  const who = actorInfo(req)?.who;
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  if (!MULTI_ORG) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!staffMay(consoleRole(req), "workspace.view")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  let chosen: string;
  try {
    chosen = decodeURIComponent(params.email ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const view = await peopleView(chosen);
  if (!view) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  await adminAudit({ actor: who, via: viaOf(req), section: "users", target: view.person.email, what: "people view", action: "workspace.view" });
  return NextResponse.json({ ok: true, ...view }, { headers: { "Cache-Control": "no-store" } });
});
