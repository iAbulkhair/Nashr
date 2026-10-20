import { NextResponse } from "next/server";
import { allow, clientIp, retryLater, OPS_CALLS_PER_IP_PER_MINUTE } from "@/lib/rate";
import { opsAuthorized, opsSummary } from "@/lib/ops";

/**
 * GET /api/ops/summary (rules 2380-2382): the ops agent's read of the app, counts only (src/lib/ops.ts `opsSummary`).
 * Per IP `OPS_CALLS_PER_IP_PER_MINUTE` a minute, then `Authorization: Bearer ${OPS_AGENT_TOKEN}` (`sameSecret`; 401
 * while the variable is unset). Never cached. 200 even when a cron is stale: the agent reads `ok` and reports it.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!(await allow("ops:ip:" + clientIp(req), OPS_CALLS_PER_IP_PER_MINUTE, 60))) return retryLater({ error: "slow_down" }, 60);
  if (!opsAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  return NextResponse.json(await opsSummary(), { headers });
}
