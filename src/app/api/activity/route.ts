import { NextResponse } from "next/server";
import { z } from "zod";
import { handler, param } from "@/lib/api-handler";
import { isAgentId } from "@/lib/agents";
import { ACTIVITY_PAGE, isActivityCursor, isActivityKind, listActivity, publicActivity } from "@/lib/activity";
import { ACTIVITY_READS_PER_HOUR, WINDOW } from "@/lib/rate";

/** Each filter is optional (an empty value is none) and checked against its known set, in this order, before the read. */
const filters = z.object({
  agent: param(isAgentId, "bad_agent"),
  kind: param(isActivityKind, "bad_kind"),
  before: param(isActivityCursor, "bad_cursor"),
});

/**
 * GET ?agent&kind&before — one page of the caller's activity log, newest first, for the Activity page's filters and
 * "Load more". The first page is rendered on the server; this answers the ones after it. Only the caller's own brand
 * scope is read (`sc(u)`, the wrapper's `scope`): no scope, email or key is taken from the request, and every parameter
 * is checked against a known set before the read. Every login of the account may read it, so each row's `by` goes out
 * through `publicBy`: who impersonated stays with the founder console.
 */
export const GET = handler(
  { auth: "user", unauthorized: "auth", role: "read", rate: { bucket: "activitylist", max: ACTIVITY_READS_PER_HOUR, window: WINDOW.hour }, query: filters },
  async ({ scope, query: { agent, kind, before } }) => {
    const page = await listActivity(scope, { agent, kind, before, limit: ACTIVITY_PAGE });
    return NextResponse.json({ ok: true, rows: page.rows.map(publicActivity), next: page.next });
  },
);
