/**
 * Reem, the secretary: errors, text cleaning and the validation of every field a person, an agent or a tool may set (`parseFields`, `parseRepeat`).
 */
import { isAgentId } from "./agents";
import { DEFAULT_ZONE, type Zone } from "./zones";
import { SEC_DIRECTIONS, SEC_KINDS, SEC_LIMITS, parseWhen, zoneDay, zoneTime, type SecActor, type SecDirection, type SecItem, type SecKind, type SecRepeat, type SecVia } from "./secretary-agenda";
import { isLocalDay } from "./secretary-zone";
import { TASK_ID } from "./secretary-keys";

/**
 * Who changed an item. `actor` "owner" means a person in the app (the owner or a team member), as opposed to an agent,
 * MCP, the cron or a rule; `login` is which person (the acting login's email) when one is known.
 */
export type Who = { actor: SecActor; via: SecVia; login?: string };
export type SecError =
  | "bad_id" | "not_found" | "conflict" | "deleted" | "completed" | "title_required" | "too_long" | "bad_text" | "bad_kind" | "bad_direction"
  | "bad_party" | "owed_by_required" | "bad_date" | "date_out_of_range" | "bad_priority" | "bad_flag" | "unknown_task"
  | "link_not_pending" | "result_required" | "evidence_required" | "not_proposed" | "not_deleted" | "restore_expired" | "snooze_past"
  | "not_theirs" | "owner_only" | "bad_action" | "nothing_to_change" | "too_many" | "open_limit" | "lock_timeout"
  | "remind_past" | "bad_phone" | "not_done"
  // The away list (src/lib/secretary-away.ts): the owner or an agent named as a contact, a return day out of range, the
  // 200-field cap, and a body or label that is not one.
  | "not_contact" | "away_range" | "away_limit" | "bad_request"
  // An away proposal (Reem's contact_away card) that a person already saved or dismissed, or that another Save holds now.
  | "already_decided" | "busy"
  // Recurring items: a rule out of range (`parseRepeat`), a rule on an item with no due date, and the 500-series keep limit.
  | "repeat_invalid" | "repeat_needs_due" | "repeat_until_before_due" | "keep_limit";
/** `retryAfter`, with a 429 only: the refusing bucket's window in seconds, which the route sends as `Retry-After` (rule 680). */
export type SecFail = { ok: false; error: SecError; field?: string; status: number; item?: SecItem; retryAfter?: number };
export const fail = (error: SecError, status = 400, field?: string): SecFail => ({ ok: false, error, status, ...(field ? { field } : {}) });

// C0 controls other than tab and new line, DEL, C1 controls, zero-width space, the direction marks, embeddings,
// overrides and isolates, the line and paragraph separators and the byte-order mark: none carries anything an owner
// reads, and the bidi ones can make a title display differently from what it says. Joiners (U+200C, U+200D) stay.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** One line: controls removed, every run of white space one space. */
export const cleanLine = (v: string) => v.replace(/[\r\n\t]+/g, " ").replace(CONTROL, "").replace(/\s+/g, " ").trim();
/** A block: new lines kept (at most one empty line in a row), controls removed. */
export const cleanBlock = (v: string) => v.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(/\n{3,}/g, "\n\n").trim();

type Text = { ok: true; value: string } | SecFail;
export function text(v: unknown, field: keyof typeof SEC_LIMITS, block: boolean): Text {
  if (v === undefined || v === null) return { ok: true, value: "" };
  if (typeof v !== "string") return fail("bad_text", 400, field);
  const s = block ? cleanBlock(v) : cleanLine(v);
  // Too long is refused, not cut: a silently shortened promise is a different promise.
  if (s.length > SEC_LIMITS[field]) return fail("too_long", 400, field);
  return { ok: true, value: s };
}

/**
 * The words a party is read as the owner by (any case): what `party()` stores as `"owner"`, and what the away list refuses
 * as a contact (`partyKey` of each, src/lib/secretary-away.ts).
 */
export const OWNER_ALIASES = ["owner", "me", "you", "أنا"] as const;
/** `"owner"` (also "me"), an agent id, or a contact label. Arabic names are labels: only an exact agent id names an agent. */
function party(v: unknown, field: string): { ok: true; value: string | null } | SecFail {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return fail("bad_party", 400, field);
  const s = cleanLine(v);
  if (!s) return { ok: true, value: null };
  if (s.length > SEC_LIMITS.party) return fail("too_long", 400, field);
  const low = s.toLowerCase();
  if ((OWNER_ALIASES as readonly string[]).includes(low)) return { ok: true, value: "owner" };
  if (isAgentId(low)) return { ok: true, value: low };
  return { ok: true, value: s };
}

/** Fields an owner, an agent or MCP may set. Every key optional; `undefined` means "leave as it is". */
export type SecFields = {
  kind?: SecKind; title?: string; description?: string; direction?: SecDirection; owedBy?: string | null; owedTo?: string | null;
  dueAt?: string | null; allDay?: boolean; expectBy?: string | null; priority?: SecItem["priority"]; critical?: boolean; taskId?: string | null;
  /** One reminder instant, in the future when set; null clears it. */
  remindAt?: string | null;
  /** The owner's own, in the app only (`mutateItem` and `createItem` refuse it from anyone else); null clears it. */
  phone?: string | null;
  /**
   * A repeat rule as typed (`parseRepeat`): the rule's anchor, week start and time come from the item and the calendar
   * when it is applied (`settleRepeat`), never from the input. null stops the repeat (the owner's, in the app).
   */
  repeat?: RepeatInput | null;
};

/** What a person or a tool gives for a rule: everything but the three values the item and the calendar fix (R36). */
export type RepeatInput = Omit<SecRepeat, "anchor" | "weekStart" | "time">;
const REPEAT_EVERY: readonly SecRepeat["every"][] = ["day", "workday", "week", "month", "year", "hmonth", "hyear"];
const asInt = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);
/**
 * A repeat rule as typed, every range check in one place (R45: the tool schemas carry none). `null` is "no repeat".
 * `interval` 1-99 (`workday` always 1, `hyear` at most 10); `weekdays` (for `week`) unique 0-6, at least one; `monthDay`
 * (for `month` 1-31, `hmonth` 1-30, or -1 for the last day); `remindBefore` 0-10080 minutes; `until` a real local day,
 * not before today; `count` 1-999. Fields a rule does not use are dropped. `anchor`, `weekStart` and `time` in the input
 * are ignored: they are fixed from the item (`settleRepeat`).
 */
export function parseRepeat(v: unknown, now: number, z: Zone = DEFAULT_ZONE): { ok: true; repeat: RepeatInput | null } | SecFail {
  if (v === null) return { ok: true, repeat: null };
  const bad = () => fail("repeat_invalid", 400, "repeat");
  if (typeof v !== "object" || Array.isArray(v)) return bad();
  const r = v as Record<string, unknown>;
  if (!(REPEAT_EVERY as readonly unknown[]).includes(r.every)) return bad();
  const every = r.every as SecRepeat["every"];
  let interval = 1;
  if (r.interval !== undefined) {
    const n = asInt(r.interval, 1, 99);
    if (n === null || (every === "hyear" && n > 10)) return bad();
    interval = every === "workday" ? 1 : n;
  }
  const out: RepeatInput = { every, interval };
  if (every === "week" && r.weekdays !== undefined) {
    if (!Array.isArray(r.weekdays) || !r.weekdays.length || r.weekdays.length > 14) return bad();
    const days = r.weekdays.map((d) => asInt(d, 0, 6));
    if (days.some((d) => d === null)) return bad();
    out.weekdays = [...new Set(days as number[])].sort((a, b) => a - b);
  }
  if ((every === "month" || every === "hmonth") && r.monthDay !== undefined) {
    const n = r.monthDay === -1 ? -1 : asInt(r.monthDay, 1, every === "month" ? 31 : 30);
    if (n === null) return bad();
    out.monthDay = n;
  }
  if (r.remindBefore !== undefined) {
    const n = asInt(r.remindBefore, 0, 10080);
    if (n === null) return bad();
    out.remindBefore = n;
  }
  if (r.until !== undefined && r.until !== null) {
    if (!isLocalDay(r.until) || r.until < zoneDay(now, z)) return bad();
    out.until = r.until;
  }
  if (r.count !== undefined && r.count !== null) {
    const n = asInt(r.count, 1, 999);
    if (n === null) return bad();
    out.count = n;
  }
  return { ok: true, repeat: out };
}

/**
 * A WhatsApp number in the international form wa.me needs: the country code first, no leading zero, 8 to 15 digits in
 * all. A local number («050…») would give a link WhatsApp refuses while the tap still records a follow-up, so it is
 * `bad_phone`, and no country code is guessed (the contact may be abroad).
 */
const PHONE = /^[1-9]\d{7,14}$/;
/** A stored number wa.me can open (a number saved before the international form was required may not be). */
export const isWaNumber = (v: string | null | undefined): v is string => !!v && PHONE.test(v);
/**
 * A typed number cleaned: Arabic-Indic (U+0660-0669) and Eastern Arabic (U+06F0-06F9) digits made ASCII; `+`, spaces,
 * dashes, dots and parentheses removed; one leading "00" (the international prefix) dropped.
 */
export const cleanPhone = (v: string) => v
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  .replace(/[+\s\-.()]/g, "")
  .replace(/^00/, "");

/** A date-only reminder's local time: 08:00, at or before the 05:00 UTC daily run in every Gulf zone. */
export const REMIND_DAY_AT = { hh: 8, mm: 0 } as const;

/**
 * Validate the fields of a request body or tool call (camelCase: `title, description, kind, direction, owedBy, owedTo,
 * dueAt, expectBy, priority, critical, taskId, remindAt, phone`), dates in zone `z`. Nothing else in the body is read:
 * an `id`, `scope`, `email`, `rev` or `source` there changes nothing. A reminder given as a date alone is 08:00 local
 * that day (`REMIND_DAY_AT`: a reminder at 23:59 helps nobody, and 08:00 is due before that morning's daily run in every
 * zone, so even without the QStash tick it comes that morning), and must be in the future (`remind_past`).
 */
export function parseFields(raw: Record<string, unknown>, now: number, z: Zone = DEFAULT_ZONE): { ok: true; fields: SecFields } | SecFail {
  const f: SecFields = {};
  if (raw.title !== undefined) {
    const t = text(raw.title, "title", false);
    if (!t.ok) return t;
    if (!t.value) return fail("title_required", 400, "title");
    f.title = t.value;
  }
  if (raw.description !== undefined) {
    const t = text(raw.description, "description", true);
    if (!t.ok) return t;
    f.description = t.value;
  }
  if (raw.kind !== undefined) {
    if (!(SEC_KINDS as readonly unknown[]).includes(raw.kind)) return fail("bad_kind", 400, "kind");
    f.kind = raw.kind as SecKind;
  }
  if (raw.direction !== undefined) {
    if (!(SEC_DIRECTIONS as readonly unknown[]).includes(raw.direction)) return fail("bad_direction", 400, "direction");
    f.direction = raw.direction as SecDirection;
  }
  for (const k of ["owedBy", "owedTo"] as const) {
    if (raw[k] === undefined) continue;
    const p = party(raw[k], k);
    if (!p.ok) return p;
    f[k] = p.value;
  }
  if (raw.dueAt !== undefined) {
    const w = parseWhen(raw.dueAt, now, z);
    if (!w.ok) return fail(w.error, 400, "dueAt");
    f.dueAt = w.at;
    f.allDay = w.allDay;
  }
  if (raw.expectBy !== undefined) {
    const w = parseWhen(raw.expectBy, now, z);
    if (!w.ok) return fail(w.error, 400, "expectBy");
    f.expectBy = w.at;
  }
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== "number" || !Number.isInteger(raw.priority) || raw.priority < 0 || raw.priority > 3) return fail("bad_priority", 400, "priority");
    f.priority = raw.priority as SecItem["priority"];
  }
  if (raw.critical !== undefined) {
    if (typeof raw.critical !== "boolean") return fail("bad_flag", 400, "critical");
    f.critical = raw.critical;
  }
  if (raw.taskId !== undefined) {
    if (raw.taskId === null || raw.taskId === "") f.taskId = null;
    else if (typeof raw.taskId !== "string" || !TASK_ID.test(raw.taskId)) return fail("unknown_task", 400, "taskId");
    else f.taskId = raw.taskId;
  }
  if (raw.remindAt !== undefined) {
    const w = parseWhen(raw.remindAt, now, z);
    if (!w.ok) return fail(w.error, 400, "remindAt");
    const at = w.at && w.allDay ? new Date(zoneTime(String(raw.remindAt).trim(), REMIND_DAY_AT.hh, REMIND_DAY_AT.mm, z)).toISOString() : w.at;
    if (at && Date.parse(at) <= now) return fail("remind_past", 400, "remindAt");
    f.remindAt = at;
  }
  if (raw.repeat !== undefined) {
    const p = parseRepeat(raw.repeat, now, z);
    if (!p.ok) return p;
    f.repeat = p.repeat;
  }
  if (raw.phone !== undefined) {
    if (raw.phone === null || raw.phone === "") f.phone = null;
    else if (typeof raw.phone !== "string" || raw.phone.length > 40 || !PHONE.test(cleanPhone(raw.phone))) return fail("bad_phone", 400, "phone");
    else f.phone = cleanPhone(raw.phone);
  }
  return { ok: true, fields: f };
}
