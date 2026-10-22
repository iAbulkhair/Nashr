import { NextResponse } from "next/server";
import { currentPerson } from "@/lib/auth";
import { MULTI_ORG } from "@/lib/multi-org";
import { invitesWaiting } from "@/lib/team";

export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces/invites (multi-workspace M3, spec section 9; rule 2753): the invitations waiting for the signed-in
 * person's own verified address, `{ok, invites: [{workspace, inviter, role, expiresAt}]}`. Never an invite id, a token or
 * an account id: accepting stays on the mailed link. Behind `currentPerson()` (an impersonation has no person: 401). With
 * `MULTI_ORG` off, 404.
 */
export async function GET() {
  if (!MULTI_ORG) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const me = await currentPerson();
  if (!me) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const invites = await invitesWaiting(me.person);
  return NextResponse.json({ ok: true, invites }, { headers: { "Cache-Control": "no-store" } });
}
