import { currentUser, destroySession } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { leaveTeam } from "@/lib/team";
import { teamFail, unauthorized } from "../respond";

/** POST /api/team/leave → {ok}. A member leaves the account: the login is deleted and this device is signed out. The owner cannot leave. */
export async function POST() {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.leave");
  if (no) return no;
  const res = await leaveTeam(u);
  if (!res.ok) return teamFail(res);
  await destroySession();
  return Response.json({ ok: true });
}
