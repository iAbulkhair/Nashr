import { currentUser, saveUser } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { withUserLock } from "@/lib/credits";
import { forbid } from "@/lib/roles";
import { teamView } from "@/lib/team";
import { busy, unauthorized } from "./respond";

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

/**
 * PATCH /api/team {approvalRequired: boolean} → {ok, approvalRequired}: the owner's approval policy (rule 3762). On, and
 * nothing is published (`publishOnce`) until someone who may approve that brand approved it. Owner only (`team.policy`),
 * written under the account lock on the account as stored now.
 */
export async function PATCH(req: Request) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.policy");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { approvalRequired?: unknown } | null;
  if (!b || typeof b !== "object" || typeof b.approvalRequired !== "boolean") return Response.json({ error: "invalid" }, { status: 400 });
  const on = b.approvalRequired;
  try {
    await withUserLock(acct(u), async (fresh) => {
      if (on) fresh.approvalRequired = true;
      else delete fresh.approvalRequired;
      await saveUser(fresh);
    });
  } catch (e) {
    if (e instanceof Error && e.message === "user_lock_timeout") return busy();
    throw e;
  }
  return Response.json({ ok: true, approvalRequired: on });
}
