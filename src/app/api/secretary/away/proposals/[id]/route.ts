import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, retryLater } from "@/lib/rate";
import { SEC_WRITES_PER_HOUR } from "@/lib/secretary";
import { AWAY_PROPOSAL_ID, decideAwayProposal } from "@/lib/secretary-away";

/**
 * A person's answer to an absence Reem proposed in chat (`contact_away`, src/lib/secretary-away.ts): `{ action: "save" }`
 * puts it on the away list through the same checks as `PUT` / `DELETE /api/secretary/away`, `{ action: "dismiss" }`
 * drops it; once (409 `already_decided` after that, 409 `busy` while another Save of it runs). The same role and rate as those routes (`todo.write`, any member;
 * `sec:write`). The id is format-checked (404 otherwise) and the proposal is read only from the caller's active brand
 * (`sc(u)`), so another brand's or account's id is 404. Who saved is the session's login, never the body's.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "todo.write");
  if (no) return no;
  if (!(await allow(`sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600))) return retryLater({ ok: false, error: "too_many" }, 3600);
  const { id } = await ctx.params;
  if (!AWAY_PROPOSAL_ID.test(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b: unknown = await req.json().catch(() => null);
  const action = b && typeof b === "object" && !Array.isArray(b) ? (b as { action?: unknown }).action : undefined;
  if (action !== "save" && action !== "dismiss") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  const r = await decideAwayProposal(sc(u), id, action, { actor: "owner", via: "web", login: u.actor?.email }, Date.now());
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, ...(r.field ? { field: r.field } : {}) }, { status: r.status });
  return NextResponse.json(r);
}
