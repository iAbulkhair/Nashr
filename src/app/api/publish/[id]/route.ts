import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, getTask, saveTask } from "@/lib/brand";
import { gateTask } from "@/lib/brand-rules";
import { connectedTargets, publishTask, targetsFor } from "@/lib/connectors/publish";
import { listConnections } from "@/lib/connectors/store";
import { decisionOf, recordDecisions } from "@/lib/decisions";
import { forbid } from "@/lib/roles";

export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Publishing is irreversible and approves the item: admin and owner only (src/lib/roles.ts "publish").
  const no = forbid(u, "publish");
  if (no) return no;
  const { id } = await ctx.params;
  const t = await getTask(sc(u), id);
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { provider?: string };
  if (!b.provider) return NextResponse.json({ ok: false, error: "provider_required" }, { status: 400 });
  // The owner's click is the approval here, but a rejected item stays unpublished and the target must fit the item type.
  if (t.status === "rejected") return NextResponse.json({ ok: false, error: "rejected_item" }, { status: 409 });
  const [connections, brand] = await Promise.all([listConnections(sc(u)), getBrand(sc(u))]);
  // Publishing approves the item, so it passes the same brand gate as the approve button.
  const violations = gateTask(brand, t);
  if (violations.length) return NextResponse.json({ ok: false, error: "brand_violation", violations }, { status: 409 });
  const connected = connectedTargets(connections);
  if (!targetsFor(t, connected).includes(b.provider)) return NextResponse.json({ ok: false, error: "wrong_target" }, { status: 400 });
  try {
    const r = await publishTask(sc(u), t, b.provider);
    t.published = [...(t.published ?? []), { provider: r.provider, url: r.url, status: r.status, at: new Date().toISOString() }];
    // Publishing a pending item is the owner approving it, so it records when that happened. Without this the item was
    // "approved" with no decidedAt, which the evals treat as auto-approved and leave out of every approval rate and
    // out of "hours to decide" — the owner's own decision went uncounted.
    const approving = t.status === "pending", now = new Date().toISOString();
    if (approving) t.decidedAt = now;
    t.status = "approved";
    await saveTask(sc(u), t);
    // The same approval goes into the owner's decision records. An item that was already approved, by the owner or by
    // auto-approve, adds nothing. The item has already gone to the platform, so a failed record is logged, not reported
    // as a failed publish.
    await Promise.all([
      track(u.email, "publish"),
      approving ? recordDecisions(sc(u), [decisionOf(t, "publish", now)]).catch((e) => console.error("decision record failed", e)) : null,
    ]);
    return NextResponse.json({ ok: true, result: r, task: t });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "publish_failed" }, { status: 502 });
  }
}
