/**
 * Reem, the secretary: the pure state machine of one item (`mutateItem`): who may change what, how a repeat settles, what each action writes.
 */
import { DEFAULT_ZONE, type Zone } from "./zones";
import { CHASE_WORKING_DAYS, SEC_LIMITS, SEC_RESTORE_DAYS, SKIP_RESULT, addWorkingDays, defaultCal, zoneDay, zoneLocalInput, zoneTime, type CalData, type SecActor, type SecItem, type SecNote, type SecRepeat } from "./secretary-agenda";
import { nextOccurrence } from "./secretary-calendar";
import { type SecFail, type SecFields, type Who, fail } from "./secretary-input";
import { newSeriesId } from "./secretary-keys";

/**
 * Who owes what, made consistent: "I owe" means the owner acts (owedBy "owner"); "they owe" means someone else acts
 * for the owner (owedTo "owner") and must be named. A waiting-on item is always "they owe".
 */
export function normalise(it: SecItem): SecItem | SecFail {
  if (it.kind === "waiting_on") it.direction = "they_owe";
  if (it.direction === "they_owe") {
    if (!it.owedBy || it.owedBy === "owner") return fail("owed_by_required", 400, "owedBy");
    it.owedTo = "owner";
  } else {
    // "I owe Ahmad" given as a debtor: Ahmad is who it is owed to.
    if (it.owedBy && it.owedBy !== "owner" && !it.owedTo) it.owedTo = it.owedBy;
    it.owedBy = "owner";
    if (it.owedTo === "owner") it.owedTo = null;
    // A contact number is for following up with whoever owes the owner: it goes when the item stops being theirs.
    if (it.phone) it.phone = null;
  }
  return it;
}

export function applyFields(it: SecItem, f: SecFields): SecItem {
  if (f.title !== undefined) it.title = f.title;
  if (f.description !== undefined) it.description = f.description;
  if (f.kind !== undefined) it.kind = f.kind;
  if (f.direction !== undefined) it.direction = f.direction;
  if (f.owedBy !== undefined) it.owedBy = f.owedBy ?? "owner";
  if (f.owedTo !== undefined) it.owedTo = f.owedTo;
  // A direction change without a party: the old "they owe" party moves to the other side, and back.
  if (f.direction === "they_owe" && f.owedBy === undefined && it.owedBy === "owner" && it.owedTo && it.owedTo !== "owner") it.owedBy = it.owedTo;
  if (f.direction === "i_owe" && f.owedTo === undefined && it.owedBy !== "owner") it.owedTo = it.owedBy;
  if (f.dueAt !== undefined) { it.dueAt = f.dueAt; it.allDay = f.dueAt ? !!f.allDay : false; }
  if (f.expectBy !== undefined) it.expectBy = f.expectBy;
  if (f.priority !== undefined) it.priority = f.priority;
  if (f.critical !== undefined) it.critical = f.critical;
  if (f.taskId !== undefined) it.links = f.taskId ? { taskId: f.taskId } : {};
  if (f.remindAt !== undefined) it.remindAt = f.remindAt;
  if (f.phone !== undefined) it.phone = f.phone;
  return it;
}

export type Change =
  | { action: "update"; fields: SecFields; snoozeUntil?: string | null; note?: { text: string; private: boolean }; chased?: boolean }
  | { action: "complete"; result: string }
  | { action: "snooze"; until: string }
  | { action: "reschedule"; dueAt: string | null; allDay: boolean }
  | { action: "propose_done"; evidence: string }
  | { action: "confirm_done"; result?: string }
  | { action: "reject_done" }
  | { action: "delete" }
  | { action: "restore" }
  | { action: "reopen" }
  /** Close one occurrence of a recurring item without doing it: the next copy opens as after a completion. */
  | { action: "skip" }
  /** The repeat ends; the item and its series stay (`todo.write` on the page, never from chat or MCP). */
  | { action: "stop_repeat" }
  | { action: "add_note"; text: string; private: boolean };
export type ChangeAction = Change["action"];
/**
 * Actions only the owner takes, in the app (`todo.close` on the route). Chat and MCP never close, skip, confirm, delete,
 * restore or reopen. `stop_repeat` is the owner's in the app too (`mutateItem` refuses anyone else) but needs only
 * `todo.write` there, like a change of the rule.
 */
export const OWNER_ONLY: ReadonlySet<ChangeAction> = new Set(["complete", "confirm_done", "reject_done", "delete", "restore", "reopen", "skip"]);

export const addNote = (it: SecItem, by: SecActor, textValue: string, priv: boolean, at: string, kind?: SecNote["kind"]) => {
  it.notes = [...it.notes, { at, by, text: textValue, private: priv, ...(kind ? { kind } : {}) }].slice(-SEC_LIMITS.notes);
};
/** The owner in the app: the only actor that closes, confirms, deletes, restores, changes a link or writes a private note. */
export const isOwner = (who: Who) => who.actor === "owner" && who.via === "web";

/**
 * Two working days from `now`: when someone who now owes the owner something is expected to deliver it. With the
 * brand's calendar, Eid, holidays and its own weekend never count toward them; without one, the zone's weekend only.
 */
export const defaultExpectBy = (now: number, z: Zone, cal?: CalData) => new Date(addWorkingDays(now, CHASE_WORKING_DAYS, z, cal)).toISOString();
/** A reminder that is still ahead, or none. */
export const futureOnly = (remindAt: string | null | undefined, now: number) => (remindAt && Date.parse(remindAt) > now ? remindAt : null);

/** Who closed an item, as `closedBy` stores it. */
export const closer = (who: Who): NonNullable<SecItem["closedBy"]> => ({ actor: who.actor, ...(who.login ? { login: who.login } : {}) });
/** R38, the one check: a recurring item always has a due date, whichever change built `next`. */
export const needsDue = (it: SecItem) => !!it.repeat && !it.dueAt;
/** An end date before the copy's own due day: the series would end before it began, and no next copy would ever open. */
export const untilBeforeDue = (it: SecItem, z: Zone) => !!it.repeat?.until && !!it.dueAt && it.repeat.until < zoneDay(Date.parse(it.dueAt), z);

/**
 * Settle the repeat rule of an item after its fields were applied (R36, R37, R42, R53), in zone `z` on calendar `cal`.
 * A rule given in `f.repeat` gets its anchor (the local day of `dueAt`), week start (the calendar's) and time ("HH:mm" of
 * a timed `dueAt`; none for all-day) from the item; an undated item gets its first occurrence, all-day (R38 then holds);
 * the series is minted on the first rule (R42) and kept when the rule stops. A change to `dueAt` through `update` on a
 * recurring item moves the rule's time of day with it (R53; `reschedule` never reaches here). A reminder set or cleared
 * on a recurring item sets or deletes `remindBefore`, only when it is 0-10080 minutes before `dueAt` (R37). From anyone
 * but the owner in the app, a rule that stops the repeat, ends it with `count <= n` or with an `until` before the next
 * occurrence is `owner_only` (field `repeat`).
 */
export function settleRepeat(it: SecItem, f: SecFields, who: Who, now: number, z: Zone, cal: CalData | undefined, prev?: { dueAt: string | null; allDay: boolean }): SecFail | null {
  const c = cal ?? defaultCal(z);
  if (f.repeat === null) {
    // Stopping a repeat is the owner's; on an item without one it changes nothing, so nobody is refused.
    if (it.repeat && !isOwner(who)) return fail("owner_only", 403, "repeat");
    it.repeat = null;
    return null;
  }
  if (f.repeat) {
    const base: SecRepeat = { ...f.repeat, anchor: zoneDay(now, z), weekStart: c.weekStart };
    // An undated item: its first occurrence is the first date the rule gives from today, all-day.
    if (!it.dueAt && f.dueAt === undefined) {
      const first = nextOccurrence(base, new Date(zoneTime(base.anchor, 0, 0, z) - 1).toISOString(), now, z, c, 0);
      if (!first) return fail("repeat_invalid", 400, "repeat");
      it.dueAt = first.dueAt;
      it.allDay = true;
    }
    if (it.dueAt) {
      const ms = Date.parse(it.dueAt);
      const rule: SecRepeat = { ...f.repeat, anchor: zoneDay(ms, z), weekStart: c.weekStart, ...(it.allDay ? {} : { time: zoneLocalInput(ms, z).slice(11) }) };
      if (!it.series) it.series = { id: newSeriesId(), n: 1 };
      if (!isOwner(who)) {
        if (rule.count !== undefined && rule.count <= it.series.n) return fail("owner_only", 403, "repeat");
        if (rule.until) {
          const nxt = nextOccurrence({ ...rule, until: undefined, count: undefined }, it.dueAt, now, z, c, it.series.n);
          if (nxt && rule.until < zoneDay(Date.parse(nxt.dueAt), z)) return fail("owner_only", 403, "repeat");
        }
      }
      // A new rule keeps the reminder the old one had unless the input says one (a reminder change below wins).
      if (rule.remindBefore === undefined && it.repeat?.remindBefore !== undefined) rule.remindBefore = it.repeat.remindBefore;
      it.repeat = rule;
    } else it.repeat = base; // dated no more (`dueAt` null in the same change): `needsDue` refuses it
  } else if (it.repeat && f.dueAt && it.dueAt) {
    // The rule's time follows a real change of the time of day; resending the same dueAt, or moving the date only, keeps it.
    const clock = (d: string | null, allDay: boolean) => (d && !allDay ? zoneLocalInput(Date.parse(d), z).slice(11) : "");
    const after = clock(it.dueAt, it.allDay);
    if (!prev || clock(prev.dueAt, prev.allDay) !== after) {
      const rule = { ...it.repeat };
      delete rule.time;
      if (after) rule.time = after;
      it.repeat = rule;
    }
  }
  if (it.repeat && f.remindAt !== undefined) {
    const rule = { ...it.repeat };
    delete rule.remindBefore;
    const minutes = it.remindAt && it.dueAt ? Math.round((Date.parse(it.dueAt) - Date.parse(it.remindAt)) / 60_000) : NaN;
    if (minutes >= 0 && minutes <= 10080) rule.remindBefore = minutes;
    it.repeat = rule;
  }
  return null;
}

/**
 * Apply one change to a copy of the stored item, in zone `z`, counting a new chase clock's working days on the brand's
 * calendar `cal` (the zone's weekend alone without one). Pure; the caller holds the item's lock.
 */
export function mutateItem(it: SecItem, c: Change, who: Who, now: number, z: Zone = DEFAULT_ZONE, cal?: CalData): { ok: true; item: SecItem } | SecFail {
  const m = mutate(it, c, who, now, z, cal);
  // R38: the one check, after every branch that builds the next item (update, reschedule and clear_due alike).
  if (m.ok && needsDue(m.item)) return fail("repeat_needs_due", 400, "dueAt");
  return m.ok && untilBeforeDue(m.item, z) ? fail("repeat_until_before_due", 400, "repeat") : m;
}
function mutate(it: SecItem, c: Change, who: Who, now: number, z: Zone, cal: CalData | undefined): { ok: true; item: SecItem } | SecFail {
  const at = new Date(now).toISOString();
  if (OWNER_ONLY.has(c.action) && !isOwner(who)) return fail("owner_only", 403);
  if (c.action === "stop_repeat" && !isOwner(who)) return fail("owner_only", 403, "repeat");
  // A link closes the item once its inbox item is approved, so moving a link onto an approved item would close it:
  // only the owner changes a link after creation (`createItem` checks the one chat and MCP may set).
  if (c.action === "update" && c.fields.taskId !== undefined && !isOwner(who)) return fail("owner_only", 403, "taskId");
  // A contact's phone number is the owner's, in the app: chat and MCP never write (or read) it.
  if (c.action === "update" && c.fields.phone !== undefined && !isOwner(who)) return fail("owner_only", 403, "phone");
  if (it.deletedAt && c.action !== "restore") return fail("deleted", 409);
  if (it.completedAt && !["delete", "restore", "add_note", "reopen"].includes(c.action)) return fail("completed", 409);
  switch (c.action) {
    case "update": {
      if (!Object.keys(c.fields).length && c.snoozeUntil === undefined && !c.note && !c.chased) return fail("nothing_to_change");
      const was = { owedBy: it.owedBy, dueAt: it.dueAt, allDay: it.allDay };
      const next = applyFields(it, c.fields);
      const bad = settleRepeat(next, c.fields, who, now, z, cal, was);
      if (bad) return bad;
      if (c.snoozeUntil !== undefined) {
        if (c.snoozeUntil && Date.parse(c.snoozeUntil) <= now) return fail("snooze_past", 400, "snoozeUntil");
        next.snoozeUntil = c.snoozeUntil;
      }
      if (c.note) addNote(next, who.actor, c.note.text, c.note.private && isOwner(who), at);
      const n = normalise(next);
      if ("ok" in n) return n;
      // A contact's number belongs to the party who owes: when someone else now owes it, the old number goes (whoever
      // made the change), unless the owner gave the new party's number in the same change.
      if (n.owedBy !== was.owedBy && n.phone && c.fields.phone === undefined) n.phone = null;
      // Newly owed by someone else, or no longer dated: the chase clock starts now unless a date was given.
      if (n.owedBy !== "owner" && !n.dueAt && !n.expectBy && (was.owedBy === "owner" || was.dueAt)) n.expectBy = defaultExpectBy(now, z, cal);
      if (c.chased) {
        // A follow-up restarts the clock and leaves a note; it never closes the item.
        if (n.owedBy === "owner") return fail("not_theirs", 409);
        n.lastChasedAt = at;
        addNote(n, who.actor, "", false, at, "chased");
      }
      return { ok: true, item: n };
    }
    case "complete": {
      if (!c.result) return fail("result_required", 400, "result");
      return { ok: true, item: { ...it, result: c.result, completedAt: at, proposedDone: null, snoozeUntil: null, closedBy: closer(who) } };
    }
    case "snooze": {
      if (Date.parse(c.until) <= now) return fail("snooze_past", 400, "until");
      return { ok: true, item: { ...it, snoozeUntil: c.until } };
    }
    case "reschedule": {
      const next: SecItem = { ...it, dueAt: c.dueAt, allDay: c.dueAt ? c.allDay : false, snoozeUntil: null };
      // A debt that loses its date gets the chase clock back.
      if (!next.dueAt && next.owedBy !== "owner" && !next.expectBy) next.expectBy = defaultExpectBy(now, z, cal);
      return { ok: true, item: next };
    }
    case "propose_done": {
      if (!c.evidence) return fail("evidence_required", 400, "evidence");
      // The snooze ends with the proposal: a snoozed item would otherwise hide the question from the owner.
      return { ok: true, item: { ...it, proposedDone: { at, by: who.actor, evidence: c.evidence }, snoozeUntil: null } };
    }
    case "confirm_done": {
      if (!it.proposedDone) return fail("not_proposed", 409);
      const result = c.result || it.proposedDone.evidence;
      if (!result) return fail("result_required", 400, "result");
      return { ok: true, item: { ...it, result, completedAt: at, proposedDone: null, snoozeUntil: null, closedBy: closer(who) } };
    }
    case "reject_done": {
      if (!it.proposedDone) return fail("not_proposed", 409);
      // Stored as the evidence with a kind, not as an English sentence: `noteText` words it for the page and for agents.
      addNote(it, who.actor, it.proposedDone.evidence.slice(0, SEC_LIMITS.note), false, at, "not_yet");
      return { ok: true, item: { ...it, proposedDone: null } };
    }
    case "delete":
      return { ok: true, item: { ...it, deletedAt: at, expiresAt: new Date(now + SEC_RESTORE_DAYS * 864e5).toISOString() } };
    case "restore": {
      if (!it.deletedAt) return fail("not_deleted", 409);
      if (it.expiresAt && Date.parse(it.expiresAt) <= now) return fail("restore_expired", 410);
      return { ok: true, item: { ...it, deletedAt: null, expiresAt: null, remindAt: futureOnly(it.remindAt, now) } };
    }
    case "reopen": {
      // A done item becomes open again: its result goes, a note says so, and it counts against the open cap
      // (`changeItem`). A reminder that already passed while it was done is not fired late. Its inbox link goes too:
      // a link to an approved item would close it again on the next agenda read (`closeLinked`); the note keeps the id.
      if (!it.completedAt) return fail("not_done", 409);
      const was = it.links?.taskId ?? "";
      const next: SecItem = { ...it, completedAt: null, result: null, proposedDone: null, remindAt: futureOnly(it.remindAt, now), links: {} };
      delete next.closedBy;
      addNote(next, who.actor, was, false, at, "reopened");
      return { ok: true, item: next };
    }
    case "skip": {
      if (!it.repeat) return fail("bad_action");
      return { ok: true, item: { ...it, result: SKIP_RESULT, completedAt: at, proposedDone: null, snoozeUntil: null, closedBy: closer(who) } };
    }
    case "stop_repeat": {
      if (!it.repeat) return fail("bad_action");
      // `series` stays: the history of the series is still exportable.
      return { ok: true, item: { ...it, repeat: null } };
    }
    case "add_note": {
      if (!c.text) return fail("nothing_to_change", 400, "text");
      addNote(it, who.actor, c.text, c.private && isOwner(who), at);
      return { ok: true, item: it };
    }
    default:
      return fail("bad_action");
  }
}
