import { randomBytes } from "crypto";
import { db } from "./db";
import { globalKey, wsKey, type Scope } from "./keys";

/**
 * The durable job queue (Thakeen v2 phase 2, C7, rules 4650-4669; docs/system/tests/4620-v2-plans.md). Off in this
 * release (`QUEUE`, src/lib/v2-flags.ts): nothing calls `enqueue` and the tick does nothing.
 *
 * Work that must run without a request waits here: today one kind, a step of an approved plan (src/lib/plans.ts). Each
 * workspace has its own list, so one workspace's work never waits behind another's, and the tick runs at most one job of
 * a workspace at a time (GET /api/cron/queue, kicked by Reem's 15-minute tick).
 *
 * Keys, all under the caller's own scope (`sc(u)`), never one taken from a request: the job `qjob:{scope}:{id}` (30
 * days), the list of waiting ids `jobq:{scope}`, the set of every id `qjobs:{scope}` (for the wipe) and the platform set
 * `qscopes`, the scopes the tick visits. The list is
 * read in the jobs' own order (`at`, then `step`), so ids are pushed in one round. A job's attempts are counted BEFORE
 * its work (`startJob`), like the cron batch's own counter: a platform kill leaves the count behind, so a job is started
 * at most `QUEUE_MAX_ATTEMPTS` times whatever happens. What a job charges is bounded by its own claim (`chargeOnce`).
 */

export type QueueJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
/** `plan_step`: step `step` of plan `plan` of the same scope. Every field is set in code, never from a request or a model. */
export type QueueJob = {
  id: string;
  kind: "plan_step";
  plan: string;
  step: number;
  status: QueueJobStatus;
  attempts: number;
  at: string;
  ranAt?: string;
  reason?: string;
};

/** Starts of one job, counted before the work (rule 4653). */
export const QUEUE_MAX_ATTEMPTS = 2;
/** Waiting jobs per workspace (rule 4651): a plan has at most 8 steps, so this is room for several plans. */
export const QUEUE_MAX = 40;
export const QUEUE_JOB_TTL_S = 30 * 86400;

export const isJobId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{16}$/.test(id);
const terminal = (s: QueueJobStatus) => s === "done" || s === "failed" || s === "cancelled";
const order = (a: QueueJob, b: QueueJob) => a.at.localeCompare(b.at) || a.step - b.step;

/**
 * Adds jobs to the scope's queue, then the scope to the tick's set. Refused whole (`queue_full`, nothing
 * written) when the queue would pass `QUEUE_MAX`.
 */
export async function enqueue(
  s: Scope,
  jobs: readonly Pick<QueueJob, "kind" | "plan" | "step">[],
): Promise<{ ok: true; jobs: QueueJob[] } | { ok: false; error: "queue_full" }> {
  if (!jobs.length) return { ok: true, jobs: [] };
  const waiting = await db.lrange(wsKey.queue(s), 0, -1);
  if (waiting.length + jobs.length > QUEUE_MAX) return { ok: false, error: "queue_full" };
  const at = new Date().toISOString();
  const made: QueueJob[] = jobs.map((j) => ({
    id: randomBytes(8).toString("hex"),
    kind: j.kind,
    plan: j.plan,
    step: j.step,
    status: "queued",
    attempts: 0,
    at,
  }));
  await Promise.all([
    ...made.map((j) => db.set(wsKey.queueJob(s, j.id), j, QUEUE_JOB_TTL_S)),
    ...made.map((j) => db.sadd(wsKey.queueJobs(s), j.id)),
    db.expire(wsKey.queueJobs(s), QUEUE_JOB_TTL_S),
  ]);
  // The ids before the scope joins the set, never in the same round: a tick that takes the scope out re-reads the list
  // after it (`settleScope`, src/lib/plan-run.ts), so it either sees these ids or the scope is added after it left.
  await Promise.all(made.map((j) => db.lpush(wsKey.queue(s), j.id)));
  await db.sadd(globalKey.queueScopes(), s);
  return { ok: true, jobs: made };
}

/** One job of the caller's scope, or null (a malformed id builds no key). */
export async function getJob(s: Scope, id: string): Promise<QueueJob | null> {
  return isJobId(id) ? db.get<QueueJob>(wsKey.queueJob(s, id)) : null;
}

/**
 * The scope's waiting jobs, oldest first, read in two commands. An id whose record is gone or finished is dropped from
 * the list in the same round, so a list never fills with dead ids.
 */
export async function listQueued(s: Scope): Promise<QueueJob[]> {
  const ids = await db.lrange(wsKey.queue(s), 0, -1);
  if (!ids.length) return [];
  const jobs = await db.mget<QueueJob>(ids.map((id) => wsKey.queueJob(s, id)));
  const dead = ids.filter((id, i) => !isJobId(id) || !jobs[i] || terminal(jobs[i]!.status));
  if (dead.length) await Promise.all(dead.map((id) => db.lrem(wsKey.queue(s), id)));
  return jobs.filter((j): j is QueueJob => !!j && !terminal(j.status)).sort(order);
}

/**
 * Marks a job `running` and counts the attempt, before any work (rule 4653). At `QUEUE_MAX_ATTEMPTS` already the job is
 * finished as `failed` instead (reason `attempts`) and null is returned: the caller runs nothing.
 */
export async function startJob(s: Scope, j: QueueJob): Promise<QueueJob | null> {
  if (j.attempts >= QUEUE_MAX_ATTEMPTS) {
    await finishJob(s, j, "failed", "attempts");
    return null;
  }
  const next: QueueJob = { ...j, status: "running", attempts: j.attempts + 1, ranAt: new Date().toISOString() };
  await db.set(wsKey.queueJob(s, j.id), next, QUEUE_JOB_TTL_S);
  return next;
}

/** Puts a started job back to wait for the next tick (a retry), keeping its attempt count. */
export async function requeueJob(s: Scope, j: QueueJob, reason?: string): Promise<void> {
  await db.set(
    wsKey.queueJob(s, j.id),
    { ...j, status: "queued", ...(reason ? { reason } : {}) } satisfies QueueJob,
    QUEUE_JOB_TTL_S,
  );
}

/** Ends a job: its record keeps the outcome for 30 days, and its id leaves the list. */
export async function finishJob(
  s: Scope,
  j: QueueJob,
  status: "done" | "failed" | "cancelled",
  reason?: string,
): Promise<void> {
  await Promise.all([
    db.set(
      wsKey.queueJob(s, j.id),
      { ...j, status, ...(reason ? { reason } : {}) } satisfies QueueJob,
      QUEUE_JOB_TTL_S,
    ),
    db.lrem(wsKey.queue(s), j.id),
  ]);
}

/** Cancels every waiting job of one plan of the scope (the owner's Cancel or Pause). Returns how many. */
export async function cancelPlanJobs(s: Scope, plan: string, reason: "cancelled" | "paused"): Promise<number> {
  const mine = (await listQueued(s)).filter((j) => j.plan === plan && j.status === "queued");
  await Promise.all(mine.map((j) => finishJob(s, j, "cancelled", reason)));
  return mine.length;
}

/** The scopes the tick visits. A scope leaves the set when nothing in it waits (`leaveQueue`). */
export const queueScopes = () => db.smembers(globalKey.queueScopes());
/** Adds the caller's scope to the tick's set (a resumed plan whose steps are queued on the next tick). */
export const joinQueue = (s: Scope) => db.sadd(globalKey.queueScopes(), s);
/** Takes a scope out of the tick's set: nothing in it waits and no plan of it may still queue a step. */
export const leaveQueue = (scope: string) => db.srem(globalKey.queueScopes(), scope);

/** Every key of the scope's queue for `wipeAccount`: the list, the set of every job id it ever held, and those jobs. */
export async function queueKeys(s: Scope): Promise<string[]> {
  const [waiting, all] = await Promise.all([db.lrange(wsKey.queue(s), 0, -1), db.smembers(wsKey.queueJobs(s))]);
  const ids = [...new Set([...waiting, ...all])].filter(isJobId);
  return [wsKey.queue(s), wsKey.queueJobs(s), ...ids.map((id) => wsKey.queueJob(s, id))];
}
