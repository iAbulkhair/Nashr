/**
 * Reem, the secretary: the brand's zone, work calendar and away map, read in one round (`calFor`).
 */
import { db } from "./db";
import { getBrand } from "./brand";
import { zoneOf, type Zone } from "./zones";
import { zoneDay, type AwayMap, type CalData } from "./secretary-agenda";
import { workCalendar, type SecCalendar } from "./secretary-calendar";
import { log } from "./log";
import { SEC_KEYS } from "./secretary-keys";

/** The zone a brand scope keeps its list in: one read of the brand file. */
export async function zoneFor(scope: string): Promise<Zone> {
  return zoneOf(await getBrand(scope));
}

/**
 * Stored Working days settings as they are used: the object itself when it is settings the calendar can be built from,
 * else null (every default of the zone's country). Anything that is not a settings object (absent, or a value that is
 * not one), and a settings object the calendar cannot be built from (a malformed field, e.g. `holidays.add: "x"`), is
 * null: a bad record never stops the agenda, a chat turn or the Working days page. Only the error's name is logged,
 * never the stored value.
 */
export function usableCalendar(stored: unknown, zone: Zone, now: number): SecCalendar | null {
  const own = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as SecCalendar) : null;
  if (!own) return null;
  try {
    workCalendar(own, zone, now);
    return own;
  } catch (e) {
    log.error("sec calendar unreadable, defaults used", e);
    return null;
  }
}

/** Stored Working days settings as the calendar the agenda reads (`workCalendar`, memoised per zone, local day and settings). */
export function calendarOf(stored: unknown, zone: Zone, now: number): CalData {
  return workCalendar(usableCalendar(stored, zone, now), zone, now);
}

const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day written "YYYY-MM-DD" (2026-13-01 and 2026-02-30 are not). */
export const isLocalDay = (v: unknown): v is string => {
  if (typeof v !== "string" || !LOCAL_DAY.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};
/**
 * The away hash (`sec:away:{scope}`) as the agenda reads it (ruling R3): per field, the entry's `label` and `until`, and
 * `endedAt` = `until` once `until` is before today (local, in the brand's zone): the absence is over, and the entry is
 * kept a few days for the "back" alert. A value stored as a JSON string is read the same as an object; a value that is
 * not `{ label: string, until: "YYYY-MM-DD" }` is left out, silently (stored data is data).
 */
export function awayMapOf(rows: Record<string, unknown> | null | undefined, now: number, zone: Zone): AwayMap {
  const today = zoneDay(now, zone);
  return Object.fromEntries(Object.entries(rows ?? {}).flatMap(([key, raw]): [string, AwayMap[string]][] => {
    let v = raw;
    if (typeof v === "string") {
      try { v = JSON.parse(v); } catch { return []; }
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return [];
    const { label, until } = v as { label?: unknown; until?: unknown };
    if (typeof label !== "string" || !isLocalDay(until)) return [];
    return [[key, { label, until, ...(until < today ? { endedAt: until } : {}) }]];
  }));
}

/** The three records every date of the list is computed against, read in one round: the brand file (its zone), `sec:cal` and `sec:away`. */
export async function calReads(scope: string) {
  const [brand, stored, rows] = await Promise.all([getBrand(scope), db.get<unknown>(SEC_KEYS.cal(scope)), db.hgetall<unknown>(SEC_KEYS.away(scope))]);
  return { brand, stored, rows };
}
type CalReads = Awaited<ReturnType<typeof calReads>>;
export const calOf = (r: CalReads, now: number): { zone: Zone; cal: CalData; away: AwayMap } => {
  const zone = zoneOf(r.brand);
  return { zone, cal: calendarOf(r.stored, zone, now), away: awayMapOf(r.rows, now, zone) };
};

/**
 * The brand's zone, work calendar and away map at `now`: the brand file, `sec:cal` and `sec:away`, read in one round.
 * What every date the list computes is read against: the agenda, the evening wrap, a new chase clock (`expectBy`), the
 * owner's snooze presets.
 */
export async function calFor(scope: string, now = Date.now()): Promise<{ zone: Zone; cal: CalData; away: AwayMap }> {
  return calOf(await calReads(scope), now);
}
