import { NextResponse } from "next/server";
import { handler } from "@/lib/api-handler";
import { actorInfo, consoleRole, viaOf } from "@/lib/auth";
import { staffMay } from "@/lib/roles";
import { adminAudit } from "@/lib/admin-audit";
import { workspaceList } from "@/lib/admin-workspaces";
import { parseWsQuery } from "@/lib/admin-workspaces-math";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/workspaces (rules 3720-3724): the founder console's customers list, one row per workspace (account), filtered,
 * sorted and paged on the server (`parseWsQuery`: q, plan, filter, sort, dir, page, per; `refresh=1` rebuilds the cached numbers).
 * Order: a console actor (401), the `workspace.view` permission of src/lib/roles.ts for the actor's console role, which fails
 * closed (403), then the answer. A search that is a member's address reveals which workspaces that person belongs to, so it
 * writes the audit row (`workspace.search`) BEFORE answering: when the log cannot be written, nothing is shown. Read only: no
 * write method exists on this route.
 */
export const GET = handler<"admin", undefined, undefined>({ auth: "admin" }, async ({ req }) => {
  const who = actorInfo(req)?.who;
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  if (!staffMay(consoleRole(req), "workspace.view")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const params = new URL(req.url).searchParams;
  const list = await workspaceList(parseWsQuery(params), { refresh: params.get("refresh") === "1" });
  if (list.person) await adminAudit({ actor: who, via: viaOf(req), section: "users", target: list.person.email, what: "workspace search", action: "workspace.search", extra: { found: list.matched } });
  return NextResponse.json({ ok: true, ...list }, { headers: { "Cache-Control": "no-store" } });
});
