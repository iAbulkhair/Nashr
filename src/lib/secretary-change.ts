/**
 * Reem, the secretary: `changeItem` (locked, rev-checked), the next copy of a repeating item, system removal, linked-inbox close and the reminder sweep.
 */
import { db } from "./db";
import { getTask } from "./brand";
import { DEFAULT_ZONE, type Zone } from "./zones";
import { AUTO_CLOSE_RESULT, SEC_LIMITS, SEC_RESTORE_DAYS, defaultCal, type CalData, type SecItem } from "./secretary-agenda";
import { nextOccurrence } from "./secretary-calendar";
import { log } from "./log";
import { CAL_ACTIONS, CLOSE_ACTIONS, audit, diffOf, dueWrites, indexWrites, listOpenItems, stateOf, withLock } from "./secretary-store";
import { type SecFail, type Who, fail } from "./secretary-input";
import { SEC_ID, SEC_KEYS, SEC_OPEN_MAX, newSecId, newSeriesId } from "./secretary-keys";
import { type Change, OWNER_ONLY, addNote, closer, futureOnly, isOwner, mutateItem } from "./secretary-mutate";
import { calFor } from "./secretary-zone";

/** How long the claim on a closed copy's next copy lives (`SEC_KEYS.spawn`): 2 days. */
export const SPAWN_CLAIM_S = 172800;

/**
 * A copy is untouched (R35) while it is open and nothing but its own reminder ever wrote to it: `rev` is 1 plus one per
 * `reminded` note, and it has no other note.
 */
/** A record that exists and is not soft-deleted: the only kind of next copy that stops a spawn. */
const liveRecord = (it: SecItem | null) => !!it && !it.deletedAt;
const untouched = (it: SecItem) => stateOf(it) === "open" && it.notes.every((n) => n.kind === "reminded") && it.rev === 1 + it.notes.length;

/**
 * Where a close is written, and the next copy of a recurring series opened (spec §4.3 with R33, R39, R41, R50, R51). The
 * caller holds the closed copy's lock; `cur` is the stored copy, `closed` the copy as the close made it (rev bumped),
 * `kept` whether its series is kept (R43), `line` the close's audit line (null: a retry that only completes the spawn).
 *
 * 1. No spawn when the copy has no repeat, the series ended (`nextOccurrence` is null: count, until, or no date found),
 *    or `nextId` names a live record (a re-close after a reopen that kept the next copy, R34). The close is then written
 *    alone, `nextId` as it was. A `nextId` naming a missing or soft-deleted record spawns again.
 * 2. The claim `sec:spawn:{scope}:{closedId}` (SET NX, 2 days, value a new id). A claim held already is reused when it
 *    names a live record (kept unchanged) or a missing one (written now); one naming a soft-deleted record is stale, so
 *    a new id is minted and the claim overwritten. A live record is never overwritten (R33: only a spawn of this same
 *    closed id knows the claimed id, and it holds this lock).
 * 3. The copy (R41): title, description, kind, direction, parties, phone, priority, critical and the rule copied; date
 *    and time from the rule; `remindAt` = `dueAt` − `remindBefore` when that is still ahead; rev 1, the closed copy's
 *    source, `series.n + 1`. Links, notes, result, proposal, snooze, chase, handoff and `closedBy` are not copied.
 * 4. Round 1 writes the closed copy with `nextId`, its index moves and the close's audit line; round 2 the new copy, its
 *    index moves and the `spawn` line by the rule (R51). A failure between them leaves a done copy whose `nextId` names
 *    a missing record: the retried close (`changeItem`) completes the spawn at the claimed id; nothing shows twice. The
 *    owner's close of a done copy whose next copy was soft-deleted takes the same path and opens a new copy.
 *
 * A close plus a spawn leaves the open count unchanged: neither `SEC_OPEN_MAX` nor the create allowance is checked.
 */
async function spawnNext(
  scope: string, cur: SecItem, closed: SecItem, who: Who, at: { zone: Zone; cal: CalData }, kept: boolean,
  line: { action: string; diff: (final: SecItem) => string } | null,
): Promise<SecItem> {
  const now = Date.now();
  const rule = closed.repeat;
  const series = closed.series ?? { id: newSeriesId(), n: 1 };
  const occ = rule && closed.dueAt ? nextOccurrence(rule, closed.dueAt, now, at.zone, at.cal, series.n) : null;
  const named = occ && closed.nextId && SEC_ID.test(closed.nextId) ? await db.get<SecItem>(SEC_KEYS.item(scope, closed.nextId)) : null;
  if (!rule || !occ || (named && !named.deletedAt)) {
    if (line) await Promise.all([db.set(SEC_KEYS.item(scope, closed.id), closed), ...indexWrites(scope, cur, closed, { kept }), audit(scope, who, line.action, closed.id, line.diff(closed))]);
    return closed;
  }
  // 2. The claim.
  const claimKey = SEC_KEYS.spawn(scope, closed.id);
  let nid = newSecId();
  let existing: SecItem | null = null;
  if (!(await db.setNx(claimKey, nid, SPAWN_CLAIM_S))) {
    const held = await db.get<string>(claimKey);
    const rec = typeof held === "string" && SEC_ID.test(held) ? await db.get<SecItem>(SEC_KEYS.item(scope, held)) : null;
    if (typeof held === "string" && SEC_ID.test(held) && !rec?.deletedAt) {
      nid = held;
      existing = rec;
    } else await db.set(claimKey, nid, SPAWN_CLAIM_S);
  }
  // 3. The copy.
  const iso = new Date(now).toISOString();
  const remindAt = rule.remindBefore !== undefined ? futureOnly(new Date(Date.parse(occ.dueAt) - rule.remindBefore * 60_000).toISOString(), now) : null;
  const copy: SecItem = {
    id: nid, kind: closed.kind, title: closed.title, description: closed.description, result: null, direction: closed.direction, owedBy: closed.owedBy, owedTo: closed.owedTo,
    dueAt: occ.dueAt, allDay: occ.allDay, snoozeUntil: null, priority: closed.priority, critical: closed.critical, links: {}, source: closed.source, notes: [],
    createdAt: iso, updatedAt: iso, completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, expectBy: null, lastChasedAt: null, remindAt,
    ...(closed.phone ? { phone: closed.phone } : {}), repeat: rule, series: { id: series.id, n: series.n + 1 }, rev: 1,
  };
  // 4. Round 1: the closed copy, naming the next one. A retry that finds the claim it wrote rewrites nothing.
  const final: SecItem = { ...closed, series, nextId: nid };
  if (line) await Promise.all([db.set(SEC_KEYS.item(scope, closed.id), final), ...indexWrites(scope, cur, final, { kept }), audit(scope, who, line.action, closed.id, line.diff(final))]);
  else if (cur.nextId !== nid) {
    // A retry whose claim lapsed (2 days): the closed copy names the new id.
    Object.assign(final, { rev: cur.rev + 1, updatedAt: iso });
    await Promise.all([db.set(SEC_KEYS.item(scope, closed.id), final), audit(scope, { actor: "rule", via: who.via }, "spawn_retry", closed.id, `nextId=${nid}`)]);
  }
  // Round 2: the new copy, only if no record is there (an open one left by an earlier attempt gets its indexes again).
  if (!existing) await Promise.all([db.set(SEC_KEYS.item(scope, nid), copy), ...indexWrites(scope, null, copy), audit(scope, { actor: "rule", via: who.via }, "spawn", nid, `from=${closed.id}; n=${copy.series!.n}; dueAt=${copy.dueAt}`)]);
  else if (stateOf(existing) === "open") await Promise.all(indexWrites(scope, null, existing));
  return final;
}

/**
 * A delete made by code, not by a person (B2-R7): `changeItem` refuses `delete` to anyone but the owner in the app
 * (`OWNER_ONLY`), so the two system deletes, a reopen's next copy and a cancelled booking, come here. Under the item's
 * lock: re-read, and when the item exists, is not deleted and passes `only` (when given), soft-delete it like the owner's
 * delete (`deletedAt`, `expiresAt` + `SEC_RESTORE_DAYS`, restorable), bump `rev`, move its indexes (`indexWrites`, so it
 * leaves `sec:open` and `sec:due`) and write one audit line `action` by `who`. "gone": missing, already deleted, or not
 * an item id; "kept": `only` refused it; "failed": the lock timed out or a read or write failed (nothing is written
 * before the lock). `missing`, when given, runs under the same lock when no record exists: a booking's cancel marks its
 * claim there, so a creation still to run under this lock finds the claim gone and creates nothing. `scope` is the
 * caller's own, never a value from a request.
 */
export async function removeBySystem(
  scope: string, id: string, who: Who, action: string,
  opts: { now?: number; only?: (it: SecItem) => boolean; missing?: () => Promise<unknown> } = {},
): Promise<"deleted" | "kept" | "gone" | "failed"> {
  if (!SEC_ID.test(id)) return "gone";
  try {
    const r = await withLock(scope, id, async (): Promise<"deleted" | "kept" | "gone"> => {
      const cur = await db.get<SecItem>(SEC_KEYS.item(scope, id));
      if (!cur && opts.missing) await opts.missing();
      if (!cur || cur.deletedAt) return "gone";
      if (opts.only && !opts.only(cur)) return "kept";
      const now = opts.now ?? Date.now();
      const iso = new Date(now).toISOString();
      const next: SecItem = { ...cur, deletedAt: iso, expiresAt: new Date(now + SEC_RESTORE_DAYS * 864e5).toISOString(), rev: cur.rev + 1, updatedAt: iso };
      await Promise.all([db.set(SEC_KEYS.item(scope, id), next), ...indexWrites(scope, cur, next), audit(scope, who, action, id, diffOf(cur, next))]);
      return "deleted";
    });
    return isFail(r) ? "failed" : r;
  } catch (e) {
    log.error("sec system delete failed", e);
    return "failed";
  }
}

/**
 * Reopen's side of a series (R32, R35, R48): delete the next copy through `removeBySystem` (soft, restorable like any
 * delete; audit `series_reopen` by the rule) only when it is untouched. "kept": it was edited or is already closed;
 * "gone": missing or already deleted; "failed": its lock timed out or a read or write failed, and the reopen answers
 * 503 before writing anything.
 */
const deleteNextCopy = (scope: string, nextId: string, now: number) => removeBySystem(scope, nextId, { actor: "rule", via: "web" }, "series_reopen", { now, only: untouched });

/**
 * Change one item of the caller's scope under its lock: re-read, check `expectRev` when the caller sent one, apply the
 * change to the stored copy, bump `rev`, save the item with its index moves and one audit line in one round. Dates are
 * in `zone`, and a chase clock an update or a reschedule starts counts working days on the brand's calendar `cal`;
 * when the caller did not pass the calendar, those two changes read it with the zone first (`calFor`, one round).
 */
export async function changeItem(scope: string, id: string, c: Change, who: Who, expectRev?: number, zone?: Zone, cal?: CalData): Promise<{ ok: true; item: SecItem; prev: SecItem } | SecFail> {
  if (!SEC_ID.test(id)) return fail("not_found", 404);
  if (OWNER_ONLY.has(c.action) && !isOwner(who)) return fail("owner_only", 403);
  const at = cal ? { zone: zone ?? cal.zone, cal } : CAL_ACTIONS.has(c.action) ? await calFor(scope) : { zone: zone ?? DEFAULT_ZONE, cal: undefined };
  const r = await withLock(scope, id, async (): Promise<{ ok: true; item: SecItem; prev: SecItem } | SecFail> => {
    const cur = await db.get<SecItem>(SEC_KEYS.item(scope, id));
    if (!cur) return fail("not_found", 404);
    const spawnAt = { zone: at.zone, cal: at.cal ?? defaultCal(at.zone) };
    // A close retried after its first round (R51): the copy is done and the next copy it names was never written, or was
    // soft-deleted since. The retry completes the spawn (at the claimed id, or a new one when that record is deleted) and
    // answers with the closed copy, whatever rev it was sent with. A next copy that is alive keeps the usual 409.
    if (CLOSE_ACTIONS.has(c.action) && isOwner(who) && stateOf(cur) === "done" && cur.repeat && cur.nextId && SEC_ID.test(cur.nextId) && !liveRecord(await db.get<SecItem>(SEC_KEYS.item(scope, cur.nextId)))) {
      return { ok: true, item: await spawnNext(scope, cur, cur, who, spawnAt, false, null), prev: cur };
    }
    if (expectRev !== undefined && expectRev !== cur.rev) return { ...fail("conflict", 409), item: cur };
    const now = Date.now();
    const m = mutateItem(structuredClone(cur), c, who, now, at.zone, at.cal);
    if (!m.ok) return m;
    const next: SecItem = { ...m.item, rev: cur.rev + 1, updatedAt: new Date(now).toISOString() };
    // Reopen of a copy that opened a next one (R32, R34, R48): the next copy goes only when untouched, under its own lock,
    // before anything here is written; a lock or read failure answers 503 with nothing written.
    let dropClaim = false, netZero = false;
    if (c.action === "reopen" && cur.nextId) {
      const d = await deleteNextCopy(scope, cur.nextId, now);
      if (d === "failed") return fail("lock_timeout", 503);
      if (d === "deleted" || d === "gone") {
        delete next.nextId;
        dropClaim = true;
      }
      netZero = d === "deleted";
    }
    // A restore or a reopen that makes an item open counts against the open cap like a new one; otherwise delete,
    // create, restore (or complete, create, reopen) would grow the list past it. A reopen that deleted an open next copy
    // changes nothing in the count (R52).
    if ((c.action === "restore" || c.action === "reopen") && stateOf(next) === "open" && !netZero && (await db.zcard(SEC_KEYS.open(scope))) >= SEC_OPEN_MAX) return fail("open_limit", 409);
    // R49: a reopened copy says so when another copy of its series is open (the edited next copy, or one further on).
    if (c.action === "reopen" && cur.series && (await listOpenItems(scope)).some((o) => o.id !== id && o.series?.id === cur.series!.id)) addNote(next, "rule", "", false, next.updatedAt, "two_open");
    const correction = who.actor === "owner" && cur.source !== "owner" && c.action === "update" ? " (owner correction)" : "";
    const action = c.action === "update" && c.chased && !Object.keys(c.fields).length ? "chased" : c.action;
    // R43: a series the owner keeps stays out of the warn window; read under the lock, only when a copy of a series
    // enters done (a close, or a restore of a closed copy).
    const kept = cur.series && stateOf(next) === "done" && stateOf(cur) !== "done" ? await db.sismember(SEC_KEYS.seriesKeep(scope), cur.series.id) : false;
    if (CLOSE_ACTIONS.has(c.action)) {
      const final = await spawnNext(scope, cur, next, who, spawnAt, kept, { action, diff: (f) => diffOf(cur, f) });
      return { ok: true, item: final, prev: cur };
    }
    await Promise.all([
      db.set(SEC_KEYS.item(scope, id), next), ...indexWrites(scope, cur, next, { kept }), audit(scope, who, action, id, diffOf(cur, next) + correction),
      ...(dropClaim ? [db.del(SEC_KEYS.spawn(scope, id))] : []),
    ]);
    return { ok: true, item: next, prev: cur };
  });
  return r;
}

/**
 * The deterministic close: an open item linked to an inbox item of the same scope closes when that item is approved
 * (publishing approves too). Re-checked under the item's lock, from the stored task, never from the model.
 */
export async function closeLinked(scope: string, id: string, who: Who, at: { zone: Zone; cal: CalData }): Promise<boolean> {
  const r = await withLock(scope, id, async () => {
    const cur = await db.get<SecItem>(SEC_KEYS.item(scope, id));
    if (!cur || stateOf(cur) !== "open" || !cur.links?.taskId) return false;
    const taskId = cur.links.taskId;
    const task = await getTask(scope, taskId);
    if (task?.status !== "approved") return false;
    const now = new Date().toISOString();
    const next: SecItem = { ...cur, result: AUTO_CLOSE_RESULT, completedAt: now, proposedDone: null, snoozeUntil: null, closedBy: closer(who), rev: cur.rev + 1, updatedAt: now };
    const kept = cur.series ? await db.sismember(SEC_KEYS.seriesKeep(scope), cur.series.id) : false;
    // A recurring copy opens its next one here too (R39: the brand's calendar from the agenda's own read).
    await spawnNext(scope, cur, next, who, at, kept, { action: "auto_close", diff: () => `task ${taskId} approved` });
    return true;
  });
  return r === true;
}

/**
 * How long the item lock is held while a reminder fires: the bell write waits up to about 3 s for its own lock and the
 * email up to `EMAIL_TIMEOUT_MS` (10 s), so the usual 10 s would lapse under a slow send and let another write in.
 */
const FIRE_LOCK_S = 30;

/**
 * Fire one due reminder the sweep leased (src/lib/secretary-remind.ts), under the item's lock. Re-read, and fire only
 * when the item is open and its `remindAt` is set, at or before `now`, and still the instant the sweep read
 * (`expectMs`). Delivery comes FIRST (`deliver`: the bell entry with the reminder's fingerprint, then the email when
 * that push was new), and only then the item's write (a `reminded` note, `remindAt` cleared, `rev` bumped, audit
 * `remind` by the cron): the item first, then its index moves, so a failure part-way leaves either the reminder still
 * due (retried; the fingerprint stops a second bell entry and email) or a cleared item whose stale index entry the next
 * sweep drops. Late, never lost. An item with no reminder due (closed, deleted, gone, cleared) leaves `sec:due`; one
 * whose reminder moved gets its index entry back from the stored item. `busy`: the lock was not free; the id stays due.
 */
export async function fireReminder(scope: string, id: string, now: number, expectMs: number | null, deliver: (cur: SecItem) => Promise<void>): Promise<{ fired: SecItem; remindAt: string } | "skip" | "busy"> {
  if (!SEC_ID.test(id)) {
    await db.zrem(SEC_KEYS.due(scope), id);
    return "skip";
  }
  const r = await withLock(scope, id, async (): Promise<{ fired: SecItem; remindAt: string } | "skip"> => {
    const cur = await db.get<SecItem>(SEC_KEYS.item(scope, id));
    const at = cur?.remindAt ? Date.parse(cur.remindAt) : NaN;
    if (!cur || stateOf(cur) !== "open" || !Number.isFinite(at)) {
      await db.zrem(SEC_KEYS.due(scope), id);
      return "skip";
    }
    if (at > now || (expectMs !== null && at !== expectMs)) {
      await Promise.all(dueWrites(scope, cur, cur));
      return "skip";
    }
    await deliver(cur);
    const iso = new Date(now).toISOString();
    const next: SecItem = { ...cur, remindAt: null, rev: cur.rev + 1, updatedAt: iso, notes: [...cur.notes, { at: iso, by: "cron" as const, text: "", private: false, kind: "reminded" as const }].slice(-SEC_LIMITS.notes) };
    await db.set(SEC_KEYS.item(scope, id), next);
    await Promise.all([...indexWrites(scope, cur, next), audit(scope, { actor: "cron", via: "cron" }, "remind", id, `remindAt=${cur.remindAt}`)]);
    return { fired: next, remindAt: cur.remindAt! };
  }, FIRE_LOCK_S);
  return isFail(r) ? "busy" : r;
}
const isFail = (v: unknown): v is SecFail => typeof v === "object" && v !== null && "ok" in v;

/** The QStash tick counts as running while its last call is younger than this. */
export const TICK_FRESH_MS = 3600_000;
/**
 * Are timed reminders running (a QStash tick within the last hour)? Only then do the tool answers and the page say a
 * reminder comes "at {time}"; otherwise it comes with the next morning brief (`briefClock`: 08:00 or 09:00 local, by
 * zone), from the daily fallback sweep.
 */
export async function timedReminders(now = Date.now()): Promise<boolean> {
  const last = Number(await db.get(SEC_KEYS.tick));
  return Number.isFinite(last) && last > 0 && now - last < TICK_FRESH_MS;
}
