/**
 * Reem, the secretary: item and series ids, every Redis key (`SEC_KEYS`) and the per-account and per-brand limits.
 * The rules the whole secretary keeps are written at the top of src/lib/secretary.ts.
 */
import { randomBytes } from "crypto";

export const SEC_ID = /^s[a-f0-9]{16}$/;
/** Starts with a letter: the Redis client parses a member that looks like a number, and 16 digits lose precision. */
export const newSecId = () => `s${randomBytes(8).toString("hex")}`;
/** A series id: `r` and 16 hex characters (a letter first, like `SEC_ID`). Checked before a key is built from one in a URL. */
export const SERIES_ID = /^r[a-f0-9]{16}$/;
export const newSeriesId = () => `r${randomBytes(8).toString("hex")}`;
export const TASK_ID = /^[a-f0-9]{16}$/;

export const SEC_KEYS = {
  item: (scope: string, id: string) => `sec:item:${scope}:${id}`,
  /** Sorted set of open item ids, score = due time in ms (undated items last). */
  open: (scope: string) => `sec:open:${scope}`,
  /** Capped list of the latest completed ids, newest first. */
  done: (scope: string) => `sec:done:${scope}`,
  /** Sorted set of soft-deleted ids, score = expiry in ms: the restore view and the daily purge. */
  deleted: (scope: string) => `sec:deleted:${scope}`,
  /** Every id this scope ever created and has not purged: what account deletion walks. */
  all: (scope: string) => `sec:all:${scope}`,
  audit: (scope: string) => `sec:audit:${scope}`,
  lock: (scope: string, id: string) => `sec:lock:${scope}:${id}`,
  /** How many overdue alerts this brand got on one local day (`SEC_ALERTS_PER_DAY`); lives two days. */
  alerts: (scope: string, day: string) => `sec:alerts:${scope}:${day}`,
  /**
   * Sorted set of the open items that carry a reminder, score = `remindAt` in ms. Written only by `indexWrites` (every
   * write path goes through it): an id leaves it when the item's write clears `remindAt`, never when a sweep picks it.
   * The one other writer is the sweep dropping a stale id, whose item is gone, closed or has no reminder (`fireReminder`).
   */
  due: (scope: string) => `sec:due:${scope}`,
  /**
   * The sweep's lease on one due reminder (src/lib/secretary-remind.ts), SET NX with `REMIND_LEASE_S`: one run at a time
   * works on it. Released when the attempt ends; a killed run's lease expires, and the id, still due, is retried.
   */
  firing: (scope: string, id: string) => `sec:firing:${scope}:${id}`,
  /** Global sorted set: member = a scope with reminders, score = its earliest `remindAt`. What the sweep reads first. */
  dueScopes: "sec:duescopes",
  /** Reem B3 (src/lib/secretary-cal-link.ts): the brand's linked calendar record, its synced events (TTL 24 h) and the global sync queue (member scope, score next sync ms). */
  calLink: (scope: string) => `sec:cal:link:${scope}`,
  calEvents: (scope: string) => `sec:cal:events:${scope}`,
  calDue: "sec:cal:due",
  /** When the QStash tick last ran (ms, TTL 2 h): `timedReminders()` reads it. */
  tick: "sec:tick:last",
  /** "Walk me through": the cards skipped for 3 hours, one JSON `{key: untilMs}` (TTL 1 day). */
  walk: (scope: string) => `sec:walk:${scope}`,
  /** The evening wrap's once-a-day marker, claimed with SET NX (TTL 2 days). */
  wrap: (scope: string, day: string) => `sec:wrap:${scope}:${day}`,
  /** Agents' handoff notes: a capped list (the last 30), newest first, no TTL, removed with the account. */
  notes: (scope: string) => `notes:${scope}`,
  /**
   * The brand's Working days settings: one JSON `SecCalendar` (src/lib/secretary-calendar.ts), absent for the country's
   * defaults. Read with the zone by `calFor`, wherever the agenda or a date is computed.
   */
  cal: (scope: string) => `sec:cal:${scope}`,
  /**
   * Contacts who are away: a hash, field `partyKey(label)`, value `{ label, until, note?, by, via, at }` (`until` is
   * the last away day, local, inclusive). Read by `calFor` as an `AwayMap`.
   */
  away: (scope: string) => `sec:away:${scope}`,
  /**
   * An absence Reem proposed in chat (`contact_away`, src/lib/secretary-away.ts): one JSON `AwayProposal`, 7 days.
   * Nothing is on the away list until a person presses Save on its card.
   */
  awayProp: (scope: string, id: string) => `secawayprop:${scope}:${id}`,
  /** Every away proposal id of a scope, so `secretaryKeys` (the account wipe) finds each random id. No TTL. */
  awayProps: (scope: string) => `secawayprops:${scope}`,
  /**
   * A proposal's outcome, "saved" or "dismissed" (7 days), claimed with SET NX before it is applied: "saving" for at most
   * a minute while a Save runs, so one answer wins.
   */
  awayPropDone: (scope: string, id: string) => `secawayprop-done:${scope}:${id}`,
  /** Every closed copy of one recurring series, kept or not, score = `completedAt` in ms (the series view and the export). */
  series: (scope: string, id: string) => `sec:series:${scope}:${id}`,
  /** The ids of the brand's series that have a closed copy, so `secretaryKeys` finds each `sec:series` and `sec:swarn` key. */
  seriesList: (scope: string) => `sec:serieslist:${scope}`,
  /** Closed copies of series not kept and not yet warned about, score = `completedAt` in ms: what the daily warn step reads. */
  sdone: (scope: string) => `sec:sdone:${scope}`,
  /** Closed copies the owner was warned about, score = the time they are deleted: what the daily purge step reads. */
  spurge: (scope: string) => `sec:spurge:${scope}`,
  /** The series the owner chose to keep (at most 500, `keep_limit`): their copies are never warned about or deleted. */
  seriesKeep: (scope: string) => `sec:serieskeep:${scope}`,
  /** The claim on the next copy of one closed copy (SET NX, 2 days; the value is the id the next copy gets). */
  spawn: (scope: string, id: string) => `sec:spawn:${scope}:${id}`,
  /** The marker that a series was named in a warning (SET NX, 30 days): a series is named once, not every day. */
  swarn: (scope: string, id: string) => `sec:swarn:${scope}:${id}`,
  /**
   * A booking's claim (Reem B2a, `applyBooking` in src/lib/secretary-booking.ts): the provider's own booking id names the
   * item it became. SET NX for 400 days, its value the item id chosen before the item is written (so a retry finishes
   * that same item), or `cancelled` when the booking was cancelled before its item existed or before it was ever seen.
   */
  bookClaim: (scope: string, provider: string, externalId: string) => `sec:book:ext:${scope}:${provider}:${externalId}`,
  /** Every `{provider}:{externalId}` the brand ever claimed, added before the claim, so account deletion finds each claim. */
  bookIds: (scope: string) => `sec:bookext:${scope}`,
  /**
   * The follow-up tasks proposed for one booking item (Reem B2b, src/lib/secretary-meeting.ts): one JSON `Proposal[]`, at
   * most 10, 14 days. Only `approveMeeting` turns any of them into items.
   */
  mprop: (scope: string, id: string) => `sec:mprop:${scope}:${id}`,
  /** Every item id that ever had a pending set, added before the set is written, so `secretaryKeys` finds each `sec:mprop` key. */
  mprops: (scope: string) => `sec:mprops:${scope}`,
  /**
   * How many transcript runs an item's proposals have had (`proposeFromText`): the `n` of its charge claim, so a retry of one
   * run reuses the hold and a new run is charged. No TTL (`chargeOnce` reuses a hold whatever its age, so a counter that lapsed would hand a free run); `secretaryKeys` names it for every id still in `sec:all`.
   */
  mrun: (scope: string, id: string) => `sec:mrun:${scope}:${id}`,
};
export const UNDATED_SCORE = 32503680000000; // year 3000: after every dated item

/** Per account across its brands, like the drafts allowance: switching brands must not multiply it. */
export const SEC_CREATE_PER_DAY = 200;
export const SEC_WRITES_PER_HOUR = 600;
export const SEC_READS_PER_HOUR = 600;
/** Per brand scope. */
export const SEC_OPEN_MAX = 500;
export const SEC_PURGE_BATCH = 200;
/** In-app overdue alerts per brand per local day; past it, the rest wait (they are in the morning brief anyway). */
export const SEC_ALERTS_PER_DAY = 5;
