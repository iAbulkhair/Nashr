import { randomBytes } from "crypto";
import { CAPS, db, pushCapped } from "./db";
import { TASK_TYPES, isTaskType, type TaskType } from "./tasks";
import { AGENT_IDS, isAgentId, type AgentId } from "./agents";
import { isBy, publicBy, type By } from "./actor";
import { recordActivity } from "./activity";

export type Governance = {
  autoApprove: Partial<Record<TaskType, boolean>>; // skip inbox for these types
  weeklyCap: number; // max items created per week on their own: the weekly plan and the routines (schedule.ts, routines.ts)
  learning: boolean; // write preferences from edits/rejections
  reviewer: boolean; // second-pass quality reviewer
  noEmDash: boolean; // strip em/en dashes from output
  notifyMinutes: number; // minutes before a scheduled post to notify (future: WhatsApp/email)
  /** Monthly credit cap per agent in this brand scope (`charge` in credits.ts enforces it); an agent with no entry has no cap. */
  agentCaps: Partial<Record<AgentId, number>>;
  /**
   * Cross-agent review (`crossReview` in noor.ts): Razan and Majed add notes to the money and strategy work of the other
   * agents, and a flagged item waits for the owner. On by default; a record saved before 2026-09-30 reads it as on.
   */
  crossReview: boolean;
};

export const DEFAULT_GOV: Governance = { autoApprove: {}, weeklyCap: 20, learning: true, reviewer: true, noEmDash: false, notifyMinutes: 60, agentCaps: {}, crossReview: true };
/** Highest monthly cap an owner can set for one agent. */
export const AGENT_CAP_MAX = 100000;

/** What the governance PUT may send: `null` or "" for an agent's cap removes it. */
export type GovPatch = Partial<Omit<Governance, "agentCaps">> & { agentCaps?: Partial<Record<AgentId, number | null | "">> };

export async function getGov(email: string): Promise<Governance> {
  return { ...DEFAULT_GOV, ...((await db.get<Partial<Governance>>(`gov:${email}`)) ?? {}) };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Merge a patch into the stored governance. The patch is a request body, so every field is checked here, not trusted:
 * auto-approve keys must be task types with boolean values, caps must name an agent and be finite, NaN never replaces a
 * number, and unknown keys are dropped. `typeof NaN === "number"` used to let NaN through as a weekly cap.
 *
 * No lock and no history: a change made by a login goes through `saveGovAs` below, which applies these same checks.
 */
export async function saveGov(email: string, patch: GovPatch) {
  const next = mergeGov(await getGov(email), patch);
  await db.set(`gov:${email}`, next);
  return next;
}

/** The checks of `saveGov`, without the read and the write: the settings `patch` makes of `cur`. */
function mergeGov(cur: Governance, patch: GovPatch): Governance {
  const g: Record<string, unknown> = isObj(patch) ? patch : {};
  const autoApprove: Partial<Record<TaskType, boolean>> = {};
  for (const [k, v] of Object.entries({ ...cur.autoApprove, ...(isObj(g.autoApprove) ? g.autoApprove : {}) })) if (isTaskType(k) && typeof v === "boolean") autoApprove[k] = v;
  const agentCaps: Partial<Record<AgentId, number>> = {};
  for (const [k, v] of Object.entries(cur.agentCaps ?? {})) if (isAgentId(k) && num(v)) agentCaps[k] = v;
  for (const [k, v] of Object.entries(isObj(g.agentCaps) ? g.agentCaps : {})) {
    if (!isAgentId(k)) continue;
    if (v === null || v === "") delete agentCaps[k];
    else if (num(v)) agentCaps[k] = Math.max(0, Math.min(AGENT_CAP_MAX, Math.trunc(v)));
  }
  const next: Governance = {
    autoApprove,
    weeklyCap: num(g.weeklyCap) ? Math.max(0, Math.min(200, g.weeklyCap)) : cur.weeklyCap,
    learning: typeof g.learning === "boolean" ? g.learning : cur.learning,
    reviewer: typeof g.reviewer === "boolean" ? g.reviewer : cur.reviewer,
    noEmDash: typeof g.noEmDash === "boolean" ? g.noEmDash : cur.noEmDash,
    notifyMinutes: num(g.notifyMinutes) ? Math.max(0, Math.min(1440, g.notifyMinutes)) : cur.notifyMinutes,
    agentCaps,
    // Only a real boolean changes it: "false", 0 or null from a request leave the stored value, which defaults to on.
    crossReview: typeof g.crossReview === "boolean" ? g.crossReview : cur.crossReview !== false,
  };
  return next;
}

/**
 * Governance history: one record per save that changed something, newest first in `govhist:{scope}` (capped at
 * CAPS.govHistory). `before` and `after` are whole, checked settings, so any record can be restored, and `changed`
 * names what moved as dotted paths ("reviewer", "autoApprove.social", "agentCaps.razan"). `by` is the login behind it
 * (`byOf(u)`, src/lib/actor.ts), never a request field. A restore is a new record (`rollbackOf`): nothing is deleted.
 */
export type GovRevision = { id: string; at: string; by: By; changed: string[]; before: Governance; after: Governance; rollbackOf?: string };

const histKey = (scope: string) => `govhist:${scope}`;
const lockKey = (scope: string) => `govlock:${scope}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Revision ids are 12 hex characters; anything else from a request is refused before any read. */
export const isRevisionId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{12}$/.test(v);

/**
 * What differs between two settings, as dotted paths in the settings' own order. An auto-approve type that is off and
 * one that was never set are the same (the panel sends `false` for a type switched on and off again), and so are a cap
 * that is absent and one that is `null`.
 */
export function govDiff(before: Governance, after: Governance): string[] {
  const out: string[] = [];
  for (const k of Object.keys({ ...DEFAULT_GOV, ...before, ...after }) as (keyof Governance)[]) {
    const a: unknown = before[k], b: unknown = after[k];
    if (k === "autoApprove" || k === "agentCaps") {
      const x = (isObj(a) ? a : {}) as Record<string, unknown>, y = (isObj(b) ? b : {}) as Record<string, unknown>;
      const norm = (v: unknown) => (k === "autoApprove" ? v === true : num(v) ? v : null);
      for (const s of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) if (norm(x[s]) !== norm(y[s])) out.push(`${k}.${s}`);
    } else if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push(k);
  }
  return out;
}

export type GovSaved = { ok: true; governance: Governance; revision: GovRevision | null };
export type GovBusy = { ok: false; error: "busy" };

/**
 * `saveGov` for a login: read, merge and write under `govlock:{scope}`, so two saves (or a save and a restore) cannot
 * lose one another's change or record a before and after that never existed. A revision is pushed only when something
 * changed: the panel sends every field on every Save, and a history of no-ops would push real changes out of the cap.
 * Nothing is written then either. When the lock stays taken for about two seconds the answer is `busy` and nothing
 * changes.
 */
export async function saveGovAs(scope: string, patch: GovPatch, by: By, rollbackOf?: string): Promise<GovSaved | GovBusy> {
  const lock = lockKey(scope);
  let got = false;
  for (let i = 0; i < 40 && !got; i++) {
    got = await db.lock(lock, 10);
    if (!got) await sleep(50);
  }
  if (!got) return { ok: false, error: "busy" };
  try {
    // Both sides checked the same way, so the diff compares settings and never the shape of an old record.
    const before = mergeGov(await getGov(scope), {});
    const after = mergeGov(before, patch);
    const changed = govDiff(before, after);
    if (!changed.length) return { ok: true, governance: before, revision: null };
    const revision: GovRevision = { id: randomBytes(6).toString("hex"), at: new Date().toISOString(), by, changed, before, after, ...(rollbackOf ? { rollbackOf } : {}) };
    await Promise.all([
      db.set(`gov:${scope}`, after),
      pushCapped(histKey(scope), JSON.stringify(revision), CAPS.govHistory),
      // The activity log names what changed; the values stay in the history above.
      recordActivity(scope, [{ at: revision.at, kind: rollbackOf ? "gov_rollback" : "gov_changed", by, via: "app", count: changed.length, note: changed.join(", ") }]),
    ]);
    return { ok: true, governance: after, revision };
  } finally {
    // As in updateTask: a failed release must not turn a saved change into an error. The 10 s TTL frees the lock.
    await db.unlock(lock).catch((e) => console.error("governance lock release failed", e instanceof Error ? e.name : "error"));
  }
}

/**
 * The newest `limit` revisions of one scope, newest first. A row that cannot be read (bad JSON, id, time, `by` or
 * snapshots) is skipped, not guessed at: the page formats the time, and an invalid one would throw while rendering.
 */
export async function listGovHistory(scope: string, limit: number = CAPS.govHistory): Promise<GovRevision[]> {
  const n = Number.isFinite(limit) ? Math.max(0, Math.min(CAPS.govHistory, Math.floor(limit))) : 0;
  if (!n) return [];
  const rows = await db.lrange(histKey(scope), 0, n - 1);
  return rows.flatMap((r) => {
    try {
      const v = JSON.parse(r) as GovRevision;
      return v && typeof v === "object" && isRevisionId(v.id) && typeof v.at === "string" && !Number.isNaN(Date.parse(v.at)) && Array.isArray(v.changed) && isObj(v.before) && isObj(v.after) && isBy(v.by) ? [v] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The full patch that puts a snapshot back. `saveGov` keeps the current auto-approve types and caps that a patch does
 * not name, so sending the old snapshot as it is would leave everything added since in place: every task type is sent
 * as on or off, every agent's cap as its old number or `null`. A field the snapshot does not have (a setting added
 * later) takes its default, never the current value.
 */
export function restorePatch(snapshot: Partial<Governance>): GovPatch {
  const g = { ...DEFAULT_GOV, ...(isObj(snapshot) ? snapshot : {}) } as Governance;
  const aa: Record<string, unknown> = isObj(g.autoApprove) ? g.autoApprove : {};
  const caps: Record<string, unknown> = isObj(g.agentCaps) ? g.agentCaps : {};
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_GOV) as (keyof Governance)[]) {
    if (k === "autoApprove") patch[k] = Object.fromEntries(TASK_TYPES.map((t) => [t, aa[t] === true]));
    else if (k === "agentCaps") patch[k] = Object.fromEntries(AGENT_IDS.map((a) => [a, num(caps[a]) ? caps[a] : null]));
    else patch[k] = g[k];
  }
  return patch as GovPatch;
}

/**
 * Put back the settings as they were before revision `id`, looked up only in this scope's own history. The restore
 * goes through `saveGovAs`, so today's checks apply to the old values and it is recorded as a new revision.
 */
export async function rollbackGov(scope: string, id: string, by: By): Promise<GovSaved | GovBusy | { ok: false; error: "not_found" }> {
  const rev = isRevisionId(id) ? (await listGovHistory(scope)).find((r) => r.id === id) : undefined;
  if (!rev) return { ok: false, error: "not_found" };
  return saveGovAs(scope, restorePatch(rev.before), by, rev.id);
}

/** One changed setting as the Governance page shows it: on or off, a number, or no cap (`null`). */
export type GovValue = boolean | number | null;
export type GovHistoryEntry = { id: string; at: string; by: By; rollbackOf?: string; changes: { path: string; before: GovValue; after: GovValue }[] };

function valueAt(g: Governance, path: string): GovValue {
  const [head, sub] = path.split(".", 2) as [keyof Governance, string | undefined];
  const v: unknown = sub === undefined ? g[head] : (isObj(g[head]) ? (g[head] as Record<string, unknown>)[sub] : undefined);
  if (head === "autoApprove") return v === true;
  return typeof v === "boolean" || num(v) ? v : null;
}

/**
 * The history as the page renders it (and as the save and restore responses return one entry): only the settings each
 * revision changed, not two whole snapshots per row, and `by` through `publicBy`. Every login of the account reads the
 * page, so who impersonated stays in `govhist:{scope}`.
 */
export const historyView = (revs: GovRevision[]): GovHistoryEntry[] =>
  revs.map((r) => ({ id: r.id, at: r.at, by: publicBy(r.by), ...(r.rollbackOf ? { rollbackOf: r.rollbackOf } : {}), changes: r.changed.map((path) => ({ path, before: valueAt(r.before, path), after: valueAt(r.after, path) })) }));
