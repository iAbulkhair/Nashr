import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, getTask, type Task } from "@/lib/brand";
import { gateTask } from "@/lib/brand-rules";
import { connectedTargets, targetsFor } from "@/lib/connectors/publish";
import { isDuplicate, publishOnce } from "@/lib/publish-once";
import { listConnections } from "@/lib/connectors/store";
import { decisionOf, recordDecisions } from "@/lib/decisions";
import { byOf } from "@/lib/actor";
import { recordActivity } from "@/lib/activity";
import { agentForTask } from "@/lib/agents";
import { forbid } from "@/lib/roles";
import { taskVersion } from "@/lib/task-version";
import { publishScopeCheck, readAgentScopeModes } from "@/lib/agent-scope";
import { deadlineFor } from "@/lib/media/keys";
import { acct } from "@/lib/account-id";
import { BUSY_RETRY_S, RefreshBusy } from "@/lib/connectors/fresh";
import { retryAfter } from "@/lib/rate";

export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Publishing is irreversible and approves the item: admin and owner only (src/lib/roles.ts "publish").
  const no = forbid(u, "publish");
  if (no) return no;
  const { id } = await ctx.params;
  const t = await getTask(sc(u), id);
  if (!t) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const raw = (await req.json().catch(() => ({}))) as { provider?: string; again?: unknown; live?: unknown; version?: unknown } | null;
  const b = raw && typeof raw === "object" ? raw : {};
  if (!b.provider) return NextResponse.json({ ok: false, error: "provider_required" }, { status: 400 });
  // The publish is bound to the card the admin saw (src/lib/task-version.ts): a member may edit a pending draft, and
  // that edit must never go out under the admin's click. Compared here and again on the copy that is sent, under the lock.
  if (typeof b.version !== "string") return NextResponse.json({ ok: false, error: "version_required" }, { status: 400 });
  const version = b.version;
  if (taskVersion(t) !== version) return NextResponse.json({ ok: false, error: "changed", task: t }, { status: 409 });
  // The owner's click is the approval here, but a rejected item stays unpublished and the target must fit the item type.
  if (t.status === "rejected") return NextResponse.json({ ok: false, error: "rejected_item" }, { status: 409 });
  // Who publishes, from the session (never the body), for the decision record and the activity row below.
  const [connections, brand, by, modes] = await Promise.all([listConnections(sc(u)), getBrand(sc(u)), byOf(u), readAgentScopeModes()]);
  // Publishing approves the item, so it passes the same brand gate as the approve button, plus the publish-only part:
  // no placeholder goes out, not even a WhatsApp {{1}}, except a template's own {{n}} sent to Meta's review (src/lib/brand-rules.ts).
  const violations = gateTask(brand, t, { publish: true, provider: b.provider });
  if (violations.length) return NextResponse.json({ ok: false, error: "brand_violation", violations }, { status: 409 });
  // Going live is the owner's per-item confirmation for the WordPress site; no other platform has a draft to go live from.
  if (b.live === true && b.provider !== "wordpress") return NextResponse.json({ ok: false, error: "live_unsupported" }, { status: 400 });
  const connected = connectedTargets(connections);
  if (!targetsFor(t, connected).includes(b.provider)) return NextResponse.json({ ok: false, error: "wrong_target" }, { status: 400 });
  // The agent-scope publish check (rule 1410), last before the send: in enforce a refusal holds the item (409, the owner
  // can edit it and try again, or the founder releases it) and a check that failed holds it too (503, fails closed). The
  // version compared under the publish lock below ties the text sent to the text checked here.
  const held = await publishScopeCheck(u, t, "publish", t.lang === "en" ? "en" : "ar", modes, deadline);
  if (held.block) return NextResponse.json({ ok: false, error: held.verdict === "error" ? "agent_scope_unavailable" : "agent_scope_held", message: held.reply }, { status: held.verdict === "error" ? 503 : 409 });
  // One publish per item and platform; a second one, or one after a result nobody saw, needs the owner's "again". The
  // two checks that read the item run again on the copy that is sent, under the publish lock.
  const r = await publishOnce(sc(u), id, b.provider, {
    again: b.again === true,
    live: b.live === true,
    // Just above this route's 60 s: a killed function cannot post any more, and the attempt marker still holds a repeat.
    lockS: 70,
    check: (cur) => {
      if (cur.status === "rejected") return { error: "rejected_item" };
      if (taskVersion(cur) !== version) return { error: "changed" };
      const v = gateTask(brand, cur, { publish: true, provider: b.provider });
      return v.length ? { error: "brand_violation", violations: v } : null;
    },
  });
  // Publishing a pending item approves it: that approval goes into the owner's decision records. An item that was
  // already approved, by the owner or by auto-approve, adds nothing. The item has already gone to the platform, so a
  // failed record is logged, not reported as a failed publish. Every post that went out is one row of the activity log
  // (which never throws); a refused, busy, duplicate or unknown attempt returns below without one.
  const record = (task: Task, approving: boolean, provider: string, postedAt: string) => Promise.all([
    track(acct(u), "publish"),
    approving ? recordDecisions(sc(u), [decisionOf(task, "publish", task.decidedAt ?? postedAt, { by })]).catch((e) => console.error("decision record failed", e)) : null,
    recordActivity(sc(u), [{ at: postedAt, kind: "published", agent: agentForTask(t.type).id, by, via: "app", type: t.type, tasks: [t.id], outcome: provider, note: t.title }]),
  ]);
  if (!r.ok) {
    if (r.error === "refused") return NextResponse.json({ ok: false, ...r.refusal }, { status: 409 });
    if (r.error === "publish_failed") {
      // The token's refresh was held by another request through every wait (rule 2192): nothing went out, try again shortly.
      if (r.cause instanceof RefreshBusy) return NextResponse.json({ ok: false, error: "busy" }, { status: 503, headers: retryAfter(BUSY_RETRY_S) });
      const msg = r.cause instanceof Error ? r.cause.message : "publish_failed";
      // The platform refused the same text again: nothing went out this time, and the connection is fine.
      if (isDuplicate(msg)) return NextResponse.json({ ok: false, error: "duplicate_post" }, { status: 409 });
      return NextResponse.json({ ok: false, error: msg }, { status: 502 });
    }
    // Nothing new was posted, but the earlier attempt whose answer nobody saw did go out, and it wrote no record then
    // (it ended `publish_unknown`). It is recorded now, at the time it went out, as any publish is.
    if (r.error === "earlier_live") {
      await record(r.task, r.approving, b.provider, r.at);
      return NextResponse.json({ ok: false, error: r.error, at: r.at }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: r.error, ...(r.at ? { at: r.at } : {}), ...(r.url ? { url: r.url } : {}) }, { status: r.error === "not_found" ? 404 : 409 });
  }
  await record(r.task, r.approving, r.result.provider, r.task.published?.at(-1)?.at ?? new Date().toISOString());
  return NextResponse.json({ ok: true, result: r.result, task: r.task });
}
