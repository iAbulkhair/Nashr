import { NextResponse } from "next/server";
import { sameSecret } from "@/lib/rate";
import { recordCronRun } from "@/lib/cron-heartbeat";
import { sweepMedia } from "@/lib/media/jobs";
import { mediaDeps } from "@/lib/media/registry";
import { deadlineFor } from "@/lib/media/keys";

export const maxDuration = 300;

/**
 * The media backstop (spec A3, 4.4 F): fails and refunds renders nobody is polling, copies results whose copy failed, and
 * drops set members whose job is gone. Not a step of /api/cron/daily: each advance can take most of a minute, which that
 * route's per-workspace budget cannot give.
 */
export async function GET(req: Request) {
  const deadline = deadlineFor(maxDuration);
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const swept = await sweepMedia(mediaDeps(), { deadline });
  await recordCronRun("media");
  return NextResponse.json({ ok: true, ...swept });
}
