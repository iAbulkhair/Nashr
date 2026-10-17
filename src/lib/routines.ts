import { db } from "./db";
import { trialOver, type User } from "./auth";
import { monthKey } from "./credits";
import { TASK_COUNT, getBrand, isAutonomous, listLite, type Brand, type TaskLite, type TaskType } from "./brand";
import { BATCH_RUN_MIN_MS, generateBatch } from "./generate-batch";
import { modelState } from "./model";
import { getGov } from "./governance";
import { getSchedule, weekStartUtc, type Schedule } from "./schedule";
import { listDecisions } from "./decisions";
import { getSalesSnapshot } from "./store-sales";
import { missingData } from "./cart-recovery";
import { AD_PROVIDERS } from "./connectors/ads";
import { agentById, type AgentId } from "./agents";
import { notifyItem } from "./notifications";
import { pmap } from "./parallel";
import { appDict } from "./app-i18n";
import { actSkipKey, recordRun } from "./activity";
import { systemBy } from "./actor";
import { scopeParam, wsKey } from "./keys";

/**
 * Routines: recurring work for agents other than Noor's Sunday plan, each ON by default for every brand, added brands
 * included (rule 1486, the founder's decision of 2026-10-12, "on by default within plan caps"; before it they were off
 * until turned on). A routine the owner switched off stays off: only the owner's switch ever stores a `false`.
 *
 * Only agents with real input data have one; the rest get a routine when they have a data source. A routine never runs
 * on nothing: its gate checks, in code, that the input it needs is there (activity, a store sync, decisions), and
 * answers "idle" or "no_data" without charging; the next day's cron asks again. At most one run per period (the UTC
 * week from Sunday, or the UTC calendar month), recorded in its own key `routinelast:{scope}:{id}` so two routines
 * never race on one read-modify-write of the schedule.
 *
 * A run is paid work like a batch the owner asks for: the credits, the owning agent's monthly cap and the weekly cap on
 * scheduled items are all checked in code before the model is called, and a failed generation is refunded.
 */
export type RoutineId = "dana_weekly_report" | "noor_cart_recovery" | "razan_cash_forecast" | "majed_monthly_review";
export type Cadence = "weekly" | "monthly";
/** What a gate sees: the rows of the last 35 days are read once by the runner and shared with the weekly-cap count. */
type GateCtx = { scope: string; last: string | null; lite: TaskLite[]; now: number };
/** null when the routine has something to work from; otherwise the non-retry outcome, and nothing is charged. */
type Gate = (c: GateCtx) => Promise<null | "idle" | "no_data">;
export type Routine = { id: RoutineId; agent: AgentId; type: TaskType; cadence: Cadence; gate: Gate };

const DAY = 864e5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newer =(iso: string | null | undefined, from: number) => !!iso && Date.parse(iso) >= from;

/**
 * When someone in the workspace last pressed Refresh on the site or social results (`sync_site`, `sync_social`), as an
 * ISO time. The daily cron's reads of those results never write it, so they never wake Dana's routine for an owner who
 * is away (rule 736). Eight days: the gate looks back seven. `wipeAccount` deletes it.
 */
export const OWNER_SYNC_KEY = (scope: string) => `ownersync:${scope}`;
const OWNER_SYNC_TTL_S = 8 * 86400;
export async function markOwnerSync(scope: string, now: Date = new Date()): Promise<void> {
  await db.set(OWNER_SYNC_KEY(scope), now.toISOString(), OWNER_SYNC_TTL_S);
}

/**
 * Dana: something happened in the last 7 days. Items the weekly plan, a routine or Majed's auto-run created on their
 * own (`isAutonomous`) do not count, or the team would keep itself busy for an owner who is away; a decision on one does.
 * A store sync and an ad-account read count as they always have; of the site and social results only a person's
 * Refresh click counts (`ownersync`), never the daily read (rule 736).
 */
async function activity(c: GateCtx) {
  const from = c.now - 7 * DAY;
  if (c.lite.some((l) => (!isAutonomous(l) && newer(l.createdAt, from)) || newer(l.decidedAt, from))) return null;
  const [decided, snap, ads, owner] = await Promise.all([
    listDecisions(c.scope, 1),
    getSalesSnapshot(c.scope),
    Promise.all(AD_PROVIDERS.map((p) => db.get<string>(wsKey.adSync(scopeParam(c.scope), p)))),
    db.get<string>(OWNER_SYNC_KEY(c.scope)),
  ]);
  return newer(decided[0]?.at, from) || newer(snap?.at, from) || ads.some((a) => newer(a, from)) || newer(owner, from) ? null : "idle";
}

/** Noor: the store has abandoned-cart data (`missingData`), synced after this routine last ran. */
async function newCarts(c: GateCtx) {
  const [missing, snap] = await Promise.all([missingData("cart_recovery", c.scope), getSalesSnapshot(c.scope)]);
  if (missing || !snap) return "no_data";
  return c.last && !(Date.parse(snap.at) > Date.parse(c.last)) ? "idle" : null;
}

/** Razan: a store sales snapshot from the last 35 days, which `statsFor` hands her as STORE DATA. */
async function freshSales(c: GateCtx) {
  const snap = await getSalesSnapshot(c.scope);
  return snap && Date.parse(snap.at) >= c.now - 35 * DAY ? null : "no_data";
}

/**
 * Majed: the owner decided at least 3 different items in the last 30 days. The decision records are new, so the light
 * index's `decidedAt` counts too; an item is counted once whichever of the two holds it.
 */
async function decisionsMade(c: GateCtx) {
  const from = c.now - 30 * DAY;
  const ds = await listDecisions(c.scope);
  const items = new Set([...ds.filter((d) => newer(d.at, from)).map((d) => d.task), ...c.lite.filter((l) => newer(l.decidedAt, from)).map((l) => l.id)]);
  return items.size >= 3 ? null : "idle";
}

export const ROUTINES: Routine[] = [
  { id: "dana_weekly_report", agent: "dana", type: "weekly_report", cadence: "weekly", gate: activity },
  { id: "noor_cart_recovery", agent: "noor", type: "cart_recovery", cadence: "weekly", gate: newCarts },
  { id: "razan_cash_forecast", agent: "razan", type: "cash_forecast", cadence: "monthly", gate: freshSales },
  { id: "majed_monthly_review", agent: "majed", type: "strategy_review", cadence: "monthly", gate: decisionsMade },
];
export const ROUTINE_IDS = ROUTINES.map((r) => r.id);
/** Membership test for an id from a request body. Not `in`, which walks the prototype chain. */
export const isRoutineId = (v: unknown): v is RoutineId => typeof v === "string" && (ROUTINE_IDS as string[]).includes(v);

/**
 * Is this routine on for the brand (rule 1486)? On unless the owner switched it off: a missing switch (never touched,
 * every account before 2026-10-12 included) is on, a stored `false` is off. The caps are not loosened by it: every run
 * still passes the trial, the gate, the weekly cap, the agent's monthly cap and the credits in code before any charge.
 */
export const routineOn = (s: Pick<Schedule, "routines">, id: RoutineId): boolean => s.routines?.[id] !== false;

/** What the Scheduled tasks page shows per routine; the page renders it on the server. */
export type RoutineView = { id: RoutineId; agent: AgentId; type: TaskType; cadence: Cadence; last?: string };

const lastKey = (scope: string, id: RoutineId) => `routinelast:${scope}:${id}`;
const lockKey = (scope: string, id: RoutineId) => `routinelock:${scope}:${id}`;
/** Held for the few reads of the weekly-cap check, so a brand's routines reserve their batches one at a time. */
const capLockKey = (scope: string) => `routinecap:${scope}`;
/** A batch that passed the weekly-cap check and is not saved yet, counted by the brand's other routines. */
const holdKey = (scope: string, id: RoutineId) => `routinehold:${scope}:${id}`;
/**
 * The same hold for Majed's auto-run (src/lib/handoff-auto.ts), which draws on the same weekly cap and runs in the same
 * cron as the routines. Its own key, deleted by `wipeAccount`.
 */
export const autoHoldKey = (scope: string) => `handoffhold:${scope}`;
/** Every hold a brand can have: one per routine, and the auto-run's. */
const holdKeys = (scope: string) => [...ROUTINE_IDS.map((id) => holdKey(scope, id)), autoHoldKey(scope)];
/** Charges of one routine in one period that were neither refunded nor refused (see `routineFor`). */
const tryKey = (scope: string, id: RoutineId, period: string) => `routinetry:${scope}:${id}:${period}`;
/** The notification fingerprint of a run, one per routine and period. */
const runFingerprint = (scope: string, id: RoutineId, period: string) => `routine:${scope}:${id}:${period}`;
/** How long a period's records live: a week and a day, or a month and a few days. */
const periodDays = (cadence: Cadence) => (cadence === "weekly" ? 8 : 35);
/** Unsettled charges a routine may leave in one period before it waits for the next. */
const MAX_UNSETTLED = 2;

/** The period a run belongs to: the Sunday that starts the UTC week, or the UTC month. */
export const periodOf = (cadence: Cadence, now: Date = new Date()) => (cadence === "weekly" ? weekStartUtc(now) : monthKey(now));
export const ranThisPeriod = (cadence: Cadence, last: string | null | undefined, now: Date = new Date()) =>
  !!last && last.slice(0, cadence === "weekly" ? 10 : 7) >= periodOf(cadence, now);
/** This period and the `back` before it (one by default): records of an earlier period live on for up to `periodDays`. */
function recentPeriods(cadence: Cadence, now = new Date(), back = 1) {
  return Array.from({ length: back + 1 }, (_, i) => periodOf(cadence, cadence === "weekly" ? new Date(now.getTime() - 7 * i * DAY) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
}
/** Every key the routines keep for one brand scope, for `wipeAccount`. */
export const routineKeys = (scope: string) => [
  capLockKey(scope),
  ...ROUTINES.flatMap((r) => [lastKey(scope, r.id), lockKey(scope, r.id), holdKey(scope, r.id), ...recentPeriods(r.cadence).map((p) => tryKey(scope, r.id, p))]),
];
/**
 * The "nothing new" markers of the activity log (`recordRun`) that can still be alive for one brand scope, for
 * `wipeAccount`. A marker lives `periodDays` from the first idle day of its period, so one set on a period's last day
 * outlives the next period: 35 days from 31 August is 5 October. Three periods cover it (the month or week after next
 * starts later than any marker of the first can live).
 */
export const routineSkipKeys = (scope: string) => ROUTINES.flatMap((r) => recentPeriods(r.cadence, new Date(), 2).map((p) => actSkipKey(scope, r.id, p)));
/** The run notifications' fingerprints that can still be alive for one brand scope, for `wipeAccount`. */
export const routineFingerprints = (scope: string) => ROUTINES.flatMap((r) => recentPeriods(r.cadence).map((p) => runFingerprint(scope, r.id, p)));

/** The last run of every routine in one scope, in one round. */
export async function routineLastRuns(scope: string): Promise<Partial<Record<RoutineId, string>>> {
  const last = await Promise.all(ROUTINE_IDS.map((id) => db.get<string>(lastKey(scope, id))));
  return Object.fromEntries(ROUTINE_IDS.flatMap((id, i) => (last[i] ? [[id, last[i]]] : [])));
}

/**
 * The cron's items: every (user, active brand) routine that is on and has not run in its period. Schedules are read
 * for everyone in parallel, and last runs only for the routines that are on.
 */
export async function dueRoutines(users: User[], now: Date = new Date()): Promise<{ user: User; id: RoutineId }[]> {
  const groups = await pmap(users, async (u) => {
    const scope = u.scope ?? u.email;
    const sched = await getSchedule(scope);
    const on = ROUTINES.filter((r) => routineOn(sched, r.id));
    if (!on.length) return [];
    const last = await Promise.all(on.map((r) => db.get<string>(lastKey(scope, r.id))));
    return on.filter((r, i) => !ranThisPeriod(r.cadence, last[i], now)).map((r) => ({ user: u, id: r.id }));
  });
  return groups.flat();
}

/** The owner-notes line of a routine's batch; the judge is given the same text the agent was. */
const routineNote = (r: Routine) =>
  `This is an automatic ${r.cadence} routine that is on in Scheduled tasks; nobody wrote notes for this batch. Build it only on the data blocks and memory files given.`;

/**
 * One routine for one brand scope. Only "retry:paused", "retry:locked" and "retry:late" start with "retry": they leave
 * the cron's day open. Every other outcome, "idle", "no_data" and "attempts_exhausted" included, is final for the day and
 * charges nothing unless it is "ok:N". Missed days catch up by themselves: the daily cron asks again, and the period
 * check here decides.
 *
 * `deadline` is when the cron's invocation ends. With less than BATCH_RUN_MIN_MS of it left the routine answers
 * "retry:late" before the weekly-cap hold, the attempt counter and the charge: a batch the platform kills after the
 * charge keeps it and saves nothing, and "retry:late" hands the routine to the chain's next hop (src/lib/cron-batch.ts).
 * The same deadline bounds the batch's cross-agent review.
 */
export async function runRoutine(user: User, id: RoutineId, deadline?: number): Promise<string> {
  const r = ROUTINES.find((x) => x.id === id);
  if (!r) return "unknown_routine";
  const scope = user.scope ?? user.email;
  const [brand, sched, last] = await Promise.all([getBrand(scope), getSchedule(scope), db.get<string>(lastKey(scope, id))]);
  if (!brand) return "no_brand";
  if (!routineOn(sched, id)) return "off";
  if (ranThisPeriod(r.cadence, last)) return "already_this_period";
  // Before any charge. Without a key the output would be placeholders, which must never be charged for.
  const state = modelState();
  if (state === "paused") return "retry:paused";
  if (state === "mock") return "skip:mock";
  if (!(await db.lock(lockKey(scope, id), 300))) return "retry:locked";
  // What happened, for the activity log; a throw is "error" (the charge was refunded first, see routineFor).
  let outcome = "error";
  try {
    outcome = await routineFor(user, scope, brand, r, deadline);
    return outcome;
  } finally {
    // The hold goes only after the batch is saved: until then the brand's other routines count it, and after it the items.
    await Promise.all([
      db.del(holdKey(scope, id)),
      db.unlock(lockKey(scope, id)),
      recordRun(scope, { id, agent: r.agent, type: r.type, via: "routine", by: systemBy("routine"), period: periodOf(r.cadence), ttlS: periodDays(r.cadence) * 86400 }, outcome),
    ]);
  }
}

/**
 * The weekly cap counts everything created on its own in 7 days (`isAutonomous`: the Sunday plan, the routines and
 * Majed's auto-run), plus this whole batch, plus the batches the brand's other routines or the auto-run are making
 * right now. The cron runs a brand's routines and its auto-run side by side and each saves its items only after a
 * generation of 30-120 s, so a count of saved items alone let two of them pass on the same number. The check and the
 * hold are made one batch at a time under a short lock per brand; holds are read before the items, and a run drops its
 * hold only after its items are saved, so every batch is counted in one of the two.
 *
 * `hold` is the key this batch holds its place with (a routine's `routinehold:`, or `autoHoldKey`), `count` its items.
 */
export async function holdBatch(scope: string, hold: string, count: number, cap: number): Promise<null | "cap_reached" | "retry:locked"> {
  const key = capLockKey(scope);
  let got = false;
  for (let i = 0; i < 40 && !got; i++) {
    got = await db.lock(key, 10);
    if (!got) await sleep(50);
  }
  if (!got) return "retry:locked";
  try {
    const holds = await Promise.all(holdKeys(scope).filter((k) => k !== hold).map((k) => db.get<number>(k)));
    const now = Date.now();
    const lite = await listLite(scope, new Date(now - 7 * DAY));
    const auto = lite.filter((t) => isAutonomous(t) && newer(t.createdAt, now - 7 * DAY)).length + holds.reduce<number>((n, h) => n + (Number(h) || 0), 0);
    if (auto + count > cap) return "cap_reached";
    await db.set(hold, count, 360); // outlives a run's 300 s limit, then goes by itself
    return null;
  } finally {
    await db.unlock(key);
  }
}

async function routineFor(user: User, scope: string, brand: Brand, r: Routine, deadline?: number): Promise<string> {
  if (trialOver(user)) return "trial_over";
  const now = Date.now();
  // The last run is read again under the lock: a run that finished between the check above and the lock has set it.
  const [last, gov, lite] = await Promise.all([db.get<string>(lastKey(scope, r.id)), getGov(scope), listLite(scope, new Date(now - 35 * DAY))]);
  if (ranThisPeriod(r.cadence, last)) return "already_this_period";
  const gate = await r.gate({ scope, last, lite, now });
  if (gate) return gate;
  // Before the hold and the charge: a batch started this late could be killed after it is charged.
  if (deadline !== undefined && deadline - Date.now() < BATCH_RUN_MIN_MS) return "retry:late";
  const held = await holdBatch(scope, holdKey(scope, r.id), TASK_COUNT[r.type], gov.weeklyCap);
  if (held) return held;
  // A platform timeout kills a run without throwing: its charge is neither refunded nor turned into items, no last run
  // is recorded, and the cron's own attempt count starts again every day. So every charge is counted per routine and
  // period before it is made and given back when it is refused or refunded, and after two that were neither, the
  // routine waits for its next period instead of being charged again every day.
  const tries = tryKey(scope, r.id, periodOf(r.cadence, new Date(now)));
  const ttl = periodDays(r.cadence) * 86400;
  const attempt = await db.incrby(tries, 1);
  await db.set(tries, attempt, ttl); // incrby alone leaves the counter without an expiry
  if (attempt > MAX_UNSETTLED) return "attempts_exhausted";
  const settle = () => db.set(tries, attempt - 1, ttl);
  const note = routineNote(r);
  // Charged to the agent that owns the type (r.agent, pinned equal in tests/routines.test.ts), under its cap; a refusal
  // or a refund settles the attempt above.
  const b = await generateBatch(user, scope, { type: r.type, notes: note, brief: r.id, source: "scheduled", via: "routine", gov, brand, settle, ...(deadline !== undefined ? { deadline } : {}) });
  if (!b.ok) {
    if (b.reason === "failed") throw b.error;
    return b.reason === "paused" ? "retry:paused" : b.reason === "missing_data" ? "no_data" : b.reason;
  }
  const created = b.tasks;
  await db.set(lastKey(scope, r.id), new Date().toISOString());
  // The batch is saved and paid for by now, so an unexpected language on an old record must not throw here.
  const ul = user.lang === "en" ? "en" : "ar";
  const ar = ul === "ar";
  const name = agentById(r.agent).name[ul];
  const label = appDict[ul].generate.types[r.type].t;
  await notifyItem(user.email, ul, {
    kind: "pending",
    agent: r.agent,
    title: ar ? `${label} من ${name} في صندوق الموافقة` : `${label} from ${name} is in your inbox`,
    body: ar ? `${created.length} عنصر من مهمة دورية مفعّلة في المهام المجدولة. راجعه واعتمد ما يناسبك.` : `${created.length} item(s) from a routine that is on in Scheduled tasks. Review them and approve what fits.`,
    href: "",
  }, runFingerprint(scope, r.id, periodOf(r.cadence)), periodDays(r.cadence));
  return `ok:${created.length}`;
}
