import { currentUser } from "@/lib/auth";
import { isPersonLockTimeout } from "@/lib/person";
import { forbid } from "@/lib/roles";
import { isTeamLockTimeout, removeMember, setRole } from "@/lib/team";
import { busy, teamFail, unauthorized } from "../respond";

/** PATCH /api/team/member {email, role:"admin"|"member"} → {ok}. Owner only; the owner role itself is never assignable. */
export async function PATCH(req: Request) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.role");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; role?: unknown };
  const res = await setRole(u, u.actor!, typeof b.email === "string" ? b.email : "", typeof b.role === "string" ? b.role : "");
  if (!res.ok) return teamFail(res);
  return Response.json({ ok: true });
}

/**
 * DELETE /api/team/member {email} → {ok}. The owner removes anyone, an admin plain members only. The login, its active
 * brand, its roster entry and the invites it sent are deleted; its sessions stop at their next request because
 * membership is re-resolved on every one.
 */
export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.remove.member");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { email?: unknown };
  // The removal takes `lock:login` → `lock:person` → `lock:member` before its first write (multi-workspace M1, rule 2139):
  // a timeout on any of them is a 409 with the membership whole.
  let res: Awaited<ReturnType<typeof removeMember>>;
  try {
    res = await removeMember(u, u.actor!, typeof b.email === "string" ? b.email : "");
  } catch (e) {
    if (isPersonLockTimeout(e) || isTeamLockTimeout(e)) return busy();
    throw e;
  }
  if (!res.ok) return teamFail(res);
  return Response.json({ ok: true });
}
