import { NextResponse } from "next/server";
import { allow, clientIp, retryLater } from "@/lib/rate";

/**
 * GET /api/health (rule 676): says the process is up and which build it is, for the release probe and the smoke script
 * (scripts/probe.mjs, scripts/smoke.mjs). Public, no session. On staging it sits behind the lock like every other path,
 * and the scripts send the cookie.
 *
 * Exactly `{ ok, commit, built }`, never uncached: no environment name, no store status, no dependency versions.
 * `BUILD_COMMIT` and `BUILD_TIME` are set by `next.config.ts` and inlined at build time; "unknown" means they were not.
 *
 * Per IP, 60 a minute. The limiter is the only thing here that touches Redis, and this route exists to say the process
 * is up, so a limiter that cannot reach its store counts the caller as allowed instead of failing the answer. The same
 * holds for a slow store: the Upstash client retries for about 4.3 s, longer than the probe gives a sample, so the answer
 * waits for the limiter at most `LIMITER_WAIT_MS` and then counts the caller as allowed (the count still lands later).
 */
const LIMITER_WAIT_MS = 1000;

export async function GET(req: Request) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const allowed = await Promise.race([
    allow("health:" + clientIp(req), 60, 60).catch(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), LIMITER_WAIT_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (!allowed) return retryLater({ ok: false, error: "slow_down" }, 60);
  return NextResponse.json(
    { ok: true, commit: process.env.BUILD_COMMIT ?? "unknown", built: process.env.BUILD_TIME ?? "unknown" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
