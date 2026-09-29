import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, getTask, updateTask } from "@/lib/brand";
import { gateTask } from "@/lib/brand-rules";
import { connectedTargets, publishTask, targetsFor } from "@/lib/connectors/publish";
import { listConnections } from "@/lib/connectors/store";
import { decisionOf, recordDecisions } from "@/lib/decisions";
import { byOf } from "@/lib/actor";
import { recordActivity } from "@/lib/activity";
import { agentForTask } from "@/lib/agents";

export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await ctx.params;
  const t = await getTask(sc(u), id);
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { provider?: string };
  if (!b.provider) return NextResponse.json({ ok: false, error: "provider_required" }, { status: 400 });
  // The owner's click is the approval here, but a rejected item stays unpublished and the target must fit the item type.
  if (t.status === "rejected") return NextResponse.json({ ok: false, error: "rejected_item" }, { status: 409 });
  // Who publishes, from the session (never the body), for the decision record below.
  const [connections, brand, by] = await Promise.all([listConnections(sc(u)), getBrand(sc(u)), byOf(u)]);
  // Publishing approves the item, so it passes the same brand gate as the approve button.
  const violations = gateTask(brand, t);
  if (violations.length) return NextResponse.json({ ok: false, error: "brand_violation", violations }, { status: 409 });
  const connected = connectedTargets(connections);
  if (!targetsFor(t, connected).includes(b.provider)) return NextResponse.json({ ok: false, error: "wrong_target" }, { status: 400 });
  try {
    const r = await publishTask(sc(u), t, b.provider);
    const at = new Date().toISOString();
    let approving = false;
    // Applied to the task as stored now, not to the copy read before the publish: a render that finished during the
    // seconds a publish takes keeps its image or clip and its credits.
    const saved = await updateTask(sc(u), id, (cur) => {
      cur.published = [...(cur.published ?? []), { provider: r.provider, url: r.url, status: r.status, at }];
      // Publishing a pending item is the owner approving it, so it records when that happened. Without this the item was
      // "approved" with no decidedAt, which the evals treat as auto-approved and leave out of every approval rate and
      // out of "hours to decide" — the owner's own decision went uncounted.
      approving = cur.status === "pending";
      if (approving) cur.decidedAt = at;
      cur.status = "approved";
      return cur;
    });
    // The same approval goes into the owner's decision records. An item that was already approved, by the owner or by
    // auto-approve, adds nothing. The item has already gone to the platform, so a failed record is logged, not reported
    // as a failed publish. Every publish is one row of the activity log (which never throws).
    await Promise.all([
      track(u.email, "publish"),
      approving && saved ? recordDecisions(sc(u), [decisionOf(saved, "publish", at, { by })]).catch((e) => console.error("decision record failed", e)) : null,
      recordActivity(sc(u), [{ at, kind: "published", agent: agentForTask(t.type).id, by, via: "app", type: t.type, tasks: [t.id], outcome: r.provider, note: t.title }]),
    ]);
    return NextResponse.json({ ok: true, result: r, task: saved ?? t });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "publish_failed" }, { status: 502 });
  }
}
