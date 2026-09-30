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
import { DEFAULT_ZONE, ZONES, isWeekend, weekStart, zoneOffsetMs, zoneUtcLabel, type Zone } from "./zones";

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
 * (its `text` is the id of the inbox item the reopen unlinked it from, or empty).
 */
export type SecNote = { at: string; by: SecActor; text: string; private: boolean; kind?: "not_yet" | "chased" | "reminded" | "reopened" };

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

/**
 * `n` working days after an instant, at the same local time, skipping the zone's weekend (Friday and Saturday; Saturday
 * and Sunday in the UAE). Started on a weekend day, the count begins at the next working day.
 */
export function addWorkingDays(ms: number, n: number, z: Zone = DEFAULT_ZONE): number {
  const start = zoneDay(ms, z);
  let day = start;
  for (let left = n; left > 0; ) {
    day = addDays(day, 1);
    if (!isWeekend(z, new Date(`${day}T00:00:00Z`).getUTCDay())) left--;
  }
  return ms + daysBetween(start, day) * DAY_MS;
}

/** Dates an item may carry: a year back (a late entry) to five years ahead. */
export const WHEN_RANGE = { backMs: 366 * DAY_MS, aheadMs: 5 * 366 * DAY_MS } as const;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
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
  const min = (DAILY_CRON_UTC_HOUR * 60 + ZONES[z].offsetMin) % 1440;
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
};

/**
 * The line every agent's prompt starts its volatile block with: the brand's local date and time, so relative dates
 * ("Thursday", "tomorrow 10am") are worked out from the real calendar, not the model's training data.
 */
export function nowLine(clock: number, z: Zone = DEFAULT_ZONE): string {
  return `NOW (${ZONES[z].city.en}, ${zoneUtcLabel(z)}): ${formatWhen(new Date(clock).toISOString(), false, "en", clock, z)}, ${zoneDay(clock, z).slice(0, 4)}; today is ${zoneDay(clock, z)}. The work week starts on ${weekStart(z)}.`;
}

export const AGENDA_BUCKETS = ["overdue", "today", "confirm", "chase", "upcoming", "waiting", "later", "undated", "cold"] as const;
export type AgendaBucket = (typeof AGENDA_BUCKETS)[number];
export type AgendaReason = "overdue" | "due_today" | "due_soon" | "later" | "waiting_on_them" | "chase_due" | "chased" | "proposed_done" | "undated" | "cold" | "snoozed";
/**
 * do: the owner does it · chase: someone else owes it and the owner's follow-up is due · wait: someone else has it ·
 * confirm: say whether it is done · decide: an undated to-do nobody touched for two weeks: do it, date it or delete it.
 */
export type NextStep = "do" | "chase" | "wait" | "confirm" | "decide";
export type AgendaEntry = { item: SecItem; bucket: AgendaBucket; reason: AgendaReason; actionOwner: SecParty; next: NextStep };
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
 * after it, and never before the due time.
 */
export function chaseAt(it: SecItem, z: Zone = DEFAULT_ZONE): number | null {
  if (it.owedBy === "owner") return null;
  const first = it.dueAt ? Date.parse(it.dueAt) : it.expectBy ? Date.parse(it.expectBy) : addWorkingDays(Date.parse(it.createdAt), CHASE_WORKING_DAYS, z);
  return it.lastChasedAt ? Math.max(first, addWorkingDays(Date.parse(it.lastChasedAt), CHASE_WORKING_DAYS, z)) : first;
}

/** Where one open item stands at `now` in zone `z`. Null for an item that is not open (done or deleted). */
export function classify(it: SecItem, now: number, z: Zone = DEFAULT_ZONE): { bucket: AgendaBucket | "snoozed"; reason: AgendaReason; actionOwner: SecParty; next: NextStep } | null {
  if (it.deletedAt || it.completedAt) return null;
  const others = it.owedBy !== "owner";
  // A proposal waits for the owner even when the item was snoozed before it: the owner must be able to confirm it now.
  if (it.proposedDone) return { bucket: "confirm", reason: "proposed_done", actionOwner: "owner", next: "confirm" };
  if (it.snoozeUntil && Date.parse(it.snoozeUntil) > now) return { bucket: "snoozed", reason: "snoozed", actionOwner: it.owedBy, next: others ? "wait" : "do" };
  const due = it.dueAt ? Date.parse(it.dueAt) : null;
  if (others) {
    // The chase clock: past it, it is the owner's move (follow up); a follow-up starts it again.
    if (chaseAt(it, z)! <= now) {
      return due !== null && due < now ? { bucket: "overdue", reason: "overdue", actionOwner: "owner", next: "chase" } : { bucket: "chase", reason: "chase_due", actionOwner: "owner", next: "chase" };
    }
    return { bucket: "waiting", reason: due !== null && due < now ? "chased" : "waiting_on_them", actionOwner: it.owedBy, next: "wait" };
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

/** The agenda at `now`: every open item in exactly one bucket (or counted as snoozed), each bucket in a fixed order. */
export function computeAgenda(items: SecItem[], now: number, opts: { approvals?: number; zone?: Zone } = {}): Agenda {
  const zone = opts.zone ?? DEFAULT_ZONE;
  const buckets = Object.fromEntries(AGENDA_BUCKETS.map((b) => [b, [] as AgendaEntry[]])) as Record<AgendaBucket, AgendaEntry[]>;
  let snoozed = 0, open = 0;
  for (const item of [...items].sort(compareItems)) {
    const c = classify(item, now, zone);
    if (!c) continue;
    open++;
    if (c.bucket === "snoozed") { snoozed++; continue; }
    buckets[c.bucket].push({ item, bucket: c.bucket, reason: c.reason, actionOwner: c.actionOwner, next: c.next });
  }
  const counts = Object.fromEntries(AGENDA_BUCKETS.map((b) => [b, buckets[b].length])) as Record<AgendaBucket, number>;
  return { now: new Date(now).toISOString(), zone, today: zoneDay(now, zone), buckets, counts, snoozed, open, approvals: Math.max(0, opts.approvals ?? 0) };
}

/**
 * The days after an item became overdue on which it gets its own alert: that day, the next, the third and the seventh
 * (local days). After the seventh it is only in the morning brief.
 */
export const ALERT_DAYS = [0, 1, 3, 7] as const;
/** The alert step for an item overdue for `d` local days: 0 → 0, 1-2 → 1, 3-6 → 3, 7 → 7, else none. */
export function alertStep(d: number): (typeof ALERT_DAYS)[number] | null {
  if (!Number.isInteger(d) || d < 0 || d > ALERT_DAYS[ALERT_DAYS.length - 1]) return null;
  return [...ALERT_DAYS].reverse().find((s) => s <= d) ?? null;
}
/** The overdue entries that are at an alert step now, in agenda order (critical first, then the earliest due). */
export function overdueAlerts(overdue: AgendaEntry[], now: number, z: Zone = DEFAULT_ZONE): { entry: AgendaEntry; days: number; step: (typeof ALERT_DAYS)[number] }[] {
  const today = zoneDay(now, z);
  return overdue.flatMap((entry) => {
    if (!entry.item.dueAt) return [];
    const days = daysBetween(zoneDay(Date.parse(entry.item.dueAt), z), today);
    const step = alertStep(days);
    return step === null ? [] : [{ entry, days, step }];
  });
}

/** A party as the owner reads it: "you" for the owner, the agent's name, or the contact label as written. */
export function partyName(p: SecParty | null, lang: "ar" | "en"): string {
  if (!p) return "";
  if (p === "owner") return lang === "ar" ? "أنت" : "you";
  if (isAgentId(p)) return agentById(p).name[lang];
  return p;
}

/** The next step in one short phrase. */
export function nextStepText(e: Pick<AgendaEntry, "next" | "item">, lang: "ar" | "en"): string {
  const who = partyName(e.item.owedBy, lang);
  const ar = lang === "ar";
  switch (e.next) {
    case "chase": return ar ? `تابِع مع ${who}` : `Chase ${who}`;
    case "wait": return ar ? `بانتظار ${who}` : `Waiting on ${who}`;
    case "confirm": return ar ? "أكّد أنها أُنجزت أو ردّها" : "Confirm it is done, or send it back";
    case "decide": return ar ? "أنجزها أو حدّد لها موعداً أو احذفها" : "Do it, give it a date, or delete it";
    default: return ar ? "عليك أنت" : "Yours to do";
  }
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

/** The morning brief's agenda block: counts, and the titles of the first three overdue or due-today items. */
export type BriefAgenda = { overdue: number; today: number; waiting: number; confirm: number; chase?: number; top: string[] };
export function briefAgenda(a: Agenda): BriefAgenda {
  return {
    overdue: a.counts.overdue, today: a.counts.today, waiting: a.counts.waiting, confirm: a.counts.confirm, chase: a.counts.chase,
    top: [...a.buckets.overdue, ...a.buckets.today].slice(0, 3).map((e) => e.item.title),
  };
}
