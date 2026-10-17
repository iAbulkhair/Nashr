/**
 * Reem, the secretary: item state, the open, due and done indexes, the audit line, `getItem`, `createItem` and the per-item lock.
 */
import { CAPS, db, pushCapped } from "./db";
import { allow } from "./rate";
import { sc, type User } from "./auth";
import { getTask } from "./brand";
import type { AgentId } from "./agents";
import type { Zone } from "./zones";
import type { CalData, SecItem, SecSource } from "./secretary-agenda";
import { log } from "./log";
import { SEC_CREATE_PER_DAY, SEC_ID, SEC_KEYS, SEC_OPEN_MAX, UNDATED_SCORE, newSecId } from "./secretary-keys";
import { type SecFail, type Who, fail, parseFields } from "./secretary-input";
import { calFor } from "./secretary-zone";
import { type ChangeAction, applyFields, defaultExpectBy, isOwner, needsDue, normalise, settleRepeat, untilBeforeDue } from "./secretary-mutate";

export type State = "open" | "done" | "deleted";
export const stateOf = (it: SecItem): State => (it.deletedAt ? "deleted" : it.completedAt ? "done" : "open");
const openScore = (it: SecItem) => (it.dueAt ? Date.parse(it.dueAt) : UNDATED_SCORE);

/**
 * The reminder index of one item: an open item with a `remindAt` is in `sec:due:{scope}` at that instant and its scope
 * in `sec:duescopes` no later than it (ZADD LT); any other item that had or has a reminder (done, deleted, cleared) is
 * taken out. The scope entry is written after the item's, so a sweep that just emptied the scope and re-reads it
 * either sees the new item or sees the scope written again after its removal.
 */
export function dueWrites(scope: string, prev: SecItem | null, next: SecItem): Promise<unknown>[] {
  const at = stateOf(next) === "open" && next.remindAt ? Date.parse(next.remindAt) : NaN;
  if (Number.isFinite(at)) return [db.zadd(SEC_KEYS.due(scope), at, next.id).then(() => db.zadd(SEC_KEYS.dueScopes, at, scope, { lt: true }))];
  return prev?.remindAt || next.remindAt ? [db.zrem(SEC_KEYS.due(scope), next.id)] : [];
}

/**
 * The index writes that follow an item from `prev` (null when new) to `next`: the open, deleted, done and id indexes and
 * the reminder index. The one place every write path goes through (create, change, the linked close, the reminder's
 * fire), so a close, a delete or a reminder change always cleans `sec:due`. Idempotent; sent in one round.
 */
export function indexWrites(scope: string, prev: SecItem | null, next: SecItem, opts?: { kept?: boolean }): Promise<unknown>[] {
  const from = prev ? stateOf(prev) : null, to = stateOf(next), id = next.id;
  const w: Promise<unknown>[] = [];
  if (to === "open") w.push(db.zadd(SEC_KEYS.open(scope), openScore(next), id));
  else if (from === "open") w.push(db.zrem(SEC_KEYS.open(scope), id));
  if (to === "deleted") w.push(db.zadd(SEC_KEYS.deleted(scope), Date.parse(next.expiresAt ?? "") || Date.now(), id));
  else if (from === "deleted") w.push(db.zrem(SEC_KEYS.deleted(scope), id));
  if (to === "done" && !prev?.completedAt) w.push(pushCapped(SEC_KEYS.done(scope), id, CAPS.secDone));
  // Reopened: out of the "recently done" list, so a second completion does not list it twice.
  if (from === "done" && to === "open") w.push(db.lrem(SEC_KEYS.done(scope), id));
  // The recurring series' indexes (R43). Into done from open or from deleted (a restored closed copy): the series set, the
  // list of series and, unless the series is kept, the warn window. Out of done: all three the copy could be in.
  if (to === "done" && from !== "done" && next.series) {
    w.push(db.zadd(SEC_KEYS.series(scope, next.series.id), Date.parse(next.completedAt ?? "") || Date.now(), id), db.sadd(SEC_KEYS.seriesList(scope), next.series.id));
    if (!opts?.kept) w.push(db.zadd(SEC_KEYS.sdone(scope), Date.parse(next.completedAt ?? "") || Date.now(), id));
  } else if (from === "done" && to !== "done" && prev?.series) {
    w.push(db.zrem(SEC_KEYS.series(scope, prev.series.id), id), db.zrem(SEC_KEYS.sdone(scope), id), db.zrem(SEC_KEYS.spurge(scope), id));
  }
  if (!prev) w.push(db.sadd(SEC_KEYS.all(scope), id));
  w.push(...dueWrites(scope, prev, next));
  return w;
}

/**
 * Write an open item's indexes again (open, all, due): idempotent for an open item. A booking's redelivery calls it
 * under the item's lock when the record exists, so a creation whose index writes failed after the record was saved is
 * listed after all. Done and deleted items are left alone (their indexes include the capped done list).
 */
export async function reindexOpen(scope: string, it: SecItem): Promise<void> {
  if (stateOf(it) === "open") await Promise.all(indexWrites(scope, null, it));
}

/**
 * One audit line per change: who, through what, which action on which item (`"-"` for a change that is not one item's,
 * such as the away list's), and a short description of the change.
 */
export function audit(scope: string, who: Who, action: string, id: string, diff: string) {
  return pushCapped(SEC_KEYS.audit(scope), JSON.stringify({ at: new Date().toISOString(), actor: who.actor, via: who.via, ...(who.login ? { login: who.login } : {}), action, id, diff: diff.slice(0, 200) }), CAPS.secAudit);
}
export function diffOf(prev: SecItem, next: SecItem): string {
  const keys = ["title", "description", "kind", "direction", "owedBy", "owedTo", "dueAt", "allDay", "expectBy", "lastChasedAt", "snoozeUntil", "remindAt", "priority", "critical", "links", "result", "completedAt", "proposedDone", "deletedAt", "repeat", "series", "nextId", "closedBy"] as const;
  // The phone number itself stays out of the audit line: only that it changed.
  const phone = (prev.phone ?? null) !== (next.phone ?? null) ? "; phone" : "";
  return keys.filter((k) => JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null)).map((k) => `${k}=${JSON.stringify(next[k] ?? null).slice(0, 40)}`).join("; ") + phone + (next.notes.length !== prev.notes.length ? "; +note" : "");
}

export async function getItem(scope: string, id: string): Promise<SecItem | null> {
  return SEC_ID.test(id) ? db.get<SecItem>(SEC_KEYS.item(scope, id)) : null;
}

/**
 * Create one open item in the caller's own active brand, dates in the brand's zone and a chase clock on its work
 * calendar (`opts.zone` and `opts.cal` when the caller already read them with `calFor`; otherwise read here, in one
 * round). Validation first, then the account's daily allowance. `opts.id`: the id the item gets, chosen by a caller that
 * claimed it first (a booking's claim, `applyBooking`), which holds the item's lock and has checked no record exists;
 * otherwise a new one.
 */
export async function createItem(user: Pick<User, "email" | "scope">, raw: Record<string, unknown>, who: Who & { source: SecSource }, opts: { zone?: Zone; cal?: CalData; handoffFrom?: AgentId; id?: string } = {}): Promise<{ ok: true; item: SecItem } | SecFail> {
  const scope = sc(user as User);
  const now = Date.now();
  if (opts.id !== undefined && !SEC_ID.test(opts.id)) return fail("bad_id", 400, "id");
  if (raw.title === undefined || raw.title === null || raw.title === "") return fail("title_required", 400, "title");
  const { zone, cal } = opts.cal ? { zone: opts.zone ?? opts.cal.zone, cal: opts.cal } : await calFor(scope, now);
  const p = parseFields(raw, now, zone);
  if (!p.ok) return p;
  // A contact's phone number is written by the owner in the app only.
  if (p.fields.phone !== undefined && !isOwner(who)) return fail("owner_only", 403, "phone");
  // An agent's own item (a handoff) never repeats: only a person, Reem or MCP sets a rule (code gate, not a prompt).
  if (p.fields.repeat !== undefined && who.source === "agent") return fail("owner_only", 403, "repeat");
  if (!(await allow(`sec:create:${user.email}`, SEC_CREATE_PER_DAY, 86400))) return { ...fail("too_many", 429), retryAfter: 86400 };
  const [open, task] = await Promise.all([db.zcard(SEC_KEYS.open(scope)), p.fields.taskId ? getTask(scope, p.fields.taskId) : null]);
  if (open >= SEC_OPEN_MAX) return fail("open_limit", 409);
  // A link must name an inbox item of this same brand: the id is read under the caller's scope, so another workspace's
  // task can never be linked, and the auto-close reads it under the same scope.
  if (p.fields.taskId && !task) return fail("unknown_task", 400, "taskId");
  // From chat or MCP, a link must point at an item still waiting for approval: a link to one already approved would be
  // closed by the next agenda read, an item closed without the owner.
  if (task && who.source !== "owner" && task.status !== "pending") return fail("link_not_pending", 400, "taskId");
  const at = new Date(now).toISOString();
  const base: SecItem = {
    id: opts.id ?? newSecId(), kind: "task", title: "", description: "", result: null, direction: "i_owe", owedBy: "owner", owedTo: null,
    dueAt: null, allDay: false, snoozeUntil: null, priority: 1, critical: false, links: {}, source: who.source, notes: [],
    createdAt: at, updatedAt: at, completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, expectBy: null, lastChasedAt: null, remindAt: null, rev: 1,
    ...(opts.handoffFrom ? { handoffFrom: opts.handoffFrom } : {}),
  };
  // An item created as "waiting on" someone, or with a named debtor and no direction, is "they owe".
  if (p.fields.direction === undefined && (p.fields.kind === "waiting_on" || (p.fields.owedBy && p.fields.owedBy !== "owner"))) p.fields.direction = "they_owe";
  const item = normalise(applyFields(base, p.fields));
  if ("ok" in item) return item;
  const bad = settleRepeat(item, p.fields, who, now, zone, cal);
  if (bad) return bad;
  if (needsDue(item)) return fail("repeat_needs_due", 400, "dueAt");
  if (untilBeforeDue(item, zone)) return fail("repeat_until_before_due", 400, "repeat");
  // Someone owes the owner and no date was given: the owner expects it within two working days, then Reem says chase.
  if (item.owedBy !== "owner" && !item.dueAt && !item.expectBy) item.expectBy = defaultExpectBy(now, zone, cal);
  await Promise.all([db.set(SEC_KEYS.item(scope, item.id), item), ...indexWrites(scope, null, item), audit(scope, who, "create", item.id, `title=${JSON.stringify(item.title).slice(0, 60)}; source=${who.source}`)]);
  return { ok: true, item };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * The item's lock, as `updateTask` takes `tasklock`: SET NX for 10 s (`ttlS`), 60 tries 50 ms apart. Exported for the
 * one other serialised step on the list, a blocked handoff note deciding between a new item and a note on a similar one.
 */
export async function withLock<T>(scope: string, id: string, fn: () => Promise<T>, ttlS = 10): Promise<T | SecFail> {
  const key = SEC_KEYS.lock(scope, id);
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = await db.lock(key, ttlS);
    if (!got) await sleep(50);
  }
  if (!got) return fail("lock_timeout", 503);
  try {
    return await fn();
  } finally {
    await db.unlock(key).catch((e) => log.error("sec lock release failed", e));
  }
}

/** The changes that read the brand's calendar first: a chase clock or a rule's dates (update, reschedule) and every close, which opens the next copy (R39). */
export const CAL_ACTIONS: ReadonlySet<ChangeAction> = new Set(["update", "reschedule", "complete", "confirm_done", "skip"]);
/** The owner's close actions: each one ends in `spawnNext`, as the linked close does. */
export const CLOSE_ACTIONS: ReadonlySet<ChangeAction> = new Set(["complete", "confirm_done", "skip"]);

/** Open items of a scope: one sorted-set read and one MGET. Ids whose record is gone are dropped from the set. */
export async function listOpenItems(scope: string): Promise<SecItem[]> {
  const ids = (await db.zrangeWithScores(SEC_KEYS.open(scope))).map((m) => m.member).filter((id) => SEC_ID.test(id));
  const rows = await db.mget<SecItem>(ids.map((id) => SEC_KEYS.item(scope, id)));
  const ghosts = ids.filter((_, i) => !rows[i] || stateOf(rows[i]!) !== "open");
  if (ghosts.length) void Promise.all(ghosts.map((id) => db.zrem(SEC_KEYS.open(scope), id))).catch(() => {});
  return rows.filter((it): it is SecItem => !!it && stateOf(it) === "open");
}
