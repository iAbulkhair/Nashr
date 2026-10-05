/**
 * Reem B3: the pure meeting helpers (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §6). A `Meeting` is one
 * synced event of the brand's marketing calendar. Importers: src/lib/secretary-cal-link.ts (the store) and, in later
 * tasks, the agenda, the quiet hold and `free_slots`. No I/O here; titles are untrusted text and are never rendered as HTML.
 */
import { addDays, zoneDay, zoneTime } from "./secretary-agenda";
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
