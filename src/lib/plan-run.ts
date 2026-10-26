import { db } from "./db";
import { acct, getUser, sc, type User } from "./auth";
import { agentSpendFor } from "./credits";
import { getGov } from "./governance";
import { BATCH_RUN_MIN_MS, generateBatch, type BatchResult } from "./generate-batch";
import { RETRY_LATE } from "./cron-batch";
import { deliverRun } from "./run-receipt";
import { LEAD_BRIEF_MAX } from "./json";
import { v2On } from "./v2-switch";
import { wsKey, type Scope } from "./keys";
import type { By } from "./actor";
import type { AgentId } from "./agents";
import type { Task } from "./brand";
import {
  getPlan,
  planStepClaim,
  planView,
  PLAN_RUN_LOCK_S,
  queueSteps,
  readySteps,
  recentPlans,
  savePlan,
  withPlanLock,
  withStep,
  type Plan,
  type PlanActionError,
} from "./plans";
import {
  finishJob,
  joinQueue,
  leaveQueue,
  listQueued,
  requeueJob,
  startJob,
  QUEUE_MAX_ATTEMPTS,
  type QueueJob,
} from "./queue";

/**
 * Running a plan (Thakeen v2 phase 2, C3 with the C7 queue, rules 4630-4649 and 4655-4669; docs/system/tests/4620-v2-plans.md).
 * Off in this release (`PLANS`, `QUEUE`): nothing approves a plan, and the tick answers before reading anything.
 *
 * - `approvePlan`: the owner's one approval. Checked in code under the plan's lock, never by the model: the plan is a
 *   proposal of this scope less than `PLAN_APPROVE_DAYS` old, the account's balance read fresh covers the total, and no
 *   agent's monthly cap (`Governance.agentCaps`) would be passed by its steps. Then the steps that wait for nothing are
 *   queued. Nothing is charged here: each step is charged when it runs.
 * - `tickScope`: one workspace's turn in the queue tick (GET /api/cron/queue). It queues the steps that became ready (their
 *   earlier steps are done and every item those made is approved), then runs at most ONE job, and only with
 *   `BATCH_RUN_MIN_MS` of the invocation left. A job is started (its attempt counted) under the plan's lock and its step
 *   is charged under its own claim (`planStepClaim`), so a run killed after its charge reuses its hold and the daily sweep
 *   refunds it when the step never delivered (src/lib/hold-sweep.ts).
 *
 * Every item a step makes waits in the inbox (`forcePending`), so the owner reads each one before a later step may run.
 */

/** A step's receipt lives past the hold's 8 days, so the daily sweep always finds it. */
const STEP_RECEIPT_TTL_S = 9 * 86400;
const iso = () => new Date().toISOString();

/** Majed's goal and this step's brief, as the batch's lead brief: data for the agent, never the owner's notes. */
export function leadBriefOf(p: Plan, n: number): string {
  return `Plan goal: ${p.goal}\nThis step (${n + 1} of ${p.steps.length}): ${p.steps[n].brief}`.slice(
    0,
    LEAD_BRIEF_MAX,
  );
}

export type ApproveResult =
  | { ok: true; plan: Plan }
  | { ok: false; error: PlanActionError | "queue_off" }
  | { ok: false; error: "no_credits"; need: number; credits: number }
  | { ok: false; error: "agent_cap"; agent: AgentId; spent: number; cap: number };

/** The owner's Approve (POST /api/plans/{id}, action `approve`): see the file's comment. */
export async function approvePlan(u: User, id: string, by: By, now = Date.now()): Promise<ApproveResult> {
  if (!v2On("QUEUE")) return { ok: false, error: "queue_off" };
  const s = sc(u);
  return (
    (await withPlanLock(s, id, async (): Promise<ApproveResult> => {
      const p = await getPlan(s, id);
      if (!p) return { ok: false, error: "not_found" };
      if (p.status !== "proposed") return { ok: false, error: "not_proposed" };
      if (planView(p, now).expired) return { ok: false, error: "expired" };
      // The balance and the caps as they are now, never the session's copy.
      const [fresh, gov] = await Promise.all([getUser(acct(u)), getGov(s)]);
      const credits = fresh?.credits ?? 0;
      if (!(credits >= p.total)) return { ok: false, error: "no_credits", need: p.total, credits };
      const spent = fresh ? agentSpendFor(fresh, s) : {};
      const per = new Map<AgentId, number>();
      for (const st of p.steps) per.set(st.agent, (per.get(st.agent) ?? 0) + st.cost);
      for (const [agent, need] of per) {
        const cap = gov.agentCaps?.[agent];
        if (typeof cap === "number" && cap > 0 && (spent[agent] ?? 0) + need > cap)
          return { ok: false, error: "agent_cap", agent, spent: spent[agent] ?? 0, cap };
      }
      const approved: Plan = {
        ...p,
        status: "approved",
        approvedBy: by,
        approvedAt: new Date(now).toISOString(),
        reason: undefined,
      };
      const q = await queueSteps(s, approved, readySteps(approved, new Set()));
      if (!q.ok) return q;
      return (await savePlan(s, q.plan)) ? { ok: true, plan: q.plan } : { ok: false, error: "not_found" };
    })) ?? { ok: false, error: "busy" }
  );
}

/** The done steps of `p` whose items all exist and are approved: the steps a later step may follow (rule 4636). */
async function approvedSteps(s: Scope, p: Plan): Promise<Set<number>> {
  const done = p.steps.flatMap((st, i) => (st.status === "done" && st.tasks?.length ? [{ i, ids: st.tasks }] : []));
  const ids = done.flatMap((d) => d.ids);
  if (!ids.length) return new Set();
  const rows = await db.mget<Pick<Task, "id" | "status">>(ids.map((t) => wsKey.task(s, t)));
  const status = new Map(ids.map((t, k) => [t, rows[k]?.status]));
  return new Set(done.filter((d) => d.ids.every((t) => status.get(t) === "approved")).map((d) => d.i));
}

/** Queues the ready steps of every approved plan of the scope, each under its own lock. Plans are read in one round. */
async function advancePlans(s: Scope): Promise<Plan[]> {
  const live = (await recentPlans(s)).filter((p) => p.status === "approved");
  await Promise.all(
    live
      .filter((p) => p.steps.some((st) => st.status === "waiting"))
      .map((p) =>
        withPlanLock(
          s,
          p.id,
          async () => {
            const cur = await getPlan(s, p.id);
            if (!cur || cur.status !== "approved") return;
            const q = await queueSteps(s, cur, readySteps(cur, await approvedSteps(s, cur)));
            if (q.ok && q.jobs.length) await savePlan(s, q.plan);
          },
          10,
          0,
        ),
      ),
  );
  return live;
}

const pending = (p: Plan) =>
  p.status === "approved" &&
  p.steps.some((st) => st.status === "waiting" || st.status === "queued" || st.status === "running");

/**
 * Takes the scope out of the tick's set when nothing of it waits, then reads again and puts it back when something does
 * (rule 4658): `enqueue` and `resumePlan` write their work before they add the scope, so a write racing this one is seen.
 */
async function settleScope(s: Scope): Promise<string> {
  await leaveQueue(s);
  const [jobs, plans] = await Promise.all([listQueued(s), recentPlans(s)]);
  if (jobs.length || plans.some(pending)) {
    await joinQueue(s);
    return "waiting";
  }
  return "idle";
}

/** One workspace's turn in the queue tick (see the file's comment). The answer is the batch outcome for this scope. */
export async function tickScope(u: User, deadline: number): Promise<string> {
  const s = sc(u);
  if (!v2On("QUEUE") || !v2On("PLANS")) {
    await leaveQueue(s);
    return "off";
  }
  const live = await advancePlans(s);
  const jobs = await listQueued(s);
  const now = Date.now();
  // One job of a workspace at a time: a fresh `running` job is another invocation's; an old one was killed and runs again.
  if (jobs.some((j) => j.status === "running" && now - Date.parse(j.ranAt ?? "") < PLAN_RUN_LOCK_S * 1000))
    return "busy";
  const job = jobs[0];
  if (!job) return live.some(pending) ? "waiting" : settleScope(s);
  if (deadline - Date.now() < BATCH_RUN_MIN_MS) return RETRY_LATE;
  return (await withPlanLock(s, job.plan, () => runJob(u, s, job, deadline), PLAN_RUN_LOCK_S, 0)) ?? "busy";
}

/** A step whose run stopped: the job ends, the step keeps the reason, and the plan pauses for the owner (Resume runs it again). */
async function stopStep(s: Scope, p: Plan, n: number, job: QueueJob, reason: string): Promise<void> {
  await Promise.all([
    finishJob(s, job, "failed", reason),
    savePlan(s, {
      ...withStep(p, n, { ...p.steps[n], status: "failed", job: undefined, reason, at: iso() }),
      status: "paused",
      reason,
    }),
  ]);
}

async function runJob(u: User, s: Scope, job: QueueJob, deadline: number): Promise<string> {
  const p = await getPlan(s, job.plan);
  const st = p?.steps[job.step];
  // The plan or the step moved on since the job was queued (cancelled, paused, already run): the job ends, nothing runs.
  if (
    !p ||
    !st ||
    p.status !== "approved" ||
    (st.status !== "queued" && st.status !== "running") ||
    st.job !== job.id
  ) {
    await finishJob(s, job, "cancelled", "stale");
    return "skip:stale";
  }
  const started = await startJob(s, job);
  if (!started) {
    await stopStep(s, p, job.step, { ...job, attempts: QUEUE_MAX_ATTEMPTS }, "attempts");
    return "failed:attempts";
  }
  const running = withStep(p, job.step, { ...st, status: "running", at: iso() });
  if (!(await savePlan(s, running))) {
    await finishJob(s, started, "cancelled", "gone");
    return "skip:gone";
  }
  const claim = planStepClaim(s, p.id, job.step);
  let r: BatchResult;
  try {
    // The step is marked done with its tasks inside the batch's refund guard (`commit`), with its `delivered` receipt, so a
    // run killed after its items are saved keeps its charge at the sweep and is never run again.
    r = await generateBatch(u, s, {
      deadline,
      type: st.type,
      leadBrief: leadBriefOf(p, job.step),
      source: "handoff",
      via: "handoff",
      by: p.approvedBy ?? p.requestedBy,
      once: claim,
      forcePending: true,
      plan: { id: p.id, step: job.step },
      selfCheck: true,
      commit: (tasks) => {
        const ids = tasks.map((t) => t.id);
        return Promise.all([
          savePlan(s, withStep(running, job.step, { ...st, status: "done", tasks: ids, job: undefined, at: iso() })),
          deliverRun(claim, STEP_RECEIPT_TTL_S, ids),
        ]);
      },
    });
  } catch (e) {
    // Unexpected (generateBatch refunds its own failures): the job waits for the next tick, within its attempts.
    await Promise.all([
      requeueJob(s, started, "error"),
      savePlan(s, withStep(running, job.step, { ...st, status: "queued", at: iso() })),
    ]).catch(() => {});
    throw e;
  }
  if (r.ok) {
    const done = withStep(running, job.step, {
      ...st,
      status: "done",
      tasks: r.tasks.map((t) => t.id),
      cost: r.cost,
      job: undefined,
      at: iso(),
    });
    await Promise.all([savePlan(s, done), finishJob(s, started, "done")]);
    return "done";
  }
  if (r.reason === "failed" && started.attempts < QUEUE_MAX_ATTEMPTS) {
    // Refunded by the batch: one more start on a later tick.
    await Promise.all([
      requeueJob(s, started, "failed"),
      savePlan(s, withStep(running, job.step, { ...st, status: "queued", at: iso() })),
    ]);
    return "failed:retry";
  }
  // Refused before any charge (credits, a cap, the trial, the model paused, no brand), or failed twice: the owner decides.
  await stopStep(s, running, job.step, started, r.reason);
  return "refused:" + r.reason;
}
