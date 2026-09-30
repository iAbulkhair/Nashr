import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { decideProposal } from "@/lib/brand-proposals";
import { forbid } from "@/lib/roles";
import { byOf } from "@/lib/actor";
import { recordActivity } from "@/lib/activity";

/**
 * The owner's answer to a brand change an agent proposed (src/lib/brand-proposals.ts): apply it or dismiss it. The same
 * role as the Brand page, since applying one writes the brand file; the proposal is read from the caller's own scope.
 * An applied proposal changed the brand file, so it is one `brand_changed` row of the activity log: by the login that
 * pressed Save (from the session), the proposing agent, and the field's name, never its value. A dismissal changes nothing
 * and writes no row.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "brand.write");
  if (no) return no;
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { action?: unknown };
  if (b.action !== "apply" && b.action !== "dismiss") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  const r = await decideProposal(sc(u), id, b.action);
  if (!r.ok) return NextResponse.json(r, { status: r.error === "not_found" ? 404 : 409 });
  if (r.applied) await recordActivity(sc(u), [{ at: r.brand?.updatedAt ?? new Date().toISOString(), kind: "brand_changed", agent: r.agent, by: byOf(u), via: "app", note: r.field }]);
  return NextResponse.json(r);
}
