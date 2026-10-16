import { db } from "./db";
import { log } from "./log";

/**
 * Cron heartbeats (rule 1014). Every cron route writes `cronbeat:{job}` = the time of its last finished run, and the
 * founder reads the ages: on the Usage page (`GET /api/admin/overview`, `crons`) and through the bearer-gated
 * `GET /api/health?crons=1`. Nothing watched the nine cron entries before: they live in hPanel and QStash, outside the
 * repository, and a header file that stopped working left the daily brief, the renewals and the media sweep silent.
 *
 * The keys are platform-wide and built from this fixed list, never from a request. A heartbeat means the route
 * authenticated the caller and finished without throwing; it says nothing about every workspace inside the batch
 * (that is the job's own report). A run that throws, or answers 401 or 409, leaves the old heartbeat in place.
 *
 * The limits are the schedule plus slack for a late start and a chain of hops (`crons.json`; `secretary` is the
 * 15-minute QStash tick, which is not in that file).
 */
export const CRON_MAX_AGE_SEC = {
  weekly: 8 * 86400, // Sundays 03:00 UTC
  daily: 26 * 3600, // 05:00 UTC
  golden: 8 * 86400, // Saturdays 01:00 UTC
  media: 26 * 3600, // 05:20 UTC
  routines: 26 * 3600, // 06:00 UTC
  evening: 26 * 3600, // 15:00 UTC
  stores: 14 * 3600, // 02:00 and 14:00 UTC
  secretary: 3600, // every 15 minutes
} as const;
export type CronJob = keyof typeof CRON_MAX_AGE_SEC;
export const CRON_JOBS = Object.keys(CRON_MAX_AGE_SEC) as CronJob[];

const KEEP_SECONDS = 60 * 86400;
const key = (job: CronJob) => `cronbeat:${job}`;

/** Marks `job` as having just finished. Never throws: a store that is down must not fail a cron that otherwise worked. */
export async function recordCronRun(job: CronJob, now = Date.now()): Promise<void> {
  try {
    await db.set(key(job), now, KEEP_SECONDS);
  } catch (e) {
    log.error("cron heartbeat failed", { job, error: e });
  }
}

/** `waiting`: no heartbeat stored yet (a fresh deploy, or an emptied store); it is not counted as stale. */
export type CronStatus = { job: CronJob; status: "ok" | "stale" | "waiting"; lastRunAt: string | null; ageSec: number | null; maxAgeSec: number };

/** Every job's state, read with one store command. */
export async function cronStatuses(now = Date.now()): Promise<CronStatus[]> {
  const stored = await db.mget<number | string>(CRON_JOBS.map(key));
  return CRON_JOBS.map((job, i) => {
    const maxAgeSec = CRON_MAX_AGE_SEC[job];
    const at = Number(stored[i]);
    if (stored[i] === null || !Number.isFinite(at) || at <= 0) return { job, status: "waiting", lastRunAt: null, ageSec: null, maxAgeSec };
    const ageSec = Math.max(0, Math.round((now - at) / 1000));
    return { job, status: ageSec > maxAgeSec ? "stale" : "ok", lastRunAt: new Date(at).toISOString(), ageSec, maxAgeSec };
  });
}
