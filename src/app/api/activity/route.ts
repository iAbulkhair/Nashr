import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { isAgentId } from "@/lib/agents";
import { ACTIVITY_PAGE, isActivityCursor, isActivityKind, listActivity } from "@/lib/activity";
import { ACTIVITY_READS_PER_HOUR, allow } from "@/lib/rate";

/**
 * GET ?agent&kind&before — one page of the caller's activity log, newest first, for the Activity page's filters and
 * "Load more". The first page is rendered on the server; this answers the ones after it. Only the caller's own brand
 * scope is read (`sc(u)`): no scope, email or key is taken from the request, and every parameter is checked against a
 * known set before the read.
 */
export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  if (!(await allow(`activitylist:${u.email}`, ACTIVITY_READS_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429, headers: { "Retry-After": "3600" } });
  const q = new URL(req.url).searchParams;
  const agent = q.get("agent") || undefined, kind = q.get("kind") || undefined, before = q.get("before") || undefined;
  if (agent !== undefined && !isAgentId(agent)) return NextResponse.json({ ok: false, error: "bad_agent" }, { status: 400 });
  if (kind !== undefined && !isActivityKind(kind)) return NextResponse.json({ ok: false, error: "bad_kind" }, { status: 400 });
  if (before !== undefined && !isActivityCursor(before)) return NextResponse.json({ ok: false, error: "bad_cursor" }, { status: 400 });
  const page = await listActivity(sc(u), { agent, kind, before, limit: ACTIVITY_PAGE });
  return NextResponse.json({ ok: true, ...page });
}
