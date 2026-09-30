import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { decideProposal } from "@/lib/brand-proposals";
import { forbid } from "@/lib/roles";

/**
 * The owner's answer to a brand change an agent proposed (src/lib/brand-proposals.ts): apply it or dismiss it. The same
 * role as the Brand page, since applying one writes the brand file; the proposal is read from the caller's own scope.
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
  return NextResponse.json(r);
}
