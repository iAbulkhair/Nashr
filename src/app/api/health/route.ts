import { NextResponse } from "next/server";
import { allow, clientIp, retryLater, sameSecret } from "@/lib/rate";
import { db } from "@/lib/db";
import { cronStatuses } from "@/lib/cron-heartbeat";

/**
 * GET /api/health (rule 676): says the process is up and which build it is, for the release probe and the smoke script
 * (scripts/probe.mjs, scripts/smoke.mjs). Public, no session. On staging it sits behind the lock like every other path,
 * and the scripts send the cookie.
 *
 * Without a query: exactly `{ ok, commit, built }`, never uncached: no environment name, no store status, no dependency versions.
 * `BUILD_COMMIT` and `BUILD_TIME` are set by `next.config.ts` and inlined at build time; "unknown" means they were not.
 *
 * Per IP, 60 a minute. The limiter is the only thing here that touches Redis, and this route exists to say the process
 * is up, so a limiter that cannot reach its store counts the caller as allowed instead of failing the answer. The same
 * holds for a slow store: the Upstash client retries for about 4.3 s, longer than the probe gives a sample, so the answer
 * waits for the limiter at most `LIMITER_WAIT_MS` and then counts the caller as allowed (the count still lands later).
 *
 * Two opt-in extensions for the uptime monitor (rule 1011), each leaving the plain answer above exactly as it was:
 * - `?store=1` (public, same limiter) also reads one key from Redis and adds `store: { ok, ms }`. The answer is 503 with
 *   `ok: false` when the read fails or takes over `STORE_WAIT_MS`. Nothing else about the store is named: no key, no host.
 * - `?crons=1` (needs `Authorization: Bearer ${CRON_SECRET}`, compared with `sameSecret`, 401 otherwise and when the
 *   secret is unset) adds `store` and `crons: { stale, waiting, jobs }` from the cron heartbeats (src/lib/cron-heartbeat.ts,
 *   rule 1014). The answer is 503 when the store is down or a cron is stale. The job names are public in the repository.
 */
const LIMITER_WAIT_MS = 1000;
const STORE_WAIT_MS = 2000;

/** One cheap read (GET of a key nobody writes). `ok: false` on an error or past `STORE_WAIT_MS`; `ms` is the time spent. */
async function pingStore(): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ok = await Promise.race([
    db.get("health:ping").then(() => true, () => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), STORE_WAIT_MS); }),
  ]).finally(() => clearTimeout(timer));
  return { ok, ms: Date.now() - t0 };
}

export async function GET(req: Request) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const allowed = await Promise.race([
    allow("health:" + clientIp(req), 60, 60).catch(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), LIMITER_WAIT_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (!allowed) return retryLater({ ok: false, error: "slow_down" }, 60);

  const query = new URL(req.url).searchParams;
  const wantCrons = query.get("crons") === "1";
  const wantStore = wantCrons || query.get("store") === "1";
  const base = { commit: process.env.BUILD_COMMIT ?? "unknown", built: process.env.BUILD_TIME ?? "unknown" };
  const headers = { "Cache-Control": "no-store" };
  if (!wantStore) return NextResponse.json({ ok: true, ...base }, { headers });

  if (wantCrons) {
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401, headers });
  }
  const store = await pingStore();
  if (!wantCrons) return NextResponse.json({ ok: store.ok, ...base, store }, { status: store.ok ? 200 : 503, headers });

  // Heartbeats live in the same store: with it down there is nothing to read, so the answer is the store's failure.
  const jobs = store.ok ? await cronStatuses().catch(() => null) : null;
  const stale = (jobs ?? []).filter((j) => j.status === "stale").map((j) => j.job);
  const waiting = (jobs ?? []).filter((j) => j.status === "waiting").map((j) => j.job);
  const ok = store.ok && jobs !== null && stale.length === 0;
  return NextResponse.json({ ok, ...base, store, crons: { stale, waiting, jobs: jobs ?? [] } }, { status: ok ? 200 : 503, headers });
}
