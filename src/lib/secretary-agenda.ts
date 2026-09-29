/**
 * Reem's agenda, computed from the owner's items and the clock, never stored. A status saved on an item goes stale the
 * moment the clock passes its due time; derived here, "overdue" is always true when it is shown.
 *
 * Browser-safe: this module imports only `./dates` (import-free) and `./agents` (whose one import is a type), so the
 * to-do page and the server share one definition of the buckets, the Riyadh day and the date wording. Storage lives in
 * `./secretary.ts`, which is server only.
 *
 * Riyadh time. Saudi Arabia keeps UTC+3 all year (no daylight saving), so a Riyadh wall-clock time is the UTC instant
 * plus three hours. Days and times are computed with that fixed offset and formatted through `dateFormat` (which is
 * always UTC) on the shifted instant: no time-zone database, and the same answer on the server and in every browser.
 */
import { dateFormat } from "./dates";
import { agentById, isAgentId, type AgentId } from "./agents";

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
 * One note on an item. `kind: "not_yet"` is the note the owner's "Not yet" leaves: `text` holds the evidence that was
 * proposed, and `noteText` words it in the reader's language (the page in Arabic or English, a tool answer in English).
 */
export type SecNote = { at: string; by: SecActor; text: string; private: boolean; kind?: "not_yet" };

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
  /** ISO instant, or null for an undated item. Entered and shown in Riyadh time. */
  dueAt: string | null;
  /** Due "by the end of that day" (entered as a date only): dueAt is 23:59 Riyadh time and the time is not shown. */
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
  /** An agent or the owner's assistant thinks it is done; only the owner turns that into done. */
  proposedDone: { at: string; by: SecActor; evidence: string } | null;
  deletedAt: string | null;
  /** deletedAt + 30 days: restorable until then, purged by the daily job after. */
  expiresAt: string | null;
  /** Bumped on every write; a writer that read an older rev gets 409 `conflict`. */
  rev: number;
};

export const SEC_LIMITS = { title: 200, description: 2000, result: 1000, party: 80, note: 500, notes: 50, evidence: 500 } as const;
export const SEC_RESTORE_DAYS = 30;
/** The result written when code closes an item because the inbox item it points at was approved. */
export const AUTO_CLOSE_RESULT = "linked item approved";

export const RIYADH_OFFSET_MS = 3 * 3600_000;
const DAY_MS = 864e5;
/** The Riyadh calendar day (YYYY-MM-DD) of an instant. */
export const riyadhDay = (ms: number) => new Date(ms + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
/** The instant of a Riyadh wall-clock time on a Riyadh day. */
export const riyadhTime = (day: string, hh: number, mm: number) => Date.parse(`${day}T00:00:00Z`) + (hh * 60 + mm) * 60_000 - RIYADH_OFFSET_MS;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** "YYYY-MM-DDTHH:mm" in Riyadh time: the value a datetime-local input shows for this instant. */
export const riyadhLocalInput = (ms: number) => new Date(ms + RIYADH_OFFSET_MS).toISOString().slice(0, 16);
/** An all-day item is due at the last minute of its Riyadh day. */
export const endOfRiyadhDay = (day: string) => riyadhTime(addDays(day, 1), 0, 0) - 60_000;

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
 * Read a due date or snooze time. A date alone (`2026-10-02`) is due by the end of that Riyadh day; a time without a
 * zone (`2026-10-02T10:00`, what a datetime-local input sends) is Riyadh time; a time with `Z` or an offset is that
 * instant. Empty or null clears the date. Anything else, an impossible date (`2026-02-30`), or a date outside
 * `WHEN_RANGE` is refused, never guessed.
 */
export function parseWhen(v: unknown, now: number): When {
  if (v === null || v === undefined || v === "") return { ok: true, at: null, allDay: false };
  if (typeof v !== "string" || v.length > 40) return { ok: false, error: "bad_date" };
  const s = v.trim();
  let ms: number;
  let allDay = false;
  let m: RegExpExecArray | null;
  if ((m = DAY_RE.exec(s))) {
    if (!validDay(+m[1], +m[2], +m[3])) return { ok: false, error: "bad_date" };
    ms = endOfRiyadhDay(s);
    allDay = true;
  } else if ((m = LOCAL_RE.exec(s))) {
    if (!validDay(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59 || (m[6] !== undefined && +m[6] > 59)) return { ok: false, error: "bad_date" };
    ms = riyadhTime(`${m[1]}-${m[2]}-${m[3]}`, +m[4], +m[5]);
  } else if ((m = ZONED_RE.exec(s))) {
    if (!validDay(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59) return { ok: false, error: "bad_date" };
    ms = Date.parse(s);
    if (!Number.isFinite(ms)) return { ok: false, error: "bad_date" };
  } else return { ok: false, error: "bad_date" };
  if (ms < now - WHEN_RANGE.backMs || ms > now + WHEN_RANGE.aheadMs) return { ok: false, error: "date_out_of_range" };
  return { ok: true, at: new Date(ms).toISOString(), allDay };
}

/**
 * A due date as the owner reads it, in Riyadh time: «الجمعة 2 أكتوبر 10:00 ص» / "Friday, October 2, 10:00 AM". The year
 * is added when it is not the current one; an all-day item shows the day only. Formatted through `dateFormat`.
 */
export function formatWhen(iso: string, allDay: boolean, lang: "ar" | "en", nowMs?: number): string {
  const wall = new Date(Date.parse(iso) + RIYADH_OFFSET_MS);
  if (!Number.isFinite(wall.getTime())) return "";
  const sameYear = nowMs === undefined || riyadhDay(nowMs).slice(0, 4) === String(wall.getUTCFullYear());
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

export const AGENDA_BUCKETS = ["overdue", "today", "confirm", "upcoming", "waiting", "later", "undated"] as const;
export type AgendaBucket = (typeof AGENDA_BUCKETS)[number];
export type AgendaReason = "overdue" | "due_today" | "due_soon" | "later" | "waiting_on_them" | "proposed_done" | "undated" | "snoozed";
/** do: the owner does it · chase: someone else is late, the owner follows up · wait: someone else has it · confirm: say whether it is done. */
export type NextStep = "do" | "chase" | "wait" | "confirm";
export type AgendaEntry = { item: SecItem; bucket: AgendaBucket; reason: AgendaReason; actionOwner: SecParty; next: NextStep };
export type Agenda = {
  now: string;
  /** The Riyadh day "today" means. */
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
/** Upcoming = due within this many Riyadh days after today. */
export const UPCOMING_DAYS = 7;

/** Where one open item stands at `now`. Null for an item that is not open (done or deleted). */
export function classify(it: SecItem, now: number): { bucket: AgendaBucket | "snoozed"; reason: AgendaReason; actionOwner: SecParty; next: NextStep } | null {
  if (it.deletedAt || it.completedAt) return null;
  const others = it.owedBy !== "owner";
  // A proposal waits for the owner even when the item was snoozed before it: the owner must be able to confirm it now.
  if (it.proposedDone) return { bucket: "confirm", reason: "proposed_done", actionOwner: "owner", next: "confirm" };
  if (it.snoozeUntil && Date.parse(it.snoozeUntil) > now) return { bucket: "snoozed", reason: "snoozed", actionOwner: it.owedBy, next: others ? "wait" : "do" };
  const due = it.dueAt ? Date.parse(it.dueAt) : null;
  // Past due, it is the owner's move either way: do it, or chase whoever is late.
  if (due !== null && due < now) return { bucket: "overdue", reason: "overdue", actionOwner: "owner", next: others ? "chase" : "do" };
  if (others) return { bucket: "waiting", reason: "waiting_on_them", actionOwner: it.owedBy, next: "wait" };
  if (due === null) return { bucket: "undated", reason: "undated", actionOwner: "owner", next: "do" };
  const today = riyadhDay(now), day = riyadhDay(due);
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
export function computeAgenda(items: SecItem[], now: number, opts: { approvals?: number } = {}): Agenda {
  const buckets = Object.fromEntries(AGENDA_BUCKETS.map((b) => [b, [] as AgendaEntry[]])) as Record<AgendaBucket, AgendaEntry[]>;
  let snoozed = 0, open = 0;
  for (const item of [...items].sort(compareItems)) {
    const c = classify(item, now);
    if (!c) continue;
    open++;
    if (c.bucket === "snoozed") { snoozed++; continue; }
    buckets[c.bucket].push({ item, bucket: c.bucket, reason: c.reason, actionOwner: c.actionOwner, next: c.next });
  }
  const counts = Object.fromEntries(AGENDA_BUCKETS.map((b) => [b, buckets[b].length])) as Record<AgendaBucket, number>;
  return { now: new Date(now).toISOString(), today: riyadhDay(now), buckets, counts, snoozed, open, approvals: Math.max(0, opts.approvals ?? 0) };
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

/** A note as the reader sees it: the owner's "Not yet" note is worded in the reader's language around its evidence. */
export function noteText(n: Pick<SecNote, "text" | "kind">, lang: "ar" | "en"): string {
  if (n.kind === "not_yet") return lang === "ar" ? `لم تُنجز بعد (المقترح: ${n.text})` : `Not done yet (proposed: ${n.text})`;
  return n.text;
}

/** The morning brief's agenda block: counts, and the titles of the first three overdue or due-today items. */
export type BriefAgenda = { overdue: number; today: number; waiting: number; confirm: number; top: string[] };
export function briefAgenda(a: Agenda): BriefAgenda {
  return {
    overdue: a.counts.overdue, today: a.counts.today, waiting: a.counts.waiting, confirm: a.counts.confirm,
    top: [...a.buckets.overdue, ...a.buckets.today].slice(0, 3).map((e) => e.item.title),
  };
}
