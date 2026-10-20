import { NextResponse } from "next/server";
import { allow, clientIp, retryLater, OPS_CALLS_PER_IP_PER_MINUTE, OPS_PROPOSALS_PER_DAY, OPS_RELAY_PER_HOUR, WINDOW } from "@/lib/rate";
import { opsAuthorized, parseRelay, relay } from "@/lib/ops";

/**
 * POST /api/ops/telegram (rules 2383-2385): the ops agent's relay to the founder's Telegram chat (src/lib/ops.ts).
 * Per IP `OPS_CALLS_PER_IP_PER_MINUTE` a minute, then `Authorization: Bearer ${OPS_AGENT_TOKEN}` (401 while unset), then
 * `OPS_RELAY_PER_HOUR` messages an hour and `OPS_PROPOSALS_PER_DAY` proposals a day. Body `{ text, proposal? }`, where
 * `proposal` is `{ action: "github_issue", title, body }` and `alert_key` names an alert sent at most once in 12 hours
 * (200 `{ sent: false, skipped: true }` for a repeat). 502 when Telegram did not take the message.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!(await allow("ops:ip:" + clientIp(req), OPS_CALLS_PER_IP_PER_MINUTE, 60))) return retryLater({ error: "slow_down" }, 60);
  if (!opsAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const input = parseRelay(await req.json().catch(() => null));
  if ("error" in input) return NextResponse.json(input, { status: 400, headers });
  if (!(await allow("ops:relay", OPS_RELAY_PER_HOUR, WINDOW.hour))) return retryLater({ error: "slow_down" }, WINDOW.hour);
  if (input.proposal && !(await allow("ops:proposals", OPS_PROPOSALS_PER_DAY, WINDOW.day))) return retryLater({ error: "too_many_proposals" }, WINDOW.day);
  const out = await relay(input);
  return NextResponse.json(out, { status: out.sent || out.skipped ? 200 : 502, headers });
}
