import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, HANDOFF_READS_PER_HOUR } from "@/lib/rate";
import { getHandoff, handoffView, isHandoffId } from "@/lib/handoffs";

/**
 * GET — one of Majed's handoffs as the chat card shows it: each item's agent, type, brief, cost and status, and the
 * inbox items a run made. Read only from the caller's own scope (`sc(u)`): the id is checked against its format before
 * any key is built, and another account's id is 404 like one that never existed. Every login of the account may read it
 * (`read`), as every login may read the chat it sits in.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  const no = forbid(u, "read");
  if (no) return no;
  if (!(await allow(`handoffread:${u.email}`, HANDOFF_READS_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const { id } = await ctx.params;
  if (!isHandoffId(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const scope = sc(u);
  const h = await getHandoff(scope, id);
  if (!h) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, handoff: await handoffView(scope, h) });
}
