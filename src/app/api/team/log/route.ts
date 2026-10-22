import { currentUser } from "@/lib/auth";
import { aidOf } from "@/lib/membership";
import { MULTI_ORG } from "@/lib/multi-org";
import { forbid } from "@/lib/roles";
import { teamLogView } from "@/lib/teamlog";
import { unauthorized } from "../respond";

export const dynamic = "force-dynamic";

/**
 * GET /api/team/log (multi-workspace M3, spec section 13; rule 2129 read half) → `{ok, rows}`: the signed-in account's
 * team log, newest first, for its owner and admins (`team.log.view`). Each row names people by address only: never a
 * person id, a token or an invite id. The account is the session's own (`aidOf(u)`), never one from the request. With
 * `MULTI_ORG` off, 404.
 */
export async function GET() {
  if (!MULTI_ORG) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.log.view");
  if (no) return no;
  const rows = await teamLogView(aidOf(u));
  return Response.json({ ok: true, rows }, { headers: { "Cache-Control": "no-store" } });
}
