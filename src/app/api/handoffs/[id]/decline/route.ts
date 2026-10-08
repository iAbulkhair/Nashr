import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, HANDOFF_DECLINES_PER_HOUR, retryLater } from "@/lib/rate";
import { byOf } from "@/lib/actor";
import { declineHandoff, handoffView, isHandoffId } from "@/lib/handoffs";

/**
 * POST {item?} — decline one item of one of Majed's handoffs, or, without `item`, every item that can still run. Charges
 * and generates nothing. Declining work is a draft decision, like rejecting an inbox item (`drafts`). The record is read
 * only under `sc(u)` (another account's id is 404) and changed under the handoff's lock, so it never lands inside a run;
 * a done, declined or running item is refused in code (409).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  const no = forbid(u, "drafts");
  if (no) return no;
  if (!(await allow(`handoffdecline:${u.email}`, HANDOFF_DECLINES_PER_HOUR, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const { id } = await ctx.params;
  if (!isHandoffId(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { item?: unknown } | null;
  const item = b && typeof b === "object" && !Array.isArray(b) ? b.item : undefined;
  if (item !== undefined && (typeof item !== "number" || !Number.isInteger(item) || item < 0)) return NextResponse.json({ ok: false, error: "bad_item" }, { status: 400 });
  const scope = sc(u);
  const r = await declineHandoff(scope, id, item, byOf(u));
  if (!r.ok) {
    const status = r.error === "not_found" ? 404 : r.error === "bad_item" ? 400 : 409;
    return NextResponse.json({ ok: false, error: r.error, ...(r.handoff ? { handoff: await handoffView(scope, r.handoff) } : {}) }, { status });
  }
  return NextResponse.json({ ok: true, handoff: await handoffView(scope, r.handoff), declined: r.declined });
}
