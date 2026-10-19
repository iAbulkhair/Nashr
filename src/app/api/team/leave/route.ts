import { currentUser, destroySession } from "@/lib/auth";
import { isPersonLockTimeout } from "@/lib/person";
import { forbid } from "@/lib/roles";
import { isTeamLockTimeout, leaveTeam } from "@/lib/team";
import { busy, teamFail, unauthorized } from "../respond";

/** POST /api/team/leave → {ok}. A member leaves the account: the login is deleted and this device is signed out. The owner cannot leave. */
export async function POST() {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.leave");
  if (no) return no;
  // Leaving takes `lock:login` → `lock:person` → `lock:member` before its first write (multi-workspace M1, rule 2139):
  // a timeout on any of them is a 409 with the membership whole.
  let res: Awaited<ReturnType<typeof leaveTeam>>;
  try {
    res = await leaveTeam(u);
  } catch (e) {
    if (isPersonLockTimeout(e) || isTeamLockTimeout(e)) return busy();
    throw e;
  }
  if (!res.ok) return teamFail(res);
  await destroySession();
  return Response.json({ ok: true });
}
