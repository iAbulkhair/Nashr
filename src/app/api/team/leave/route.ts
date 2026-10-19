import { currentUser, destroySession } from "@/lib/auth";
import { isPersonLockTimeout } from "@/lib/person";
import { forbid } from "@/lib/roles";
import { leaveTeam } from "@/lib/team";
import { busy, teamFail, unauthorized } from "../respond";

/** POST /api/team/leave → {ok}. A member leaves the account: the login is deleted and this device is signed out. The owner cannot leave. */
export async function POST() {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.leave");
  if (no) return no;
  // A person left with nothing is deleted under `lock:person:{pid}` (multi-workspace M1): a timeout there is a 409.
  let res: Awaited<ReturnType<typeof leaveTeam>>;
  try {
    res = await leaveTeam(u);
  } catch (e) {
    if (isPersonLockTimeout(e)) return busy();
    throw e;
  }
  if (!res.ok) return teamFail(res);
  await destroySession();
  return Response.json({ ok: true });
}
