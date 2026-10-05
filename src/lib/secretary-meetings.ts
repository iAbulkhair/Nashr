/**
 * Reem B3: the pure meeting helpers (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §6). A `Meeting` is one
 * synced event of the brand's marketing calendar. Importers: src/lib/secretary-cal-link.ts (the store) and, in later
 * tasks, the agenda, the quiet hold and `free_slots`. No I/O here; titles are untrusted text and are never rendered as HTML.
 */
import { addDays, zoneDay, zoneTime } from "./secretary-agenda";
import { cleanLine } from "./secretary";
import type { Zone } from "./zones";

/** Start and end are ISO UTC instants. A private event is stored with `title: ""` and `private: true` (ruling P1). */
export type Meeting = { start: string; end: string; title: string; allDay: boolean; private?: true };

/** What a reader shows for a meeting: its title, or «مشغول» / "Busy" when the event is private. */
export const meetingTitle = (m: Meeting, lang: "ar" | "en"): string => (m.private ? (lang === "ar" ? "مشغول" : "Busy") : m.title);

/**
 * The meetings that overlap the zone's local today, earliest first. One overlaps when it starts before the end of the
 * day and ends after its start, so a meeting ending exactly at local 00:00 is yesterday's and one that crosses midnight
 * belongs to both days.
 */
export function todayMeetings(meetings: Meeting[], zone: Zone, now: number): Meeting[] {
  const today = zoneDay(now, zone);
  const dayStart = zoneTime(today, 0, 0, zone);
  const dayEnd = zoneTime(addDays(today, 1), 0, 0, zone);
  return meetings
    .map((m) => ({ m, s: Date.parse(m.start), e: Date.parse(m.end) }))
    .filter(({ s, e }) => Number.isFinite(s) && Number.isFinite(e) && s < dayEnd && e > dayStart)
    .sort((a, b) => a.s - b.s || a.e - b.e)
    .map(({ m }) => m);
}

/** A stored title is at most this many characters (spec §6). */
export const CAL_TITLE_MAX = 120;
/** The most meetings one sync keeps (spec §6). */
const CAL_MAX_EVENTS = 300;
const HALF_DAY_MS = 12 * 3_600_000;

/** Google events, only the fields the sync asks for (`fields=items(...)`). Everything in it is untrusted provider data. */
export type GEvent = {
  status?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  transparency?: string;
  visibility?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
};
/** Microsoft Graph events, only the fields the sync asks for (`$select=...`). Untrusted provider data. */
export type GraphEvent = {
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  showAs?: string;
  isCancelled?: boolean;
  sensitivity?: string;
  responseStatus?: { response?: string };
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The title of an event: the item-title cleanup (`cleanLine`), then cut to 120 characters without leaving half of an emoji. */
function cleanTitle(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = cleanLine(v).slice(0, CAL_TITLE_MAX);
  return /[\ud800-\udbff]$/.test(s) ? s.slice(0, -1) : s;
}

/** A real calendar day "YYYY-MM-DD" (no "2026-13-45"), or null. */
function dateOnly(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

/** Google gives an offset on every `dateTime`; one without it is not trusted. */
function googleInstant(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Graph (asked for UTC) gives a time with no zone letter, such as "2026-10-05T09:00:00.0000000": that is UTC. */
function graphInstant(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const mt = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(v);
  if (!mt) return null;
  const t = Date.parse(`${mt[1]}.${(mt[2] ?? "").padEnd(3, "0").slice(0, 3)}${mt[3] ?? "Z"}`);
  return Number.isFinite(t) ? t : null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Keep a Google event, or null: cancelled, declined by the owner (`attendees[self]`) and free (`transparency:
 * "transparent"`) are dropped. A timed event is stored as UTC instants; an all-day one (`start.date`, the end exclusive) as
 * the brand zone's local-midnight bounds (ruling R6), which Google marks busy unless it is transparent. A private event is
 * stored with `title: ""` and `private: true` (ruling P1). A malformed event is null, never an error.
 */
export function keepGoogle(e: GEvent, zone: Zone): Meeting | null {
  if (!isObj(e)) return null;
  if (e.status === "cancelled" || e.transparency === "transparent") return null;
  if (Array.isArray(e.attendees) && e.attendees.some((a) => isObj(a) && a.self === true && a.responseStatus === "declined")) return null;
  if (!isObj(e.start) || !isObj(e.end)) return null;
  let s: number | null;
  let en: number | null;
  let allDay = false;
  if (e.start.date !== undefined || e.end.date !== undefined) {
    const d0 = dateOnly(e.start.date);
    const d1 = dateOnly(e.end.date);
    if (!d0 || !d1) return null;
    s = zoneTime(d0, 0, 0, zone);
    en = zoneTime(d1, 0, 0, zone);
    allDay = true;
  } else {
    s = googleInstant(e.start.dateTime);
    en = googleInstant(e.end.dateTime);
  }
  if (s === null || en === null || en <= s) return null;
  const priv = e.visibility === "private";
  return { start: iso(s), end: iso(en), title: priv ? "" : cleanTitle(e.summary), allDay, ...(priv ? { private: true as const } : {}) };
}

/**
 * Keep a Graph event, or null: cancelled, declined (`responseStatus.response`) and free (`showAs: "free"`) are dropped, and an
 * all-day event is kept only when `showAs` is "busy". Graph's all-day times can come as UTC midnight or as the UTC form of the
 * event's own local midnight, so each instant is rounded to the nearest local midnight of the brand zone (12 hours or later
 * rounds forward) and stored as that midnight (ruling R6). A private event is stored with `title: ""` and `private: true`.
 */
export function keepGraph(e: GraphEvent, zone: Zone): Meeting | null {
  if (!isObj(e)) return null;
  if (e.isCancelled === true || e.showAs === "free") return null;
  if (isObj(e.responseStatus) && e.responseStatus.response === "declined") return null;
  if (!isObj(e.start) || !isObj(e.end)) return null;
  let s = graphInstant(e.start.dateTime);
  let en = graphInstant(e.end.dateTime);
  if (s === null || en === null) return null;
  const allDay = e.isAllDay === true;
  if (allDay) {
    if (e.showAs !== "busy") return null;
    s = zoneTime(zoneDay(s + HALF_DAY_MS, zone), 0, 0, zone);
    en = zoneTime(zoneDay(en + HALF_DAY_MS, zone), 0, 0, zone);
  }
  if (en <= s) return null;
  const priv = e.sensitivity === "private";
  return { start: iso(s), end: iso(en), title: priv ? "" : cleanTitle(e.subject), allDay, ...(priv ? { private: true as const } : {}) };
}

/** Earliest first, at most 300 (spec §6). */
export function limitMeetings(list: Meeting[]): Meeting[] {
  return list
    .map((m) => ({ m, s: Date.parse(m.start), e: Date.parse(m.end) }))
    .sort((a, b) => a.s - b.s || a.e - b.e)
    .slice(0, CAL_MAX_EVENTS)
    .map(({ m }) => m);
}
