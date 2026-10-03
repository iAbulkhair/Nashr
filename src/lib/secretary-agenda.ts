/**
 * Reem's agenda, computed from the owner's items and the clock, never stored. A status saved on an item goes stale the
 * moment the clock passes its due time; derived here, "overdue" is always true when it is shown.
 *
 * Browser-safe: this module imports only `./dates` and `./zones` (both import-free) and `./agents` (whose one import is
 * a type), so the to-do page and the server share one definition of the buckets, the local day and the date wording.
 * Storage lives in `./secretary.ts`, which is server only.
 *
 * Local time. Each brand keeps its list in one Gulf time zone (`./zones`: Riyadh by default; Dubai and Muscat are
 * UTC+4). None of them keeps daylight saving time, so a local wall-clock time is the UTC instant plus a fixed offset.
 * Days and times are computed with that offset and formatted through `dateFormat` (which is always UTC) on the shifted
 * instant: no time-zone database, and the same answer on the server and in every browser. Every function takes the
 * zone last and defaults to Riyadh.
 */
import { dateFormat } from "./dates";
import { agentById, isAgentId, type AgentId } from "./agents";
import { DEFAULT_ZONE, WEEKDAY_NAMES, ZONES, isWeekend, weekStartDay, zoneOffsetMs, zoneUtcLabel, type Zone } from "./zones";

export const SEC_KINDS = ["task", "follow_up", "waiting_on", "reminder"] as const;
export type SecKind = (typeof SEC_KINDS)[number];
export const SEC_DIRECTIONS = ["i_owe", "they_owe"] as const;
export type SecDirection = (typeof SEC_DIRECTIONS)[number];
/** `"owner"`, an agent id, or a contact label of at most 80 characters. */
export type SecParty = string;
/** Who changed an item: the owner in the app, an agent in chat, the owner's own assistant over MCP, the daily job, or a code rule. */
export type SecActor = "owner" | AgentId | "mcp" | "cron" | "rule";
export type SecVia = "web" | "chat" | "mcp" | "cron";
export type SecSource = "owner" | "chat" | "mcp" | "agent";
/**
 * One note on an item. Some notes are written by code with a `kind`, and `noteText` words them in the reader's
 * language (the page in Arabic or English, a tool answer in English): `not_yet`, left by the owner's "Not yet", whose
 * `text` holds the claim that was sent back; `chased`, left when the owner followed up («تمت المتابعة», never "sent");
 * `reminded`, left when a reminder the owner asked for fired; `reopened`, left when the owner reopened a done item
 * (its `text` is the id of the inbox item the reopen unlinked it from, or empty); `two_open`, left on a reopened copy of
 * a recurring series when another copy of the series is still open.
 */
export type SecNote = { at: string; by: SecActor; text: string; private: boolean; kind?: "not_yet" | "chased" | "reminded" | "reopened" | "two_open" };

/** How a recurring item repeats. Pure data; `gregorianNext` here and `nextOccurrence` in `./secretary-calendar` read it. */
export type SecRepeat = {
  every: "day" | "workday" | "week" | "month" | "year" | "hmonth" | "hyear";
  /** 1-99; `workday` always 1; `hyear` at most 10 (checked where the rule is parsed). */
  interval: number;
  /** Local "YYYY-MM-DD" of the first occurrence; set when the rule is set or changed, never by a reschedule. */
  anchor: string;
  /** The brand's effective week start when the rule was set; `week` periods count from it. */
  weekStart: number;
  /** Local "HH:mm" of every copy; absent means all-day (due at the end of the local day). */
  time?: string;
  /** `week`: 0 Sunday … 6 Saturday, unique; default the anchor's weekday. */
  weekdays?: number[];
  /** `month`: 1-31 or -1 (the last day); `hmonth`: 1-30 or -1; default the anchor's day. */
  monthDay?: number;
  /** Minutes before `dueAt` the reminder of each copy is set, 0-10080. */
  remindBefore?: number;
  /** Local "YYYY-MM-DD", inclusive. */
  until?: string;
  /** 1-999 occurrences in all. */
  count?: number;
};
/** The result stored when the owner skips one occurrence of a recurring item. */
export const SKIP_RESULT = "skipped";

export type SecItem = {
  /** Server-generated: `s` and 16 hex characters (`SEC_ID` in secretary.ts). */
  id: string;
  kind: SecKind;
  title: string;
  description: string;
  /** What was done. Required to complete; null while open. */
  result: string | null;
  direction: SecDirection;
  /** Who has to act: `"owner"` for the owner's own to-dos, an agent id, or a contact who owes the owner something. */
  owedBy: SecParty;
  /** Who it is owed to, when that matters (a customer waiting for a quote); `"owner"` when someone owes the owner. */
  owedTo: SecParty | null;
  /** ISO instant, or null for an undated item. Entered and shown in the brand's local time. */
  dueAt: string | null;
  /** Due "by the end of that day" (entered as a date only): dueAt is 23:59 local time and the time is not shown. */
  allDay: boolean;
  snoozeUntil: string | null;
  priority: 0 | 1 | 2 | 3;
  critical: boolean;
  links: { taskId?: string };
  source: SecSource;
  notes: SecNote[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /**
   * An agent or the owner's assistant says it is done. `evidence` is that agent's own words: a claim, shown as one and
   * never as a fact; only the owner turns it into done.
   */
  proposedDone: { at: string; by: SecActor; evidence: string } | null;
  deletedAt: string | null;
  /** deletedAt + 30 days: restorable until then, purged by the daily job after. */
  expiresAt: string | null;
  /**
   * Someone else owes it and it has no due date: when the owner expects it. Set to two working days after creation by
   * default; past it the agenda says "chase". Absent on items saved before 2026-09-29's chase clock (computed then).
   */
  expectBy?: string | null;
  /** When the owner last followed up. The chase clock restarts from it; a follow-up never closes the item. */
  lastChasedAt?: string | null;
  /**
   * One reminder instant the owner (in the app) or an agent (`remind_at`) asked for; in the future when set. The sweep
   * (src/lib/secretary-remind.ts) fires it once, leaves a `reminded` note and clears it. Absent on items before 2026-09-30.
   */
  remindAt?: string | null;
  /**
   * A they-owe item's contact number for WhatsApp, digits only (8 to 15). Set by the owner in the app only; it never
   * reaches a tool answer, a prompt or an agent. The page links to wa.me with a fixed message; nothing is sent by the app.
   */
  phone?: string | null;
  /** The agent whose `handoff_note` (kind "blocked") opened this item, so a second similar note joins it as a note. */
  handoffFrom?: AgentId | null;
  /** Present on a recurring item: how it repeats. `null` after the owner stopped the repeat; absent on items before A2. */
  repeat?: SecRepeat | null;
  /** The series a recurring item belongs to (`r` and 16 hex characters) and its place in it, 1 for the first copy. */
  series?: { id: string; n: number };
  /** On a closed copy: the id of the copy opened after it. */
  nextId?: string;
  /** Who closed it; set by every close path, cleared on reopen, never copied to the next copy. */
  closedBy?: { actor: SecActor; login?: string };
  /** Bumped on every write; a writer that read an older rev gets 409 `conflict`. */
  rev: number;
};

export const SEC_LIMITS = { title: 200, description: 2000, result: 1000, party: 80, note: 500, notes: 50, evidence: 500 } as const;
export const SEC_RESTORE_DAYS = 30;
/** The result written when code closes an item because the inbox item it points at was approved. */
export const AUTO_CLOSE_RESULT = "linked item approved";

const DAY_MS = 864e5;
/** The local calendar day (YYYY-MM-DD) of an instant. */
export const zoneDay = (ms: number, z: Zone = DEFAULT_ZONE) => new Date(ms + zoneOffsetMs(z)).toISOString().slice(0, 10);
/** The instant of a local wall-clock time on a local day. */
export const zoneTime = (day: string, hh: number, mm: number, z: Zone = DEFAULT_ZONE) => Date.parse(`${day}T00:00:00Z`) + (hh * 60 + mm) * 60_000 - zoneOffsetMs(z);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** Whole calendar days from day `a` to day `b`. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
/** "YYYY-MM-DDTHH:mm" in local time: the value a datetime-local input shows for this instant. */
export const zoneLocalInput = (ms: number, z: Zone = DEFAULT_ZONE) => new Date(ms + zoneOffsetMs(z)).toISOString().slice(0, 16);
/** An all-day item is due at the last minute of its local day. */
export const endOfZoneDay = (day: string, z: Zone = DEFAULT_ZONE) => zoneTime(addDays(day, 1), 0, 0, z) - 60_000;
/** Riyadh's day, the default zone's: kept for the callers that mean Riyadh. */
export const riyadhDay = (ms: number) => zoneDay(ms, DEFAULT_ZONE);

/** Why a local day is quiet. `name` is the holiday's own name when it has one, shown to the owner in both languages. */
export type QuietWhy = { kind: "weekend" | "eid_fitr" | "eid_adha" | "holiday" | "added"; name?: { ar: string; en: string } };
/**
 * The brand's work calendar as plain, serialisable data: what the chase rule and the working-day count read, so those
 * stay pure and browser-safe. Built on the server (`workCalendar`) from the brand's settings and the country's holidays;
 * `defaultCal` is the zone's own weekend with nothing else, which is what every caller without a calendar gets.
 */
export type CalData = {
  zone: Zone;
  /** Weekend weekdays, 0 Sunday … 6 Saturday (the brand's effective ones). */
  weekend: number[];
  /** The weekday the work week starts on: the day after the last weekend day, Sunday when there is none. */
  weekStart: number;
  /** Quiet local days that are not on the weekend (Eid, holidays, days the owner added), keyed YYYY-MM-DD. */
  quiet: Record<string, QuietWhy>;
  /** The local days of Ramadan (with the owner's moon-sighting corrections). */
  ramadan: string[];
  /** The hours chasing is suggested on a Ramadan day, local "HH:mm", each `[from, to)`. Empty: no restriction. */
  ramadanHours: { from: string; to: string }[];
  /** The morning brief's local time: the moment a quiet day's chase is moved to. */
  briefAt: { hh: number; mm: number };
  /** The owner's moon-sighting corrections per Hijri year (`shawwal1`, `dhulhijja1`), read by the Hijri repeat rules. */
  hijriFix?: Record<string, { shawwal1?: string; dhulhijja1?: string }>;
};
/** Contacts who are away, keyed by `partyKey` of their label: `until` is the last away day (YYYY-MM-DD), `endedAt` when they came back early. */
export type AwayMap = Record<string, { label: string; until: string; endedAt?: string }>;

// The same characters `cleanLine` in secretary.ts removes (that module is server only, this one is shared with the
// browser): C0 and C1 controls but tab and new line, DEL, zero-width space, direction marks, embeddings, overrides and
// isolates, the line and paragraph separators and the byte-order mark. tests/secretary-calendar.test.ts (rule 475)
// checks that `partyKey` cleans at least what `cleanLine` does.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
// Harakat, the Quranic marks, superscript alef, and the tatweel that only stretches a word.
const TASHKEEL = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed\u0640]/g;
/**
 * The key one contact is known by, however its name was typed: «أحمد», «احمد», «إحمد» and «أحمد » are one contact,
 * "Ahmad" another. Cleaned the way an item's party is (`party()` in secretary.ts: controls out, white space collapsed),
 * then: invisible characters out (soft hyphen, zero-width marks, variation selectors, U+3164 …), NFKC (fullwidth
 * ＤＡＮＡ is dana) and lower case, tashkeel and tatweel out, أ إ آ ٱ → ا, ة → ه, ى → ي, spaces collapsed. Null when the
 * key is longer than a party may be (80 characters). Pure; it does not decide who may be marked away.
 */
export function partyKey(label: string): string | null {
  const clean = label.replace(/[\r\n\t]+/g, " ").replace(CONTROL, "").replace(/\s+/g, " ").trim();
  const key = clean
    .replace(IGNORABLE, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(IGNORABLE, "")
    .replace(TASHKEEL, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
  return key.length > SEC_LIMITS.party ? null : key;
}
/** Chasing hours on a Ramadan day when the brand set none: late morning to mid-afternoon. */
export const DEFAULT_RAMADAN_HOURS: readonly { from: string; to: string }[] = [{ from: "10:00", to: "15:00" }];
/** The calendar a brand has before it changes anything: the zone's weekend, no holidays, no Ramadan days, the default hours. */
export function defaultCal(zone: Zone): CalData {
  const weekend = [...ZONES[zone].weekend];
  return { zone, weekend, weekStart: weekStartDay(weekend), quiet: {}, ramadan: [], ramadanHours: DEFAULT_RAMADAN_HOURS.map((w) => ({ ...w })), briefAt: briefTime(zone) };
}
/** A local day (YYYY-MM-DD) nobody is expected to work: a weekend weekday, or a day the calendar lists as quiet. */
export const isQuietDay = (day: string, cal: CalData) => cal.weekend.includes(new Date(`${day}T00:00:00Z`).getUTCDay()) || Object.prototype.hasOwnProperty.call(cal.quiet, day);

/** Days either walk below looks ahead: a year and a bit, past the calendar's own window, and the stop for malformed data. */
const MAX_SCAN_DAYS = 400;
/**
 * `n` working days after an instant, at the same local time, skipping the weekend (Friday and Saturday; Saturday and
 * Sunday in the UAE). Started on a weekend day, the count begins at the next working day. With the brand's calendar it
 * skips every quiet day as well, so Eid and holidays never count toward a wait; without one, only the zone's weekend.
 */
export function addWorkingDays(ms: number, n: number, z: Zone = DEFAULT_ZONE, cal?: CalData): number {
  const start = zoneDay(ms, z);
  let day = start;
  // `seen` bounds the calendar path: a weekend of all seven days (never saved, but `CalData` is data) would never end.
  for (let left = n, seen = 0; left > 0; seen++) {
    day = addDays(day, 1);
    const off = cal ? seen < MAX_SCAN_DAYS && isQuietDay(day, cal) : isWeekend(z, new Date(`${day}T00:00:00Z`).getUTCDay());
    if (!off) left--;
  }
  return ms + daysBetween(start, day) * DAY_MS;
}

/** A local "HH:mm" on a local day as an instant (NaN for text that is not a time, so a malformed window never matches). */
const clockMs = (day: string, hm: string, z: Zone) => zoneTime(day, +hm.slice(0, 2), +hm.slice(3, 5), z);
/**
 * Whether an instant is in the Ramadan chasing hours: on a Ramadan day, inside a window (`from` included, `to` not, so
 * 15:00 is out of a 10:00-15:00 window), or with no windows set, which means no restriction. On any other day there are
 * no Ramadan hours and this is false, so a caller asks it of a Ramadan day only (`cal.ramadan`).
 */
export function inRamadanWindow(ms: number, cal: CalData): boolean {
  const day = zoneDay(ms, cal.zone);
  if (!cal.ramadan.includes(day)) return false;
  return cal.ramadanHours.length === 0 || cal.ramadanHours.some((w) => ms >= clockMs(day, w.from, cal.zone) && ms < clockMs(day, w.to, cal.zone));
}
/**
 * Whether an instant is in Ramadan's off-hours: on a Ramadan day, and outside every window. False on every other day,
 * so it is the question to ask of any instant; `!inRamadanWindow` alone would call every ordinary day off-hours.
 */
export const outsideRamadanHours = (ms: number, cal: CalData) => cal.ramadan.includes(zoneDay(ms, cal.zone)) && !inRamadanWindow(ms, cal);

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** Why a quiet local day is quiet: the calendar's own entry, else the weekend. */
const quietWhy = (day: string, cal: CalData): QuietWhy => (hasOwn(cal.quiet, day) ? cal.quiet[day] : { kind: "weekend" });
/**
 * `firstWorkingMoment`, and what moved the moment there: `moved` is the reason of the last move (null when it did not
 * move), and `quiet` the reason of the quiet days the last run of quiet moves skipped, the named holiday when the run
 * held one (an Eid that runs into the weekend is the Eid).
 */
function settle(t: number, cal: CalData): { at: number; moved: "quiet" | "ramadan" | null; quiet?: QuietWhy } {
  const { zone, briefAt } = cal;
  const nextBrief = (day: string) => zoneTime(addDays(day, 1), briefAt.hh, briefAt.mm, zone);
  let at = t;
  let moved: "quiet" | "ramadan" | null = null;
  let quiet: QuietWhy | undefined;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const day = zoneDay(at, zone);
    if (isQuietDay(day, cal)) {
      const why = quietWhy(day, cal);
      if (moved !== "quiet" || !quiet || (quiet.kind === "weekend" && why.kind !== "weekend")) quiet = why;
      moved = "quiet";
      at = nextBrief(day);
      continue;
    }
    if (outsideRamadanHours(at, cal)) {
      const starts = cal.ramadanHours.map((w) => clockMs(day, w.from, zone)).filter((s) => s > at);
      at = starts.length ? Math.min(...starts) : nextBrief(day);
      moved = "ramadan";
      quiet = undefined;
      continue;
    }
    break;
  }
  return quiet ? { at, moved, quiet } : { at, moved };
}
/**
 * The earliest moment at or after `t` that is a working moment: not on a quiet day, and on a Ramadan day inside a window.
 * A moment on a quiet day goes to `briefAt` on the next day. On a Ramadan day outside the windows it goes to the next
 * window start that day, else to `briefAt` on the next day, and is checked again there. A moment already on a working
 * day is returned as it is, even when it is before `briefAt`: only quiet days and Ramadan's off-hours move a moment.
 * Gives up after a year of days (an all-quiet calendar) with the last moment tried.
 */
export const firstWorkingMoment = (t: number, cal: CalData): number => settle(t, cal).at;

/** Dates an item may carry: a year back (a late entry) to five years ahead. */
export const WHEN_RANGE = { backMs: 366 * DAY_MS, aheadMs: 5 * 366 * DAY_MS } as const;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A "YYYY-MM-DD" the day arithmetic can use (stored data is data: a malformed day must not throw). */
const isDay = (v: unknown): v is string => typeof v === "string" && DAY_RE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
const ZONED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const validDay = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

export type When = { ok: true; at: string | null; allDay: boolean } | { ok: false; error: "bad_date" | "date_out_of_range" };

/**
 * Read a due date or snooze time in the brand's zone. A date alone (`2026-10-02`) is due by the end of that local day;
 * a time without a zone (`2026-10-02T10:00`, what a datetime-local input sends) is local time; a time with `Z` or an
 * offset is that instant. Empty or null clears the date. Anything else, an impossible date (`2026-02-30`), or a date
 * outside `WHEN_RANGE` is refused, never guessed.
 */
export function parseWhen(v: unknown, now: number, z: Zone = DEFAULT_ZONE): When {
  if (v === null || v === undefined || v === "") return { ok: true, at: null, allDay: false };
  if (typeof v !== "string" || v.length > 40) return { ok: false, error: "bad_date" };
  const s = v.trim();
  let ms: number;
  let allDay = false;
  let m: RegExpExecArray | null;
  if ((m = DAY_RE.exec(s))) {
    if (!validDay(+m[1], +m[2], +m[3])) return { ok: false, error: "bad_date" };
    ms = endOfZoneDay(s, z);
    allDay = true;
  } else if ((m = LOCAL_RE.exec(s))) {
    if (!validDay(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59 || (m[6] !== undefined && +m[6] > 59)) return { ok: false, error: "bad_date" };
    ms = zoneTime(`${m[1]}-${m[2]}-${m[3]}`, +m[4], +m[5], z);
  } else if ((m = ZONED_RE.exec(s))) {
    if (!validDay(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59) return { ok: false, error: "bad_date" };
    ms = Date.parse(s);
    if (!Number.isFinite(ms)) return { ok: false, error: "bad_date" };
  } else return { ok: false, error: "bad_date" };
  if (ms < now - WHEN_RANGE.backMs || ms > now + WHEN_RANGE.aheadMs) return { ok: false, error: "date_out_of_range" };
  return { ok: true, at: new Date(ms).toISOString(), allDay };
}

/**
 * A due date as the owner reads it, in the brand's local time: «الجمعة 2 أكتوبر 10:00 ص» / "Friday, October 2, 10:00
 * AM". The year is added when it is not the current one; an all-day item shows the day only. Formatted through
 * `dateFormat`.
 */
export function formatWhen(iso: string, allDay: boolean, lang: "ar" | "en", nowMs?: number, z: Zone = DEFAULT_ZONE): string {
  const wall = new Date(Date.parse(iso) + zoneOffsetMs(z));
  if (!Number.isFinite(wall.getTime())) return "";
  const sameYear = nowMs === undefined || zoneDay(nowMs, z).slice(0, 4) === String(wall.getUTCFullYear());
  const dayOpts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) };
  // Newer ICU puts a narrow no-break space before AM/PM: one plain space everywhere, so the chat read-back, the page and
  // a test all see the same text.
  const plain = (x: string) => x.replace(/\s+/g, " ").trim();
  const time = plain(dateFormat(lang, { hour: "numeric", minute: "2-digit" }).format(wall));
  if (lang === "ar") {
    // «الجمعة 2 أكتوبر» without the comma and the «في» the Arabic locale puts between date and time.
    const day = plain(dateFormat("ar", dayOpts).formatToParts(wall).filter((p) => p.type !== "literal").map((p) => p.value).join(" "));
    return allDay ? day : `${day} ${time}`;
  }
  const day = plain(dateFormat("en", dayOpts).format(wall));
  return allDay ? day : `${day}, ${time}`;
}

/** "Riyadh time" / «بتوقيت الرياض»: how a date's zone is named next to it. */
export const zoneTimeLabel = (z: Zone, lang: "ar" | "en") => (lang === "ar" ? `بتوقيت ${ZONES[z].city.ar}` : `${ZONES[z].city.en} time`);

/**
 * The UTC hour the daily cron runs (`vercel.json`: `0 5 * * *`): the morning brief, and the reminder sweep that stands
 * in for the QStash tick when it is not running. Pinned against vercel.json in tests/secretary-phase2.test.ts.
 */
export const DAILY_CRON_UTC_HOUR = 5;
/**
 * The morning brief's local clock time in a zone, "08:00" in Riyadh, Kuwait, Doha and Manama, "09:00" in Dubai and
 * Muscat: what the owner is told when a reminder can only come with the next brief. Never a fixed "08:00".
 */
export const briefClock = (z: Zone) => {
  const { hh, mm } = briefTime(z);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};
/** The same local time as numbers: `CalData.briefAt`. */
const briefTime = (z: Zone) => {
  const min = (DAILY_CRON_UTC_HOUR * 60 + ZONES[z].offsetMin) % 1440;
  return { hh: Math.floor(min / 60), mm: min % 60 };
};

/**
 * The line every agent's prompt starts its volatile block with: the brand's local date and time, so relative dates
 * ("Thursday", "tomorrow 10am") are worked out from the real calendar, not the model's training data. The week start
 * comes from the brand's weekend when the caller has it (`CalData.weekend`), else from the zone's own.
 */
export function nowLine(clock: number, z: Zone = DEFAULT_ZONE, weekend: readonly number[] = ZONES[z].weekend): string {
  return `NOW (${ZONES[z].city.en}, ${zoneUtcLabel(z)}): ${formatWhen(new Date(clock).toISOString(), false, "en", clock, z)}, ${zoneDay(clock, z).slice(0, 4)}; today is ${zoneDay(clock, z)}. The work week starts on ${WEEKDAY_NAMES[weekStartDay(weekend)]}.`;
}

export const AGENDA_BUCKETS = ["overdue", "today", "confirm", "chase", "upcoming", "waiting", "later", "undated", "cold"] as const;
export type AgendaBucket = (typeof AGENDA_BUCKETS)[number];
export type AgendaReason = "overdue" | "due_today" | "due_soon" | "later" | "waiting_on_them" | "chase_due" | "chased" | "proposed_done" | "undated" | "cold" | "snoozed";
/**
 * do: the owner does it · chase: someone else owes it and the owner's follow-up is due · wait: someone else has it ·
 * confirm: say whether it is done · decide: an undated to-do nobody touched for two weeks: do it, date it or delete it.
 */
export type NextStep = "do" | "chase" | "wait" | "confirm" | "decide";
/**
 * When the owner may chase someone (`chaseMoment`). `anchor` is when the debt became chaseable, after the brand's quiet
 * days, Ramadan's off-hours and the contact's absence moved it; `at` is when chasing may happen, the anchor itself or,
 * when the anchor has passed and now is not a working moment, the next one. `why` explains `at`: the reason of the last
 * move, "away" once an absence moved it. `quiet` names the quiet days a "quiet" move skipped; `until` is the last day of
 * the absence an "away" move waited out.
 */
export type ChaseMoment = { anchor: number; at: number; why: "normal" | "away" | "quiet" | "ramadan"; quiet?: QuietWhy; until?: string };
/** `moment` is set for every item someone else owes (a contact or an agent), never for the owner's own. */
export type AgendaEntry = { item: SecItem; bucket: AgendaBucket; reason: AgendaReason; actionOwner: SecParty; next: NextStep; moment?: ChaseMoment };
export type Agenda = {
  now: string;
  /** The brand's zone, and the local day "today" means in it. */
  zone: Zone;
  today: string;
  buckets: Record<AgendaBucket, AgendaEntry[]>;
  counts: Record<AgendaBucket, number>;
  /** Snoozed items: hidden until their snooze ends, only counted. */
  snoozed: number;
  /** Open items, snoozed included. */
  open: number;
  /** Inbox items waiting for the owner's approval (`pendingCount`), so the agenda is the one queue. */
  approvals: number;
};
/** Upcoming = due within this many local days after today. */
export const UPCOMING_DAYS = 7;
/** The chase clock: working days the owner waits on someone before following up, and again after each follow-up. */
export const CHASE_WORKING_DAYS = 2;
/** An undated to-do of the owner's own that nobody changed for this many days goes cold. */
export const COLD_DAYS = 14;

/**
 * When the owner should next follow up on something someone else owes (null for the owner's own items): the due time;
 * without one, `expectBy` (two working days after creation when it was never set); after a follow-up, two working days
 * after it, and never before the due time. With the brand's calendar the working days skip its quiet days too.
 */
export function chaseAt(it: SecItem, z: Zone = DEFAULT_ZONE, cal?: CalData): number | null {
  if (it.owedBy === "owner") return null;
  const first = it.dueAt ? Date.parse(it.dueAt) : it.expectBy ? Date.parse(it.expectBy) : addWorkingDays(Date.parse(it.createdAt), CHASE_WORKING_DAYS, z, cal);
  return it.lastChasedAt ? Math.max(first, addWorkingDays(Date.parse(it.lastChasedAt), CHASE_WORKING_DAYS, z, cal)) : first;
}

/**
 * The one rule for when the owner may chase someone (spec §2.1), pure, with the brand's calendar and away map passed in.
 * From `chaseAt` (with the calendar): an agent's item is never moved (agents keep no weekend, Eid or holiday). A contact
 * away on that day is chased from `briefAt` on the day after the absence; then the moment leaves quiet days (to
 * `briefAt` on the next working day) and Ramadan's off-hours (to the next window start) — that is the anchor. Once the
 * anchor has passed, chasing still waits while today is quiet or outside Ramadan hours. Null for the owner's own items.
 */
export function chaseMoment(it: SecItem, now: number, cal: CalData, away: AwayMap): ChaseMoment | null {
  const z = cal.zone;
  const base = chaseAt(it, z, cal);
  if (base === null) return null;
  // An agent is never moved; neither is a date that is not one (the item's bucket stays what it was: waiting).
  if (isAgentId(it.owedBy) || !Number.isFinite(base)) return { anchor: base, at: base, why: "normal" };
  const key = partyKey(it.owedBy);
  const entry = key !== null && hasOwn(away, key) ? away[key] : undefined;
  // `until` is the last away day, inclusive; an entry that ended before the base's day does not apply.
  const until = entry && isDay(entry.until) ? entry.until : null;
  const gone = until !== null && until >= zoneDay(base, z) ? until : null;
  // Back from an absence: from the brief time of the first working day after it (ruling R10), never from midnight.
  const s = settle(gone ? zoneTime(addDays(gone, 1), cal.briefAt.hh, cal.briefAt.mm, z) : base, cal);
  const anchor = s.at;
  if (anchor <= now) {
    // Chaseable, but not while today is quiet or outside Ramadan hours.
    const p = settle(now, cal);
    if (p.moved) return { anchor, at: p.at, why: p.moved, ...(p.quiet ? { quiet: p.quiet } : {}) };
  }
  if (gone) return { anchor, at: anchor, why: "away", until: gone };
  if (s.moved === "quiet") return { anchor, at: anchor, why: "quiet", ...(s.quiet ? { quiet: s.quiet } : {}) };
  return { anchor, at: anchor, why: s.moved ?? "normal" };
}

/**
 * Where one open item stands at `now` in zone `z`. Null for an item that is not open (done or deleted). Items someone
 * else owes follow `chaseMoment` with the brand's calendar (the zone's own weekend when none is given) and away map,
 * and carry the moment.
 */
export function classify(
  it: SecItem, now: number, z: Zone = DEFAULT_ZONE, opts: { cal?: CalData; away?: AwayMap } = {},
): { bucket: AgendaBucket | "snoozed"; reason: AgendaReason; actionOwner: SecParty; next: NextStep; moment?: ChaseMoment } | null {
  if (it.deletedAt || it.completedAt) return null;
  const others = it.owedBy !== "owner";
  const moment = others ? chaseMoment(it, now, opts.cal ?? defaultCal(z), opts.away ?? {}) ?? undefined : undefined;
  const m = moment ? { moment } : {};
  // A proposal waits for the owner even when the item was snoozed before it: the owner must be able to confirm it now.
  if (it.proposedDone) return { bucket: "confirm", reason: "proposed_done", actionOwner: "owner", next: "confirm", ...m };
  if (it.snoozeUntil && Date.parse(it.snoozeUntil) > now) return { bucket: "snoozed", reason: "snoozed", actionOwner: it.owedBy, next: others ? "wait" : "do", ...m };
  const due = it.dueAt ? Date.parse(it.dueAt) : null;
  if (moment) {
    // The chase clock: past it, it is the owner's move (follow up); a follow-up starts it again. Before it (a quiet day,
    // Ramadan's off-hours, an absence) the item waits, even past its due date.
    if (moment.at <= now) {
      return due !== null && due < now ? { bucket: "overdue", reason: "overdue", actionOwner: "owner", next: "chase", moment } : { bucket: "chase", reason: "chase_due", actionOwner: "owner", next: "chase", moment };
    }
    return { bucket: "waiting", reason: due !== null && due < now ? "chased" : "waiting_on_them", actionOwner: it.owedBy, next: "wait", moment };
  }
  if (due !== null && due < now) return { bucket: "overdue", reason: "overdue", actionOwner: "owner", next: "do" };
  if (due === null) {
    return now - Date.parse(it.updatedAt) >= COLD_DAYS * DAY_MS ? { bucket: "cold", reason: "cold", actionOwner: "owner", next: "decide" } : { bucket: "undated", reason: "undated", actionOwner: "owner", next: "do" };
  }
  const today = zoneDay(now, z), day = zoneDay(due, z);
  if (day === today) return { bucket: "today", reason: "due_today", actionOwner: "owner", next: "do" };
  if (day <= addDays(today, UPCOMING_DAYS)) return { bucket: "upcoming", reason: "due_soon", actionOwner: "owner", next: "do" };
  return { bucket: "later", reason: "later", actionOwner: "owner", next: "do" };
}

const dueMs = (it: SecItem) => (it.dueAt ? Date.parse(it.dueAt) : Number.POSITIVE_INFINITY);
/** Critical first, then the earliest due (undated last), then priority, then oldest, then id: the same order every time. */
export function compareItems(a: SecItem, b: SecItem): number {
  if (a.critical !== b.critical) return a.critical ? -1 : 1;
  const da = dueMs(a), db = dueMs(b);
  if (da !== db) return da < db ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The agenda at `now`: every open item in exactly one bucket (or counted as snoozed), each bucket in a fixed order.
 * `cal` is the brand's work calendar (its zone is the agenda's when `zone` is not given); without one, the zone's own
 * weekend and nothing else. `away` is the brand's away map.
 */
export function computeAgenda(items: SecItem[], now: number, opts: { approvals?: number; zone?: Zone; cal?: CalData; away?: AwayMap } = {}): Agenda {
  const zone = opts.zone ?? opts.cal?.zone ?? DEFAULT_ZONE;
  const rule = { cal: opts.cal ?? defaultCal(zone), away: opts.away ?? {} };
  const buckets = Object.fromEntries(AGENDA_BUCKETS.map((b) => [b, [] as AgendaEntry[]])) as Record<AgendaBucket, AgendaEntry[]>;
  let snoozed = 0, open = 0;
  for (const item of [...items].sort(compareItems)) {
    const c = classify(item, now, zone, rule);
    if (!c) continue;
    open++;
    if (c.bucket === "snoozed") { snoozed++; continue; }
    buckets[c.bucket].push({ item, bucket: c.bucket, reason: c.reason, actionOwner: c.actionOwner, next: c.next, ...(c.moment ? { moment: c.moment } : {}) });
  }
  const counts = Object.fromEntries(AGENDA_BUCKETS.map((b) => [b, buckets[b].length])) as Record<AgendaBucket, number>;
  return { now: new Date(now).toISOString(), zone, today: zoneDay(now, zone), buckets, counts, snoozed, open, approvals: Math.max(0, opts.approvals ?? 0) };
}

/**
 * The days after an item fell behind on which it gets its own alert: that day, the next, the third and the seventh.
 * The owner's own items count local calendar days from the due time, and so do agents' items from their chase moment's
 * anchor (agents keep no weekend, Eid or holidays: spec §2.1 step 2, ruling R16); a contact's items count working days
 * (`workingDaysBetween`) from the local day of their chase moment's anchor, so a weekend or Eid loses no step (spec
 * §2.3). After the seventh it is only in the morning brief.
 */
export const ALERT_DAYS = [0, 1, 3, 7] as const;
export type AlertStep = (typeof ALERT_DAYS)[number];
/** The alert step for an item `d` days behind: 0 → 0, 1-2 → 1, 3-6 → 3, 7 → 7, else none. */
export function alertStep(d: number): AlertStep | null {
  if (!Number.isInteger(d) || d < 0 || d > ALERT_DAYS[ALERT_DAYS.length - 1]) return null;
  return [...ALERT_DAYS].reverse().find((s) => s <= d) ?? null;
}
/** The working days in (a, b]: the local days after `a`, up to and including `b`, that are not quiet. 0 when `b` is not after `a`. */
export function workingDaysBetween(a: string, b: string, cal: CalData): number {
  const span = daysBetween(a, b);
  let n = 0;
  for (let i = 1; i <= span; i++) if (!isQuietDay(addDays(a, i), cal)) n++;
  return n;
}
/** A contact: someone the owner chases who keeps the calendar (not the owner, not one of the agents). */
const isContact = (p: SecParty) => p !== "owner" && !isAgentId(p);
/**
 * A debt held for Ramadan hours later today (ruling R18): its chase moment `at` is later than `now`, on today's local
 * day, and today is a Ramadan day, whatever moved it there (Ramadan's off-hours, or the brief time after an absence that
 * ended in Ramadan). The 08:00 alert run and the morning brief name it: chasing opens today, at that time. It reads the
 * moment only: callers ask it about contacts' debts alone, since agents keep no Ramadan hours (ruling R16).
 */
export function heldForRamadanToday(m: ChaseMoment | undefined, now: number, cal: CalData): m is ChaseMoment {
  if (!m || !Number.isFinite(m.at) || m.at <= now) return false;
  const day = zoneDay(m.at, cal.zone);
  return day === zoneDay(now, cal.zone) && cal.ramadan.includes(day);
}
/**
 * One alert step an item is at now. `anchorMs` keys its marker: the due time for the owner's own item, the chase
 * moment's anchor for an item someone else owes. `days` is how far behind it is (working days for a contact's item,
 * calendar days otherwise). `send` is false when the step only holds (ruling R15): a contact's debt on a quiet day,
 * when chasing is paused, or one waiting past its anchor for a later window; its marker is kept alive, nothing is sent.
 * `ramadanToday` is the local "HH:mm" chasing opens today, for a debt held for Ramadan hours (`heldForRamadanToday`).
 */
export type OverdueAlert = { entry: AgendaEntry; days: number; step: AlertStep; anchorMs: number; send: boolean; ramadanToday?: string };
/**
 * The entries at an alert step now, in the order given (spec §2.3). The owner's own items: only when overdue, counted in
 * calendar days from the due time, any day, as before. An agent's: once its chase moment has passed, calendar days from
 * the anchor, any day (ruling R16). A contact's: once its anchor has passed, or while it is held for Ramadan hours later
 * today; counted in working days from the anchor's local day, and sent only on a working day when the agenda says chase
 * or it is held for Ramadan hours, otherwise held (`send: false`) so its step's marker can be kept alive.
 */
export function overdueAlerts(entries: AgendaEntry[], now: number, z: Zone = DEFAULT_ZONE, cal: CalData = defaultCal(z)): OverdueAlert[] {
  const today = zoneDay(now, z);
  const quietToday = isQuietDay(today, cal);
  return entries.flatMap((entry): OverdueAlert[] => {
    const it = entry.item;
    const contact = isContact(it.owedBy);
    let anchorMs: number;
    let send = true;
    let ramadanToday: string | undefined;
    if (it.owedBy === "owner") {
      if (entry.bucket !== "overdue" || !it.dueAt) return [];
      anchorMs = Date.parse(it.dueAt);
    } else {
      const m = entry.moment;
      if (!m) return [];
      // Only a contact is held for Ramadan hours: an agent's item waits for its own time, as on any day (ruling R16).
      const later = contact && entry.next === "wait" && heldForRamadanToday(m, now, cal);
      if (!(m.anchor <= now) && !later) return [];
      if (later) ramadanToday = zoneLocalInput(m.at, z).slice(11, 16);
      anchorMs = m.anchor;
      send = entry.next === "chase" || later;
      if (contact && quietToday) send = false;
    }
    if (!Number.isFinite(anchorMs)) return [];
    const from = zoneDay(anchorMs, z);
    // Seven working days never span more than the calendar's window: an older anchor is past its last step, uncounted.
    if (daysBetween(from, today) > MAX_SCAN_DAYS) return [];
    const days = contact ? workingDaysBetween(from, today, cal) : daysBetween(from, today);
    const step = alertStep(days);
    if (step === null) return [];
    return [{ entry, days, step, anchorMs, send, ...(ramadanToday ? { ramadanToday } : {}) }];
  });
}

/** A party as the owner reads it: "you" for the owner, the agent's name, or the contact label as written. */
export function partyName(p: SecParty | null, lang: "ar" | "en"): string {
  if (!p) return "";
  if (p === "owner") return lang === "ar" ? "أنت" : "you";
  if (isAgentId(p)) return agentById(p).name[lang];
  return p;
}

/**
 * The next step in one short phrase (`step`), and, while the chase rule holds the item back (`wait` with a moment that
 * is not "normal", ruling R9), why (`reason`, else ""): the contact's absence, the quiet day, or Ramadan's hours (spec
 * §2.2), with dates in the brand's zone and Latin digits. `quote` writes contact names as JSON strings (data, for an
 * agent's tool answer); `now` names the year of a date in another year, and the day of a Ramadan time that is not today.
 * The to-do page shows the two on their own lines (the reason under the WhatsApp link); everything else reads them as
 * one (`nextStepText`).
 */
export function nextStepParts(e: Pick<AgendaEntry, "next" | "item" | "moment">, lang: "ar" | "en", z: Zone = DEFAULT_ZONE, opts: { quote?: boolean; now?: number } = {}): { step: string; reason: string } {
  const p = e.item.owedBy;
  const name = partyName(p, lang);
  const who = opts.quote && p !== "owner" && !isAgentId(p) ? JSON.stringify(name) : name;
  const ar = lang === "ar";
  const only = (step: string) => ({ step, reason: "" });
  let step: string;
  switch (e.next) {
    case "chase": step = ar ? `تابِع مع ${who}` : `Chase ${who}`; break;
    case "wait": step = ar ? `بانتظار ${who}` : `Waiting on ${who}`; break;
    case "confirm": return only(ar ? "أكّد أنها أُنجزت أو ردّها" : "Confirm it is done, or send it back");
    case "decide": return only(ar ? "أنجزها أو حدّد لها موعداً أو احذفها" : "Do it, give it a date, or delete it");
    default: return only(ar ? "عليك أنت" : "Yours to do");
  }
  const m = e.moment;
  // A chaseable entry needs no reason: its moment has passed.
  if (e.next !== "wait" || !m || m.why === "normal") return only(step);
  if (!Number.isFinite(m.at)) return only(step);
  const day = (ms: number) => formatWhen(new Date(ms).toISOString(), true, lang, opts.now, z);
  let why = "";
  if (m.why === "away" && isDay(m.until)) {
    const date = day(endOfZoneDay(m.until, z));
    why = ar ? `${who}: غياب لين ${date}` : `${who}: away until ${date}`;
  } else if (m.why === "quiet") {
    const q = m.quiet;
    const reason = q?.name?.[lang] ?? (q?.kind === "weekend" || !q ? (ar ? "عطلة نهاية الأسبوع" : "the weekend") : ar ? "إجازة رسمية" : "a public holiday");
    why = ar ? `المتابعة ${day(m.at)} — ${reason}` : `Follow up ${day(m.at)}, ${reason}`;
  } else if (m.why === "ramadan") {
    const time = zoneLocalInput(m.at, z).slice(11, 16);
    const other = opts.now !== undefined && zoneDay(opts.now, z) !== zoneDay(m.at, z);
    const when = other ? (ar ? `${time} يوم ${day(m.at)}` : `${time} on ${day(m.at)}`) : time;
    why = ar ? `تابعه بعد ${when} (ساعات رمضان)` : `Follow up after ${when} (Ramadan hours)`;
  }
  return { step, reason: why };
}

/** The next step and, while the chase rule holds the item back, its reason after « · » (`nextStepParts` as one line). */
export function nextStepText(e: Pick<AgendaEntry, "next" | "item" | "moment">, lang: "ar" | "en", z: Zone = DEFAULT_ZONE, opts: { quote?: boolean; now?: number } = {}): string {
  const { step, reason } = nextStepParts(e, lang, z, opts);
  return reason ? `${step} · ${reason}` : step;
}

/**
 * An Arabic count with the counted noun in the form the number takes: 1 and 2 have their own phrases (singular, dual);
 * 3 to 10 take the plural; 11 to 99 the singular in the accusative (`many`, e.g. «عنصرًا»); a whole hundred and the
 * two numbers after it the singular in the genitive (`hundred`, e.g. «100 عنصر»; `many` when not given). Past 100 the last
 * two digits decide: «103 عناصر», «111 عنصرًا». 0 has its own phrase when given.
 */
export function arCount(n: number, f: { zero?: string; one: string; two: string; few: string; many: string; hundred?: string }): string {
  if (n === 0 && f.zero) return f.zero;
  if (n === 1) return f.one;
  if (n === 2) return f.two;
  const r = n % 100;
  if (r >= 3 && r <= 10) return `${n} ${f.few}`;
  if (n >= 100 && r <= 2) return `${n} ${f.hundred ?? f.many}`;
  return `${n} ${f.many}`;
}

/** The approvals inbox as one agenda line. */
export function approvalsLine(n: number, lang: "ar" | "en"): string {
  if (lang === "ar") return arCount(n, { zero: "لا شيء بانتظار موافقتك", one: "عنصر واحد بانتظار موافقتك", two: "عنصران بانتظار موافقتك", few: "عناصر بانتظار موافقتك", many: "عنصرًا بانتظار موافقتك", hundred: "عنصر بانتظار موافقتك" });
  return n === 0 ? "nothing waiting for your approval" : n === 1 ? "1 item waiting for your approval" : `${n} items waiting for your approval`;
}

/** A note as the reader sees it: the notes code writes (`not_yet`, `chased`, …) are worded in the reader's language. */
export function noteText(n: Pick<SecNote, "text" | "kind">, lang: "ar" | "en"): string {
  if (n.kind === "not_yet") return lang === "ar" ? `لم تُنجز بعد (المقترح: ${n.text})` : `Not done yet (proposed: ${n.text})`;
  if (n.kind === "chased") return lang === "ar" ? "تمت المتابعة" : "Followed up";
  if (n.kind === "reminded") return lang === "ar" ? "طلبت تذكيرك اليوم" : "You asked to be reminded";
  // A reopened item that was linked to an inbox item keeps that item's id in the note: the link itself goes on reopen.
  if (n.kind === "reopened") return n.text ? (lang === "ar" ? `أُعيد فتحها، وفُكّ ربطها بعنصر الصندوق ${n.text}` : `Reopened, and unlinked from inbox item ${n.text}`) : lang === "ar" ? "أُعيد فتحها" : "Reopened";
  if (n.kind === "two_open") return lang === "ar" ? "النسخة التالية مفتوحة ومعدّلة — صار عندك نسختان" : "The next copy is open and was edited; there are now two";
  return n.text;
}

/**
 * What code knows about the inbox item a to-do is linked to, read from the stored task: its title, status, when the
 * owner decided and where it was published. Never taken from an agent's words.
 */
export type LinkedFact = { title: string; status: "pending" | "approved" | "rejected"; decidedAt?: string; published?: { provider: string; url: string; status: string; at: string }[] };

/**
 * The checked fact next to an agent's claim, in the reader's language: the linked inbox item's state as stored, or ""
 * when the item has no link (nothing in the app to check it against). `null` is a link whose inbox item is gone.
 */
export function linkFactText(fact: LinkedFact | null | undefined, lang: "ar" | "en", now: number, z: Zone = DEFAULT_ZONE): string {
  if (fact === undefined) return "";
  const ar = lang === "ar";
  if (fact === null) return ar ? "العنصر المرتبط في صندوق الموافقة لم يعد موجوداً." : "The linked inbox item no longer exists.";
  const title = `«${fact.title.slice(0, 80)}»`;
  const when = fact.decidedAt ? formatWhen(fact.decidedAt, false, lang, now, z) : "";
  if (fact.status === "pending") return ar ? `العنصر المرتبط ${title} ما زال بانتظار موافقتك.` : `The linked inbox item ${title} is still waiting for your approval.`;
  if (fact.status === "rejected") return ar ? `العنصر المرتبط ${title} رُفض${when ? ` (${when})` : ""}.` : `The linked inbox item ${title} was rejected${when ? ` (${when})` : ""}.`;
  const pub = (fact.published ?? []).filter((p) => p.status === "published" || p.status === "draft").slice(-1)[0];
  const where = pub ? (ar ? `، ونُشر على ${pub.provider}${pub.status === "draft" ? " كمسودة" : ""}` : `, and ${pub.status === "draft" ? "saved as a draft" : "published"} on ${pub.provider}`) : "";
  // `decidedAt` is written only when a person decided; an item approved by a governance rule has none.
  if (!when) return ar ? `العنصر المرتبط ${title} معتمد${where}.` : `The linked inbox item ${title} is approved${where}.`;
  return ar ? `العنصر المرتبط ${title} اعتمدته أنت (${when})${where}.` : `You approved the linked inbox item ${title} (${when})${where}.`;
}

/**
 * The morning brief's agenda block: counts, and the titles of the first three overdue or due-today items. On a Ramadan
 * day a contact's debt held for Ramadan hours later today (`heldForRamadanToday`, with the calendar the agenda was
 * computed with: `agendaFor` returns it) counts as a chase, not as waiting (spec §2.2), and `chaseAfter` says how many of
 * the chases those are and the local "HH:mm" the first of them opens. An agent's item keeps no Ramadan hours (ruling R16):
 * it waits, as on any day.
 */
export type BriefAgenda = { overdue: number; today: number; waiting: number; confirm: number; chase?: number; chaseAfter?: { count: number; time: string }; top: string[] };
export function briefAgenda(a: Agenda & { cal?: CalData }): BriefAgenda {
  const cal = a.cal ?? defaultCal(a.zone), now = Date.parse(a.now);
  const later = a.buckets.waiting
    .filter((e) => isContact(e.item.owedBy))
    .map((e) => e.moment)
    .filter((m): m is ChaseMoment => heldForRamadanToday(m, now, cal))
    .map((m) => m.at);
  return {
    overdue: a.counts.overdue, today: a.counts.today, waiting: a.counts.waiting - later.length, confirm: a.counts.confirm, chase: a.counts.chase + later.length,
    ...(later.length ? { chaseAfter: { count: later.length, time: zoneLocalInput(Math.min(...later), a.zone).slice(11, 16) } } : {}),
    top: [...a.buckets.overdue, ...a.buckets.today].slice(0, 3).map((e) => e.item.title),
  };
}

// Recurring items: the Gregorian rule maths. Pure and browser-safe; the Hijri rules are in `./secretary-calendar`.

/** 0 Sunday … 6 Saturday, the weekday of a local day (YYYY-MM-DD). */
export const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
/** The first day of the week (`weekStart`: 0 Sunday … 6 Saturday) that holds `day`. */
export const weekStartOf = (day: string, weekStart: number) => addDays(day, -((weekdayOf(day) - weekStart + 7) % 7));
/**
 * `months` months after a day, on the same day of the month, or on `monthDay` when one is given (`-1` is the last day),
 * clamped to the target month's length. A clamped result is never fed back: callers count from the anchor, so 31 Jan
 * gives 28 Feb and then 31 Mar.
 */
export function addMonthsClamped(day: string, months: number, monthDay?: number): string {
  const y = +day.slice(0, 4), m = +day.slice(5, 7) - 1, d = +day.slice(8, 10);
  const last = new Date(Date.UTC(y, m + months + 1, 0));
  const len = last.getUTCDate();
  const want = monthDay === -1 ? len : Math.min(monthDay ?? d, len);
  return new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), want)).toISOString().slice(0, 10);
}

/** The local "HH:mm" of a rule as hours and minutes, or null for all-day (absent, or not a time). */
export const ruleClock = (time: string | undefined): { hh: number; mm: number } | null => {
  const t = time === undefined ? null : /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return t ? { hh: +t[1], mm: +t[2] } : null;
};

/** Candidate days of a Gregorian rule in order, none before the anchor or `low`, until `stop` (exclusive of later days). */
function* gregorianDays(rule: SecRepeat, low: string, stop: string, cal: CalData): Generator<string> {
  const n = Math.max(1, Math.floor(rule.interval) || 1);
  const from = low > rule.anchor ? low : rule.anchor;
  switch (rule.every) {
    case "day": {
      for (let k = Math.max(0, Math.ceil(daysBetween(rule.anchor, from) / n)); ; k++) {
        const d = addDays(rule.anchor, k * n);
        if (d > stop) return;
        yield d;
      }
    }
    case "workday": {
      for (let d = from; d <= stop; d = addDays(d, 1)) if (!isQuietDay(d, cal)) yield d;
      return;
    }
    case "week": {
      const ws = Number.isInteger(rule.weekStart) && rule.weekStart >= 0 && rule.weekStart <= 6 ? rule.weekStart : 0;
      const picked = [...new Set((rule.weekdays ?? []).filter((w) => Number.isInteger(w) && w >= 0 && w <= 6))];
      const offsets = (picked.length ? picked : [weekdayOf(rule.anchor)]).map((w) => (w - ws + 7) % 7).sort((a, b) => a - b);
      const first = weekStartOf(rule.anchor, ws);
      for (let k = Math.max(0, Math.floor(Math.floor(daysBetween(first, from) / 7) / n) - 1); ; k++) {
        const block = addDays(first, 7 * n * k);
        if (block > stop) return;
        for (const o of offsets) {
          const d = addDays(block, o);
          if (d >= rule.anchor && d <= stop) yield d;
        }
      }
    }
    case "month":
    case "year": {
      const step = rule.every === "year" ? 12 * n : n;
      const gap = (+from.slice(0, 4) - +rule.anchor.slice(0, 4)) * 12 + (+from.slice(5, 7) - +rule.anchor.slice(5, 7));
      for (let k = Math.max(0, Math.floor(gap / step) - 1); ; k++) {
        const d = addMonthsClamped(rule.anchor, k * step, rule.every === "month" ? rule.monthDay : undefined);
        if (d > stop) return;
        if (d >= rule.anchor) yield d;
      }
    }
    default:
      return;
  }
}

/**
 * The next copy's due date for a `day`, `workday`, `week`, `month` or `year` rule: the first candidate on the rule's
 * grid (counted from the anchor, clamped per candidate) that is after the copy being closed (`prevDueMs`) and, so missed
 * dates never pile up, not in the past: a timed copy must be after `now`, an all-day copy on today or later. `null` when
 * `until` has passed, when the search (366 × interval days from the later of the two) finds nothing, or for a Hijri rule.
 * `allDay` is true when the rule has no `time`.
 */
export function gregorianNext(rule: SecRepeat, prevDueMs: number, now: number, z: Zone, cal: CalData): { dueAt: string; allDay: boolean } | null {
  if (rule.every === "hmonth" || rule.every === "hyear") return null;
  const n = Math.max(1, Math.floor(rule.interval) || 1);
  const clock = ruleClock(rule.time);
  const today = zoneDay(now, z);
  const low = [zoneDay(prevDueMs, z), today].reduce((a, b) => (a > b ? a : b));
  const bound = addDays(low, 366 * n + 7);
  const stop = rule.until && rule.until < bound ? rule.until : bound;
  const startOfToday = zoneTime(today, 0, 0, z);
  for (const day of gregorianDays(rule, low, stop, cal)) {
    const at = clock ? zoneTime(day, clock.hh, clock.mm, z) : endOfZoneDay(day, z);
    if (at > prevDueMs && (clock ? at > now : at >= startOfToday)) return { dueAt: new Date(at).toISOString(), allDay: !clock };
  }
  return null;
}

const GREG_MONTHS = {
  ar: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
} as const;
const HIJRI_MONTHS = {
  ar: ["محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"],
  en: ["Muharram", "Safar", "Rabi al-awwal", "Rabi al-thani", "Jumada al-awwal", "Jumada al-thani", "Rajab", "Shaban", "Ramadan", "Shawwal", "Dhu al-Qadah", "Dhu al-Hijjah"],
} as const;
/** After «يوم»: «يوم أحد». */
const AR_WEEKDAYS = ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"] as const;
const AR_UNITS = {
  day: { one: "يوم", two: "يومين", few: "أيام", many: "يومًا" },
  week: { one: "أسبوع", two: "أسبوعين", few: "أسابيع", many: "أسبوعًا" },
  month: { one: "شهر", two: "شهرين", few: "أشهر", many: "شهرًا" },
  year: { one: "سنة", two: "سنتين", few: "سنوات", many: "سنة" },
  hmonth: { one: "شهر هجري", two: "شهرين هجريين", few: "أشهر هجرية", many: "شهرًا هجريًا" },
  hyear: { one: "سنة هجرية", two: "سنتين هجريتين", few: "سنوات هجرية", many: "سنة هجرية" },
} as const;
const EN_UNITS = { day: "day", week: "week", month: "month", year: "year", hmonth: "Hijri month", hyear: "Hijri year" } as const;

/**
 * A rule in one phrase in the reader's language: «يتكرر كل يوم أحد» / "Repeats every Sunday". Dual forms («كل أسبوعين»),
 * Latin digits. `hijri` is the Hijri month (1-12) and day of the anchor, which a yearly Hijri rule needs to name its
 * date (this module has no Hijri calendar); without it the phrase stops at "every Hijri year".
 */
export function repeatText(rule: SecRepeat, lang: "ar" | "en", hijri?: { month: number; day: number }): string {
  const ar = lang === "ar";
  const n = Math.max(1, Math.floor(rule.interval) || 1);
  const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : ar ? `${xs.slice(0, -1).join("، ")} و${xs[xs.length - 1]}` : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const anchorDay = +rule.anchor.slice(8, 10), anchorMonth = +rule.anchor.slice(5, 7) - 1;
  const every = rule.every;
  let text: string;
  if (every === "workday") text = ar ? "يتكرر كل يوم عمل" : "Repeats every working day";
  else {
    const unit = ar ? `كل ${arCount(n, AR_UNITS[every])}` : n === 1 ? `every ${EN_UNITS[every]}` : `every ${n} ${EN_UNITS[every]}s`;
    let tail = "";
    if (every === "week") {
      const picked = [...new Set((rule.weekdays ?? []).filter((w) => Number.isInteger(w) && w >= 0 && w <= 6))].sort((a, b) => a - b);
      const days = list((picked.length ? picked : [weekdayOf(rule.anchor)]).map((w) => (ar ? `يوم ${AR_WEEKDAYS[w]}` : WEEKDAY_NAMES[w])));
      if (n === 1) text = ar ? `يتكرر كل ${days}` : `Repeats every ${days}`;
      else text = ar ? `يتكرر ${unit}، ${days}` : `Repeats ${unit} on ${days}`;
      return finishRepeat(text, rule, ar);
    }
    if (every === "month" || every === "hmonth") {
      const d = rule.monthDay ?? (every === "month" ? anchorDay : undefined);
      if (d !== undefined) tail = d === -1 ? (ar ? "، آخر يوم" : " on the last day") : ar ? `، يوم ${d}` : ` on day ${d}`;
    } else if (every === "year") tail = ar ? `، في ${anchorDay} ${GREG_MONTHS.ar[anchorMonth]}` : ` on ${anchorDay} ${GREG_MONTHS.en[anchorMonth]}`;
    else if (every === "hyear" && hijri && hijri.month >= 1 && hijri.month <= 12) tail = ar ? `، في ${hijri.day} ${HIJRI_MONTHS.ar[hijri.month - 1]}` : ` on ${hijri.day} ${HIJRI_MONTHS.en[hijri.month - 1]}`;
    text = `${ar ? "يتكرر" : "Repeats"} ${unit}${tail}`;
  }
  return finishRepeat(text, rule, ar);
}

/** The time of day, the last day and the number of times a rule runs, added to its phrase. */
function finishRepeat(text: string, rule: SecRepeat, ar: boolean): string {
  let out = text;
  const clock = ruleClock(rule.time);
  if (clock) out += `${ar ? " الساعة " : " at "}${rule.time}`;
  if (rule.until) out += ar ? `، حتى ${rule.until}` : `, until ${rule.until}`;
  if (rule.count !== undefined) out += ar ? `، ${arCount(rule.count, { one: "مرة واحدة", two: "مرتين", few: "مرات", many: "مرة" })}` : rule.count === 1 ? ", once" : `, ${rule.count} times`;
  return out;
}
