import { currentUser } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { teamView } from "@/lib/team";
import { unauthorized } from "./respond";

/**
 * GET /api/team → {you, seats:{used,limit}, members, invites}: the roster of the signed-in account, owner first. Every
 * role sees the roster and the seat count; pending invites only reach admins and the owner. Never a hash or a token.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.view");
  if (no) return no;
  const view = await teamView(u);
  if (!view) return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json(view);
}
