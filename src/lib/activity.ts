import { CAPS, db, pushCapped } from "./db";
import { isAgentId, type AgentId } from "./agents";
import { isTaskType, type TaskType } from "./tasks";
import { isBy, publicBy, type By } from "./actor";
import { log } from "./log";
import { after } from "next/server";
import { pushForActivity, pushOn } from "./push";

/**
 * The per-agent activity log: what each agent did in one brand, and what was done to its work, newest first in
 * `activity:{scope}` (capped at CAPS.activity). One row per action, and one per batch, never one per item: a batch of
 * ten posts is a single `generated` row that names up to ten task ids.
 *
 * Every field is set in code by the action that happened: `agent` from `agentForTask` or the job the server stored,
 * `by` from the session (`byOf`, src/lib/actor.ts) or the system job, `via` from the path. `note` is the only free
 * text (a title, a file name, a brand field, the changed settings): data, never instructions, rendered as text and
 * escaped in the CSV. The scope is always the caller's own (`sc(u)`, or the scope the server stored on a job).
 *
 * Recording never gets in the way of the action: `recordActivity` catches and logs every failure, and callers add it to
 * the Promise.all they already have. Rows are read by one lrange and sorted by `at`, because rows pushed together over
 * HTTP land in any order.
 */
export const ACTIVITY_KINDS = [
  "generated", "judged", "autofail", "published", "decision", "image_started", "render_done", "render_failed", "routine_ran", "routine_skipped",
  "cap_reached", "no_credits", "external_draft", "brand_changed", "file_written", "gov_changed", "gov_rollback", "onboard_charged", "onboard_refunded",
  "cross_reviewed",
  // Paid scheduled work (rules 2475, 2478): a run killed after it began, held for the owner; a charge the daily sweep gave back.
  "run_held", "run_refunded",
  // Majed's handoffs (src/lib/handoffs.ts): the proposal in chat, an item run from its card, items declined.
  "handoff_proposed", "handoff_run", "handoff_declined",
  // A connection setting the owner changed that decides where posts go (LinkedIn: as the member or as the page).
  "connector_changed",
  // A brand's agent instructions went live, were restored or applied from chat (src/lib/instructions-store.ts); `note` is "v<n>", never the text.
  "instructions_changed",
  // A paid "test this instruction" (src/app/api/instructions/test/route.ts): `credits` is what was taken, `count` the two items written.
  "instructions_tested",
  // Line notes on a draft sent in one revision (src/lib/revise.ts, rule 2496): `credits` is the draft's price, `count` the notes.
  "revised",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
/** Where it happened. Not a task's `source`: chat and MCP batches are both `source: "chat"`. */
export const ACTIVITY_VIAS = ["app", "chat", "mcp", "weekly", "routine", "handoff", "cron", "media"] as const;
export type ActivityVia = (typeof ACTIVITY_VIAS)[number];

export type Activity = {
  at: string;
  kind: ActivityKind;
  /**
   * The agent whose work it is (`agentForTask`, a job's stored `spend.agent`, the talking agent in chat, Noor for an added
   * brand's setup and the hold's agent for its sweep refund); absent for account-level rows.
   */
  agent?: AgentId;
  by: By;
  via: ActivityVia;
  type?: TaskType;
  /** Up to ten task ids. */
  tasks?: string[];
  count?: number;
  /**
   * Charged (generated, image_started, onboard_charged), not charged (cap_reached, no_credits: what it would have cost;
   * handoff_proposed: what every item would cost), given back (onboard_refunded), or the render's price (render_*).
   */
  credits?: number;
  /**
   * A code-made result: a provider, a decision action, a routine outcome, a failure reason, "spent/cap", a cross review's
   * "flags:N", a handoff's `handoff:{id}` (proposed, declined), or a handoff item's run, `done:{id}:{n}` or `failed:{id}:{n}`.
   */
  outcome?: string;
  score?: number;
  autofail?: string;
  /** Up to 200 characters of untrusted text. */
  note?: string;
  media?: "image" | "video";
  /** render_failed: whether the credits went back; onboard_refunded: always true. */
  refunded?: boolean;
};

export const ACTIVITY_MAX_TASKS = 10;
export const ACTIVITY_NOTE_MAX = 200;
/** One page of the owner's Activity page and of GET /api/activity. */
export const ACTIVITY_PAGE = 50;

export const isActivityKind = (v: unknown): v is ActivityKind => typeof v === "string" && (ACTIVITY_KINDS as readonly string[]).includes(v);
const isVia = (v: unknown): v is ActivityVia => typeof v === "string" && (ACTIVITY_VIAS as readonly string[]).includes(v);
/** A page cursor from a request: an ISO time, nothing longer. */
export const isActivityCursor = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) && !Number.isNaN(Date.parse(v));

const key = (scope: string) => `activity:${scope}`;
/** The log's key, for `wipeAccount`. */
export const activityKey = key;
/** "Nothing new" of one routine is recorded once per period; this marker says it was (see `recordRun`). */
export const actSkipKey = (scope: string, id: string, period: string) => `actskip:${scope}:${id}:${period}`;

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The row as stored: only the fields above, bounded. */
function bounded(e: Activity): Activity {
  const note = text(e.note, ACTIVITY_NOTE_MAX), outcome = text(e.outcome, 60), autofail = text(e.autofail, 40);
  return {
    at: e.at, kind: e.kind, by: e.by, via: e.via,
    ...(e.agent ? { agent: e.agent } : {}),
    ...(e.type ? { type: e.type } : {}),
    ...(e.tasks?.length ? { tasks: e.tasks.slice(0, ACTIVITY_MAX_TASKS) } : {}),
    ...(finite(e.count) ? { count: e.count } : {}),
    ...(finite(e.credits) ? { credits: e.credits } : {}),
    ...(outcome ? { outcome } : {}),
    ...(finite(e.score) ? { score: e.score } : {}),
    ...(autofail ? { autofail } : {}),
    ...(note ? { note } : {}),
    ...(e.media ? { media: e.media } : {}),
    ...(typeof e.refunded === "boolean" ? { refunded: e.refunded } : {}),
  };
}

/**
 * Append rows to one scope's log. Never throws: a failed write is logged and the action it describes stands. Falsy
 * entries are skipped, so a caller can pass `cond && row`.
 */
export async function recordActivity(scope: string, entries: readonly (Activity | null | undefined | false)[]): Promise<void> {
  try {
    const kept = entries.filter((e): e is Activity => !!e).map(bounded);
    const rows = kept.map((e) => JSON.stringify(e));
    if (rows.length) await Promise.all(rows.map((r) => pushCapped(key(scope), r, CAPS.activity)));
    // Phone notifications (rules 2565, 2572): only while push is on, after the response, and never in the action's way.
    if (kept.length && pushOn()) {
      const later = () => pushForActivity(scope, kept);
      try { after(later); } catch { void later(); }
    }
  } catch (e) {
    log.error("activity record failed", e);
  }
}

/**
 * The newest `n` rows of a scope's log, unreadable ones skipped, in stored order (rule 2553): one lrange of the head of
 * the capped list, for the app page's agent states, where the whole log would be read for nothing.
 */
export async function recentActivity(scope: string, n: number): Promise<Activity[]> {
  const take = Math.max(0, Math.min(CAPS.activity, Math.floor(n)));
  if (!take) return [];
  return (await db.lrange(key(scope), 0, take - 1)).flatMap((r) => { const a = readRow(r); return a ? [a] : []; });
}

/** One stored row read back, or null when any field is not what a row holds (skipped, never guessed at). */
function readRow(r: string): Activity | null {
  try {
    const v = JSON.parse(r) as Record<string, unknown>;
    if (!v || typeof v !== "object" || typeof v.at !== "string" || Number.isNaN(Date.parse(v.at)) || !isActivityKind(v.kind) || !isVia(v.via) || !isBy(v.by)) return null;
    if (v.agent !== undefined && !isAgentId(v.agent)) return null;
    if (v.type !== undefined && !isTaskType(v.type)) return null;
    if (v.tasks !== undefined && !(Array.isArray(v.tasks) && v.tasks.every((t) => typeof t === "string"))) return null;
    if ((["count", "credits", "score"] as const).some((k) => v[k] !== undefined && !finite(v[k]))) return null;
    if ((["outcome", "autofail", "note"] as const).some((k) => v[k] !== undefined && typeof v[k] !== "string")) return null;
    if (v.media !== undefined && v.media !== "image" && v.media !== "video") return null;
    return v as unknown as Activity;
  } catch {
    return null;
  }
}

/**
 * A row as the account's own logins receive it (GET /api/activity, the Activity page): `by` through `publicBy`, so who
 * impersonated stays with the founder console, which reads the rows whole.
 */
export const publicActivity = (a: Activity): Activity => ({ ...a, by: publicBy(a.by) });

export type ActivityQuery = { agent?: AgentId; kind?: ActivityKind; before?: string; limit?: number };
export type ActivityPage = { rows: Activity[]; next: string | null };

/**
 * One page of a scope's log, newest first: one lrange of the capped list, unreadable rows skipped, filtered in memory.
 * `before` is the `at` of the last row of the previous page (`next`): an offset would shift as new rows arrive. A page
 * never ends inside a run of rows with the same time, so the next page, which starts strictly before it, loses none.
 */
export async function listActivity(scope: string, q: ActivityQuery = {}): Promise<ActivityPage> {
  const limit = q.limit === undefined ? ACTIVITY_PAGE : Number.isFinite(q.limit) ? Math.max(0, Math.min(CAPS.activity, Math.floor(q.limit))) : 0;
  if (!limit) return { rows: [], next: null };
  const before = q.before === undefined ? NaN : Date.parse(q.before);
  const time = (a: Activity) => Date.parse(a.at);
  const rows = (await db.lrange(key(scope), 0, CAPS.activity - 1))
    .flatMap((r) => { const a = readRow(r); return a ? [a] : []; })
    .filter((a) => (!q.agent || a.agent === q.agent) && (!q.kind || a.kind === q.kind) && (Number.isNaN(before) || time(a) < before))
    .sort((a, b) => time(b) - time(a));
  let end = Math.min(limit, rows.length);
  while (end < rows.length && time(rows[end]) === time(rows[end - 1])) end++;
  return { rows: rows.slice(0, end), next: end < rows.length ? rows[end - 1].at : null };
}

/** Outcomes of a scheduled run worth a row every time, and the two the daily cron would otherwise repeat every day. */
const SKIPPED = new Set(["cap_reached", "agent_cap", "no_credits", "trial_over", "fair_use", "attempts_exhausted", "error"]);
const NOTHING_NEW = new Set(["idle", "no_data"]);
export type ScheduledRun = { id: string; agent: AgentId; type: TaskType; via: "weekly" | "routine"; by: By; period: string; ttlS: number };

/**
 * The outcome of a routine or of the Sunday plan: `routine_ran` for "ok:N", `routine_skipped` for a cap, the credits,
 * the trial, the fair-use stop (rule 1723), spent attempts or an error, and for "idle" or "no_data" once per routine and period (a SET NX marker with
 * the period's lifetime). Nothing for "off", "already_this_period", "retry:*" or anything else. Never throws.
 */
export async function recordRun(scope: string, run: ScheduledRun, outcome: string): Promise<void> {
  try {
    const row = { at: new Date().toISOString(), agent: run.agent, by: run.by, via: run.via, type: run.type, outcome };
    const ran = /^ok:(\d+)$/.exec(outcome);
    if (ran) return await recordActivity(scope, [{ ...row, kind: "routine_ran", count: Number(ran[1]) }]);
    if (SKIPPED.has(outcome)) return await recordActivity(scope, [{ ...row, kind: "routine_skipped" }]);
    if (NOTHING_NEW.has(outcome) && (await db.lock(actSkipKey(scope, run.id, run.period), run.ttlS))) await recordActivity(scope, [{ ...row, kind: "routine_skipped" }]);
  } catch (e) {
    log.error("activity record failed", e);
  }
}
