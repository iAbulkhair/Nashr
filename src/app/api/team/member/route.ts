import { currentUser } from "@/lib/auth";
import { isPersonLockTimeout } from "@/lib/person";
import { forbid } from "@/lib/roles";
import { isTeamLockTimeout, removeMember, setAccess, setRole } from "@/lib/team";
import { busy, teamFail, unauthorized } from "../respond";

/**
 * PATCH /api/team/member {email, role?, brands?, approves?, creditCap?} → {ok}.
 * - `role` ("admin", "editor" or its stored name "member", "viewer"): the owner only; the owner role is never assignable.
 * - `brands` (the account's own active brand ids, null = every brand) and `approves` (rules 3756, 3760): the owner or an
 *   admin who is not narrowed to some brands, and an admin's own access only by the owner.
 * - `creditCap` (a whole number of credits a month, null = no cap, rule 3770): the owner only.
 * The role goes first, then the access; each is refused on its own action, and `setAccess` checks again under the lock.
 */
export async function PATCH(req: Request) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const raw = (await req.json().catch(() => ({}))) as unknown;
  const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as { email?: unknown; role?: unknown; brands?: unknown; approves?: unknown; creditCap?: unknown };
  const email = typeof b.email === "string" ? b.email : "";
  const wantsAccess = b.brands !== undefined || b.approves !== undefined;
  const wantsCap = b.creditCap !== undefined;
  if (b.role === undefined && !wantsAccess && !wantsCap) return Response.json({ error: "invalid" }, { status: 400 });
  if (b.role !== undefined) {
    const no = forbid(u, "team.role");
    if (no) return no;
  }
  if (wantsAccess) {
    const no = forbid(u, "team.access");
    if (no) return no;
  }
  if (wantsCap) {
    const no = forbid(u, "team.cap");
    if (no) return no;
  }
  try {
    if (b.role !== undefined) {
      const res = await setRole(u, u.actor!, email, typeof b.role === "string" ? b.role : "");
      if (!res.ok) return teamFail(res);
    }
    if (wantsAccess || wantsCap) {
      const res = await setAccess(u, u.actor!, email, { brands: b.brands, approves: b.approves, creditCap: b.creditCap });
      if (!res.ok) return teamFail(res);
    }
  } catch (e) {
    if (isTeamLockTimeout(e)) return busy();
    throw e;
  }
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
