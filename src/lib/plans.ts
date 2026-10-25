import { randomBytes } from "crypto";
import { db } from "./db";
import { agentForTask, type AgentId } from "./agents";
import { TASK_COST, TASK_TYPES, type TaskType } from "./tasks";
import { isBy, type By } from "./actor";
import { log } from "./log";
import { globalKey, runClaim, wsKey, type Scope } from "./keys";
import { cancelPlanJobs, enqueue, joinQueue, type QueueJob } from "./queue";

/**
 * Goals and plans (Thakeen v2 phase 2, C3, rules 4620-4649; docs/system/tests/4620-v2-plans.md). Off in this release
 * (`PLANS`, src/lib/v2-flags.ts): Majed offers no `make_plan` tool and the plan routes answer 404.
 *
 * Majed, as the lead, turns a goal the owner states into up to `PLAN_MAX_STEPS` steps in his own chat turn (the tool's
 * input, src/lib/plan-tool.ts): each step a task type, a brief, and the earlier steps it waits for. Code sets everything
 * else: the agent who owns the type, its cost (`TASK_COST`), the total, the status and the scope. Proposing charges and
 * runs nothing. The owner's one Approve on the card (POST /api/plans/{id}) is the only approval: it checks in code that
 * the balance covers the total and that no agent's monthly cap is passed, then queues the steps that wait for nothing
 * (src/lib/queue.ts). Each step is charged when it runs, under its own claim (`runClaim.planStep`), so a step killed
 * after its charge is never charged twice. A step whose earlier steps are done and whose items the owner approved is
 * queued by the next tick (src/lib/plan-run.ts); a rejected item leaves its later steps waiting, for the owner to cancel
 * or to approve a rewrite. Every item a step makes waits in the inbox (`forcePending`).
 *
 * Keys, all under the caller's own scope (`sc(u)`): the record `goalplan:{scope}:{id}` (90 days from its last write),
 * the index `goalplans:{scope}` (the `PLANS_KEEP` newest; one pushed past it leaves with its record), the lock
 * `goalplanlock:{scope}:{id}` and the day's bucket of proposals `goalplan-day:{scope}`.
 */

export const PLAN_MIN_STEPS = 2;
export const PLAN_MAX_STEPS = 8;
/** The goal and a step's brief together fit one `<lead_brief>` block (`LEAD_BRIEF_MAX`, 600, src/lib/json.ts). */
export const PLAN_GOAL_MAX = 200;
export const PLAN_BRIEF_MAX = 360;
/** A step waits for at most this many earlier steps. */
export const PLAN_AFTER_MAX = 3;
export const PLANS_KEEP = 20;
export const PLAN_TTL_S = 90 * 86400;
/** A proposal not approved within this many days can no longer be approved: Majed proposes it again with today's costs. */
export const PLAN_APPROVE_DAYS = 7;
/** Proposals a workspace may make in a day (rule 4626): each is free, so this bounds the records, not money. */
export const PLANS_PER_DAY = 10;
/** The step run's lock, held for the whole run like a handoff's (300 s, the cron route's `maxDuration`). */
export const PLAN_RUN_LOCK_S = 300;
const SHORT_LOCK_S = 10;

/** The types a plan step may be: every text task type, except Reem's, who owns none. Renders are made from an inbox item. */
export const PLAN_TYPES: readonly TaskType[] = TASK_TYPES.filter((t) => agentForTask(t).id !== "reem");
export const isPlanType = (v: unknown): v is TaskType =>
  typeof v === "string" && (PLAN_TYPES as readonly string[]).includes(v);
export const isPlanId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);

export type PlanStepStatus = "waiting" | "queued" | "running" | "done" | "failed" | "cancelled";
export type PlanStatus = "proposed" | "approved" | "paused" | "done" | "cancelled";
export type PlanStep = {
  type: TaskType;
  /** The agent who owns `type` (`agentForTask`), in code. */
  agent: AgentId;
  /** Majed's brief for this step: model-written, a request for work, never a source of figures. */
  brief: string;
  /** The earlier steps (0-based) this one waits for: always smaller than its own position, so a plan has no cycle. */
  after: number[];
  /** Credits: `TASK_COST[type]` when proposed, what the run charged once it is done. */
  cost: number;
  status: PlanStepStatus;
  /** The tasks the run made, when done. */
  tasks?: string[];
  /** The queue job that runs it, while queued. */
  job?: string;
  /** Why a step stopped (`failed`): a refusal code such as `no_credits`, or `attempts`. */
  reason?: string;
  at?: string;
};
export type Plan = {
  id: string;
  agent: "majed";
  goal: string;
  steps: PlanStep[];
  status: PlanStatus;
  /** The sum of the steps' costs when proposed: what the owner approves. */
  total: number;
  requestedBy: By;
  conv?: string;
  createdAt: string;
  approvedBy?: By;
  approvedAt?: string;
  /** Why the plan stopped running: `paused` by the owner, or a step's refusal (`no_credits`, `agent_cap`). */
  reason?: string;
  at: string;
};

const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f​‪-‮⁦-⁩]/g;
const clean = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(HIDDEN, "").trim().slice(0, max).trim() : "";
const convOf = (conv: string | undefined) =>
  typeof conv === "string" && /^[a-f0-9]{6,16}$/.test(conv) ? conv : undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The reply's action naming the plan card (`goalplan:{id}`), read back by `turnParts` (src/lib/chat-reply.ts). */
export const planAction = (id: string) => "goalplan:" + id;
/** The claim a step is charged under: a run killed after its charge reuses its hold (`chargeOnce`). */
export const planStepClaim = (s: Scope, id: string, n: number) => runClaim.planStep(s, id, n);

export type PlanDraft = { goal: string; steps: { type: TaskType; brief: string; after: number[] }[] };
export type PlanParseError = "no_goal" | "steps" | "bad_type" | "own_type" | "no_brief" | "bad_after";

/**
 * Majed's tool input as a draft, or why not. Code gates, not prompt rules: 2 to 8 steps, each a plan type with a brief;
 * `after` names only EARLIER steps (no cycle, no self-wait), at most `PLAN_AFTER_MAX`, duplicates dropped. Text is
 * stripped of hidden characters and cut to its limit.
 */
export function parsePlan(
  input: Record<string, unknown>,
): { ok: true; draft: PlanDraft } | { ok: false; error: PlanParseError } {
  const goal = clean(input.goal, PLAN_GOAL_MAX);
  if (!goal) return { ok: false, error: "no_goal" };
  const raw = input.steps;
  if (!Array.isArray(raw) || raw.length < PLAN_MIN_STEPS || raw.length > PLAN_MAX_STEPS)
    return { ok: false, error: "steps" };
  const steps: PlanDraft["steps"] = [];
  for (const [i, v] of raw.entries()) {
    const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    if (!isPlanType(o.type))
      return {
        ok: false,
        error:
          typeof o.type === "string" && (TASK_TYPES as readonly string[]).includes(o.type) ? "own_type" : "bad_type",
      };
    const brief = clean(o.brief, PLAN_BRIEF_MAX);
    if (!brief) return { ok: false, error: "no_brief" };
    const after = o.after === undefined ? [] : o.after;
    if (
      !Array.isArray(after) ||
      after.length > PLAN_AFTER_MAX ||
      !after.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < i)
    )
      return { ok: false, error: "bad_after" };
    steps.push({ type: o.type, brief, after: [...new Set(after as number[])].sort((a, b) => a - b) });
  }
  return { ok: true, draft: { goal, steps } };
}

const stepStatuses: readonly PlanStepStatus[] = ["waiting", "queued", "running", "done", "failed", "cancelled"];
const planStatuses: readonly PlanStatus[] = ["proposed", "approved", "paused", "done", "cancelled"];

/** A stored record as a `Plan`, or null when it is not one: every field the code relies on is checked, the rest dropped. */
export function readPlan(v: unknown, id: string): Plan | null {
  const p = v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<Plan>) : null;
  if (
    !p ||
    p.id !== id ||
    typeof p.goal !== "string" ||
    !Array.isArray(p.steps) ||
    !planStatuses.includes(p.status as PlanStatus) ||
    !isBy(p.requestedBy)
  )
    return null;
  const steps: PlanStep[] = [];
  for (const [i, x] of (p.steps as unknown[]).entries()) {
    const s = x && typeof x === "object" ? (x as Partial<PlanStep>) : null;
    if (!s || !isPlanType(s.type) || typeof s.brief !== "string" || !stepStatuses.includes(s.status as PlanStepStatus))
      return null;
    const after = Array.isArray(s.after)
      ? s.after.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < i)
      : [];
    steps.push({
      ...s,
      type: s.type,
      agent: agentForTask(s.type).id,
      brief: s.brief,
      after,
      cost: typeof s.cost === "number" && Number.isFinite(s.cost) ? s.cost : TASK_COST[s.type],
      status: s.status as PlanStepStatus,
      ...(Array.isArray(s.tasks) ? { tasks: s.tasks.filter((t): t is string => typeof t === "string") } : {}),
    });
  }
  if (steps.length < 1 || steps.length > PLAN_MAX_STEPS) return null;
  return {
    ...(p as Plan),
    steps,
    total: typeof p.total === "number" && Number.isFinite(p.total) ? p.total : steps.reduce((n, s) => n + s.cost, 0),
  };
}

/** One plan of the caller's scope, or null (a malformed id builds no key). */
export async function getPlan(s: Scope, id: string): Promise<Plan | null> {
  return isPlanId(id) ? readPlan(await db.get<unknown>(wsKey.goalPlan(s, id)), id) : null;
}

/** The newest plans of the scope, newest first, in two requests. */
export async function recentPlans(s: Scope): Promise<Plan[]> {
  const ids = (await db.lrange(wsKey.goalPlans(s), 0, PLANS_KEEP - 1)).filter(isPlanId);
  if (!ids.length) return [];
  const rows = await db.mget<unknown>(ids.map((id) => wsKey.goalPlan(s, id)));
  return rows.flatMap((r, i) => {
    const p = readPlan(r, ids[i]);
    return p ? [p] : [];
  });
}

/** The plan's status from its steps: `done` once every step is done or cancelled and at least one is done. */
function settledStatus(p: Plan): PlanStatus {
  if (p.status !== "approved") return p.status;
  return p.steps.every((s) => s.status === "done" || s.status === "cancelled") &&
    p.steps.some((s) => s.status === "done")
    ? "done"
    : "approved";
}

/** Rewrites a record that exists (SET XX): false when it is gone, so nothing brings a plan back outside its index. */
export const savePlan = (s: Scope, p: Plan) =>
  db.setXx(wsKey.goalPlan(s, p.id), { ...p, status: settledStatus(p), at: new Date().toISOString() }, PLAN_TTL_S);
export const withStep = (p: Plan, n: number, st: PlanStep): Plan => ({
  ...p,
  steps: p.steps.map((x, i) => (i === n ? st : x)),
});

/** Saves a new proposal and its index entry. Charges nothing and queues nothing. */
export async function createPlan(s: Scope, d: PlanDraft, o: { requestedBy: By; conv?: string }): Promise<Plan> {
  const id = randomBytes(8).toString("hex");
  const at = new Date().toISOString();
  const steps: PlanStep[] = d.steps.map((x) => ({
    type: x.type,
    agent: agentForTask(x.type).id,
    brief: x.brief,
    after: x.after,
    cost: TASK_COST[x.type],
    status: "waiting",
  }));
  const { kind, email, role, imp, job } = o.requestedBy;
  const requestedBy: By = {
    kind,
    ...(email ? { email } : {}),
    ...(role ? { role } : {}),
    ...(imp ? { imp } : {}),
    ...(job ? { job } : {}),
  };
  const conv = convOf(o.conv);
  const p: Plan = {
    id,
    agent: "majed",
    goal: d.goal,
    steps,
    status: "proposed",
    total: steps.reduce((n, x) => n + x.cost, 0),
    requestedBy,
    ...(conv ? { conv } : {}),
    createdAt: at,
    at,
  };
  await Promise.all([
    db.set(wsKey.goalPlan(s, id), p, PLAN_TTL_S),
    db.lpush(wsKey.goalPlans(s), id),
    db.expire(wsKey.goalPlans(s), PLAN_TTL_S),
  ]);
  // Read after this push and removed by value, as `evictOverflow` in handoffs.ts does: two proposals at once each drop what they pushed off.
  const over = await db.lrange(wsKey.goalPlans(s), PLANS_KEEP, -1);
  if (over.length)
    await Promise.all([
      ...over.map((v) => db.lrem(wsKey.goalPlans(s), v)),
      ...over.filter(isPlanId).flatMap((old) => [db.del(wsKey.goalPlan(s, old)), db.del(wsKey.goalPlanLock(s, old))]),
    ]);
  return p;
}

/** Runs `fn` holding the plan's short lock, waited for briefly (an owner's action); null when it stays busy (a step is running). */
export async function withPlanLock<T>(
  s: Scope,
  id: string,
  fn: () => Promise<T>,
  ttlS = SHORT_LOCK_S,
  waitMs = 1000,
): Promise<T | null> {
  if (!isPlanId(id)) return null;
  const lk = wsKey.goalPlanLock(s, id);
  let got = await db.lock(lk, ttlS);
  for (let waited = 0; !got && waited < waitMs; waited += 50) {
    await sleep(50);
    got = await db.lock(lk, ttlS);
  }
  if (!got) return null;
  try {
    return await fn();
  } finally {
    await db.unlock(lk).catch((e) => log.error("plan lock release failed", e));
  }
}

/** The steps whose earlier steps are all `done` and whose items the owner approved (`approved` names the done steps that qualify). */
export function readySteps(p: Plan, approved: ReadonlySet<number>): number[] {
  return p.steps.flatMap((st, i) => (st.status === "waiting" && st.after.every((a) => approved.has(a)) ? [i] : []));
}

/** Queues the given steps of `p` and marks them `queued` with their job. Refused whole when the queue is full. */
export async function queueSteps(
  s: Scope,
  p: Plan,
  steps: readonly number[],
): Promise<{ ok: true; plan: Plan; jobs: QueueJob[] } | { ok: false; error: "queue_full" }> {
  if (!steps.length) return { ok: true, plan: p, jobs: [] };
  const q = await enqueue(
    s,
    steps.map((n) => ({ kind: "plan_step" as const, plan: p.id, step: n })),
  );
  if (!q.ok) return q;
  let next = p;
  q.jobs.forEach((j) => {
    next = withStep(next, j.step, { ...next.steps[j.step], status: "queued", job: j.id });
  });
  return { ok: true, plan: next, jobs: q.jobs };
}

export type PlanActionError =
  | "not_found"
  | "busy"
  | "expired"
  | "not_proposed"
  | "not_running"
  | "not_paused"
  | "finished"
  | "queue_full";

/** Pauses an approved plan: its waiting jobs leave the queue and the steps they held wait again. A running step finishes. */
export async function pausePlan(
  s: Scope,
  id: string,
): Promise<{ ok: true; plan: Plan } | { ok: false; error: PlanActionError }> {
  return (
    (await withPlanLock(s, id, async () => {
      const p = await getPlan(s, id);
      if (!p) return { ok: false as const, error: "not_found" as const };
      if (p.status !== "approved") return { ok: false as const, error: "not_running" as const };
      await cancelPlanJobs(s, id, "paused");
      const next: Plan = {
        ...p,
        status: "paused",
        reason: "paused",
        steps: p.steps.map((st) => (st.status === "queued" ? { ...st, status: "waiting", job: undefined } : st)),
      };
      return (await savePlan(s, next))
        ? { ok: true as const, plan: next }
        : { ok: false as const, error: "not_found" as const };
    })) ?? { ok: false, error: "busy" }
  );
}

/** Resumes a paused plan: the next tick queues its ready steps (the scope rejoins the tick's set). */
export async function resumePlan(
  s: Scope,
  id: string,
): Promise<{ ok: true; plan: Plan } | { ok: false; error: PlanActionError }> {
  return (
    (await withPlanLock(s, id, async () => {
      const p = await getPlan(s, id);
      if (!p) return { ok: false as const, error: "not_found" as const };
      if (p.status !== "paused") return { ok: false as const, error: "not_paused" as const };
      const next: Plan = {
        ...p,
        status: "approved",
        reason: undefined,
        steps: p.steps.map((st) => (st.status === "failed" ? { ...st, status: "waiting", reason: undefined } : st)),
      };
      if (!(await savePlan(s, next))) return { ok: false as const, error: "not_found" as const };
      await joinQueue(s);
      return { ok: true as const, plan: next };
    })) ?? { ok: false, error: "busy" }
  );
}

/** Cancels a plan that has not finished: nothing more of it runs. Items already made stay in the inbox. */
export async function cancelPlan(
  s: Scope,
  id: string,
): Promise<{ ok: true; plan: Plan } | { ok: false; error: PlanActionError }> {
  return (
    (await withPlanLock(s, id, async () => {
      const p = await getPlan(s, id);
      if (!p) return { ok: false as const, error: "not_found" as const };
      if (p.status === "done" || p.status === "cancelled") return { ok: false as const, error: "finished" as const };
      await cancelPlanJobs(s, id, "cancelled");
      const next: Plan = {
        ...p,
        status: "cancelled",
        steps: p.steps.map((st) =>
          st.status === "waiting" || st.status === "queued" || st.status === "failed"
            ? { ...st, status: "cancelled", job: undefined }
            : st,
        ),
      };
      return (await savePlan(s, next))
        ? { ok: true as const, plan: next }
        : { ok: false as const, error: "not_found" as const };
    })) ?? { ok: false, error: "busy" }
  );
}

/** What the card shows: the plan without who asked for it beyond their kind. */
export type PlanView = Pick<Plan, "id" | "goal" | "status" | "total" | "createdAt" | "reason"> & {
  steps: Pick<PlanStep, "type" | "agent" | "brief" | "after" | "cost" | "status" | "tasks" | "reason">[];
  expired: boolean;
};
export function planView(p: Plan, now = Date.now()): PlanView {
  return {
    id: p.id,
    goal: p.goal,
    status: p.status,
    total: p.total,
    createdAt: p.createdAt,
    ...(p.reason ? { reason: p.reason } : {}),
    steps: p.steps.map(({ type, agent, brief, after, cost, status, tasks, reason }) => ({
      type,
      agent,
      brief,
      after,
      cost,
      status,
      ...(tasks ? { tasks } : {}),
      ...(reason ? { reason } : {}),
    })),
    expired: p.status === "proposed" && now - Date.parse(p.createdAt) > PLAN_APPROVE_DAYS * 864e5,
  };
}

/** Every key of every plan of the scope for `wipeAccount`: each plan's record, lock and step receipts, then the index and the bucket. The jobs are `queueKeys`'. */
export async function planKeys(s: Scope): Promise<string[]> {
  const ids = (await db.lrange(wsKey.goalPlans(s), 0, -1)).filter(isPlanId);
  const steps = Array.from({ length: PLAN_MAX_STEPS }, (_, n) => n);
  return [
    ...ids.flatMap((id) => [
      wsKey.goalPlan(s, id),
      wsKey.goalPlanLock(s, id),
      ...steps.map((n) => globalKey.runReceipt(planStepClaim(s, id, n))),
    ]),
    wsKey.goalPlans(s),
    globalKey.rate(wsKey.goalPlanBucket(s)),
  ];
}
