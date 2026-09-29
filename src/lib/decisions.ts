import { CAPS, db, pushCapped } from "./db";
import { agentForTask, type AgentId } from "./agents";
import type { Task, TaskType } from "./brand";
import type { By } from "./actor";
import { recordActivity, type Activity } from "./activity";

/**
 * The owner's decisions on the agents' work, one record per human decision, newest first in `decisions:{scope}`.
 *
 * Written at the moment of the decision and never rebuilt from the task: each save overwrites `editedBody` and
 * `decidedAt`, reopening an item clears `decidedAt`, and the judge reloads and re-saves tasks without a lock, so the
 * task alone cannot say what the owner did or in which order. The list is append-only and capped (CAPS.decisions).
 *
 * Kept whatever `gov.learning` says: it is the owner's own history, like the inbox. Only its use in prompts is gated.
 * Auto-approved items (initialStatus) are not decisions and are never recorded; nor is a publish of an item that was
 * already approved.
 */
export type DecisionAction = "approve" | "reject" | "edit" | "reopen" | "publish";
export type Decision = {
  task: string;
  /** The agent that owns the task type, computed in code (agentForTask), never taken from the request. */
  agent: AgentId;
  type: TaskType;
  channel: string;
  action: DecisionAction;
  at: string;
  /** First 80 characters of the item's title. */
  title: string;
  /** What the owner typed as the reason (reject, or edit), first 300 characters. Free text: data, never instructions. */
  note?: string;
  /** Edit records only: how much the owner changed the agent's text, 0..100 (`editPctOf`, the light index's measure). */
  editPct?: number;
  /** The judge's score and automatic-fail code at the time of the decision, when the item had been judged. */
  score?: number;
  autofail?: string;
  /**
   * Who decided (`byOf(u)` in src/lib/actor.ts): the owner, a member, or the founder through support access. Worked out
   * from the session before the response, never from the body. Absent on records written before 2026-09-29.
   */
  by?: By;
};

const key = (scope: string) => `decisions:${scope}`;

/** One record from the task as it stands after the decision. */
export function decisionOf(t: Task, action: DecisionAction, at: string, extra: { note?: unknown; editPct?: number; by?: By } = {}): Decision {
  const note = typeof extra.note === "string" ? extra.note.trim().slice(0, 300) : "";
  return {
    task: t.id, agent: agentForTask(t.type).id, type: t.type, channel: t.channel, action, at, title: String(t.title ?? "").slice(0, 80),
    ...(note ? { note } : {}),
    ...(typeof extra.editPct === "number" ? { editPct: extra.editPct } : {}),
    ...(t.quality ? { score: t.quality.score } : {}),
    ...(t.quality?.autofail ? { autofail: t.quality.autofail } : {}),
    ...(extra.by ? { by: extra.by } : {}),
  };
}

/**
 * A decision in the activity log, with its `by` and the item's title as the note. A publish is left to the publish
 * paths, which record every publish (`published`, with the provider) and not only the ones that approved the item.
 */
const activityOf = (d: Decision): Activity | null =>
  d.action === "publish" ? null : { at: d.at, kind: "decision", agent: d.agent, by: d.by ?? { kind: "owner" }, via: "app", type: d.type, tasks: [d.task], outcome: d.action, note: d.title, ...(d.score !== undefined ? { score: d.score } : {}), ...(d.autofail ? { autofail: d.autofail } : {}) };

/** Append the decisions of one request, and their activity rows. The scope is always the caller's `sc(u)`; one round of parallel commands. */
export async function recordDecisions(scope: string, ds: Decision[]) {
  await Promise.all([...ds.map((d) => pushCapped(key(scope), JSON.stringify(d), CAPS.decisions)), recordActivity(scope, ds.map(activityOf))]);
}

/** The newest `limit` decisions of one scope, newest first. Unreadable rows are skipped rather than guessed at. */
export async function listDecisions(scope: string, limit: number = CAPS.decisions): Promise<Decision[]> {
  const n = Number.isFinite(limit) ? Math.max(0, Math.min(CAPS.decisions, Math.floor(limit))) : 0;
  if (!n) return [];
  const rows = await db.lrange(key(scope), 0, n - 1);
  return rows.flatMap((r) => {
    try {
      const d = JSON.parse(r) as Decision;
      return d && typeof d === "object" && typeof d.task === "string" ? [d] : [];
    } catch {
      return [];
    }
  });
}
