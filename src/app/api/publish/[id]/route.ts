import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, getTask } from "@/lib/brand";
import { gateTask } from "@/lib/brand-rules";
import { connectedTargets, targetsFor } from "@/lib/connectors/publish";
import { isDuplicate, publishOnce } from "@/lib/publish-once";
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
  const b = (await req.json().catch(() => ({}))) as { provider?: string; again?: unknown };
  if (!b.provider) return NextResponse.json({ ok: false, error: "provider_required" }, { status: 400 });
  // The owner's click is the approval here, but a rejected item stays unpublished and the target must fit the item type.
  if (t.status === "rejected") return NextResponse.json({ ok: false, error: "rejected_item" }, { status: 409 });
  const [connections, brand] = await Promise.all([listConnections(sc(u)), getBrand(sc(u))]);
  // Publishing approves the item, so it passes the same brand gate as the approve button, plus the publish-only part:
  // no placeholder of any kind goes out, not even a WhatsApp {{1}} (src/lib/brand-rules.ts).
  const violations = gateTask(brand, t, { publish: true });
  if (violations.length) return NextResponse.json({ ok: false, error: "brand_violation", violations }, { status: 409 });
  const connected = connectedTargets(connections);
  if (!targetsFor(t, connected).includes(b.provider)) return NextResponse.json({ ok: false, error: "wrong_target" }, { status: 400 });
  // One publish per item and platform; a second one, or one after a result nobody saw, needs the owner's "again". The
  // two checks that read the item run again on the copy that is sent, under the publish lock.
  const r = await publishOnce(sc(u), id, b.provider, {
    again: b.again === true,
    // Just above this route's 60 s: a killed function cannot post any more, and the attempt marker still holds a repeat.
    lockS: 70,
    check: (cur) => {
      if (cur.status === "rejected") return { error: "rejected_item" };
      const v = gateTask(brand, cur, { publish: true });
      return v.length ? { error: "brand_violation", violations: v } : null;
    },
  });
  if (!r.ok) {
    if (r.error === "refused") return NextResponse.json({ ok: false, ...r.refusal }, { status: 409 });
    if (r.error === "publish_failed") {
      const msg = r.cause instanceof Error ? r.cause.message : "publish_failed";
      // The platform refused the same text again: nothing went out this time, and the connection is fine.
      if (isDuplicate(msg)) return NextResponse.json({ ok: false, error: "duplicate_post" }, { status: 409 });
      return NextResponse.json({ ok: false, error: msg }, { status: 502 });
    }
    return NextResponse.json({ ok: false, error: r.error, ...(r.at ? { at: r.at } : {}), ...(r.url ? { url: r.url } : {}) }, { status: r.error === "not_found" ? 404 : 409 });
  }
  // Publishing a pending item approves it: that approval goes into the owner's decision records. An item that was
  // already approved, by the owner or by auto-approve, adds nothing. The item has already gone to the platform, so a
  // failed record is logged, not reported as a failed publish.
  const at = r.task.decidedAt ?? new Date().toISOString();
  await Promise.all([
    track(u.email, "publish"),
    r.approving ? recordDecisions(sc(u), [decisionOf(r.task, "publish", at)]).catch((e) => console.error("decision record failed", e)) : null,
  ]);
  return NextResponse.json({ ok: true, result: r.result, task: r.task });
}
