/**
 * Contacts who are away (spec §3.1-§3.2): `sec:away:{scope}`, a hash whose field is `partyKey(label)` and whose value is
 * `{ label, until, note?, by, via, at }` (`until` is the last away day, local, inclusive). The agenda reads it through
 * `calFor` (`awayMapOf`, src/lib/secretary.ts) and chases such a contact only after the absence. Server only.
 *
 * Rules held in code, not in prompts:
 * - Contacts only. A label whose key is the key of an agent id or of an owner alias (`OWNER_ALIASES`: 'owner', 'me',
 *   'you', 'أنا') is `not_contact`, however it is typed («ＤＡＮＡ», «انا»). One contact is one field however its name is
 *   written (`partyKey`: «أحمد», «احمد» and «إحمد» are one), the label cleaned as an item's party is (`cleanLine`).
 * - `until` is today to today + `AWAY_AHEAD_DAYS` in the brand's zone (`away_range`); the note is one cleaned line of at
 *   most `AWAY_NOTE_MAX` characters.
 * - At most `AWAY_MAX` fields, ended ones (and unreadable ones) included (`away_limit`); replacing a contact adds none.
 * - Writes run under `withLock(scope, "away")` and leave one audit line each, `away` or `away_end`, with the login, the
 *   label and the date; never the note.
 * - Ending a running absence sets `until` to yesterday and keeps the entry for the "back" alert (rule 479, 7 days);
 *   ending one that has already ended removes the field, so ended entries cannot hold the cap for a month (ruling R19).
 *   The daily clean-up (`cleanAway`, from `secretaryDaily`) removes entries ended over `AWAY_KEEP_DAYS` days ago.
 * - Free: no credits, no model call. Every key is built from the caller's scope; the label is the only thing a request
 *   names, and it only ever becomes a field of that scope's hash.
 */
import { db } from "./db";
import { AGENT_IDS } from "./agents";
import type { Zone } from "./zones";
import { OWNER_ALIASES, SEC_KEYS, audit, cleanLine, fail, isLocalDay, withLock, type SecFail, type Who } from "./secretary";
import { SEC_LIMITS, addDays, daysBetween, partyKey, zoneDay } from "./secretary-agenda";

/** Fields in one brand's hash, ended entries included. */
export const AWAY_MAX = 200;
/** The last away day is at most this many days after today. */
export const AWAY_AHEAD_DAYS = 366;
/** Days an ended entry is kept after its last away day before the daily clean-up removes it (ruling R19). */
export const AWAY_KEEP_DAYS = 30;
/** The note's length after cleaning. */
export const AWAY_NOTE_MAX = 200;

export type AwayEntry = { label: string; until: string; note?: string; by: string; via: "web"; at: string };
/** What a request may set: nothing else in a body is read. */
export type AwayInput = { label: unknown; until: unknown; note?: unknown };

/** The lock id under `sec:lock:{scope}:…`: item ids start with "s" and 16 hex characters, so it names no item. */
const LOCK = "away";
/** Keys that name the owner or an agent, never a contact. */
const NOT_CONTACTS = new Set([...AGENT_IDS, ...OWNER_ALIASES].map((k) => partyKey(k)));
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A stored value as an entry (an object, or its JSON string), or null when it is not `{ label: string, until: day }`:
 * the values `awayMapOf` leaves out of the agenda, which the clean-up removes.
 */
function entryOf(raw: unknown): AwayEntry | null {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.label !== "string" || !isLocalDay(o.until)) return null;
  return {
    label: o.label, until: o.until, ...(typeof o.note === "string" && o.note ? { note: o.note } : {}),
    by: typeof o.by === "string" ? o.by : "", via: "web", at: typeof o.at === "string" ? o.at : "",
  };
}

/** A label from a request: a string, cleaned as an item's party, with a key of 1 to 80 characters. */
function labelOf(v: unknown): { ok: true; label: string; key: string } | SecFail {
  if (typeof v !== "string") return fail("bad_request", 400, "label");
  const label = cleanLine(v);
  if (label.length > SEC_LIMITS.party) return fail("too_long", 400, "label");
  const key = partyKey(label);
  if (key === null) return fail("too_long", 400, "label");
  // Nothing visible left (blank, or only soft hyphens and the like).
  if (!key) return fail("bad_request", 400, "label");
  return { ok: true, label, key };
}

/**
 * Check an absence before it is saved, `now` in the brand's `zone`: a contact's label (`bad_request`, `too_long`,
 * `not_contact`), a real day for `until` (`bad_date`) from today to today + 366 (`away_range`), and an optional note
 * (`bad_text`, `too_long` past 200 characters after `cleanLine`; a blank note is none). No store call.
 */
export function parseAway(raw: AwayInput, now: number, zone: Zone): { ok: true; key: string; label: string; until: string; note?: string } | SecFail {
  const l = labelOf(raw.label);
  if (!l.ok) return l;
  if (NOT_CONTACTS.has(l.key)) return fail("not_contact", 400, "label");
  const until = raw.until;
  if (!isLocalDay(until)) return fail("bad_date", 400, "until");
  const today = zoneDay(now, zone);
  if (until < today || daysBetween(today, until) > AWAY_AHEAD_DAYS) return fail("away_range", 400, "until");
  let note = "";
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== "string") return fail("bad_text", 400, "note");
    note = cleanLine(raw.note);
    if (note.length > AWAY_NOTE_MAX) return fail("too_long", 400, "note");
  }
  return { ok: true, key: l.key, label: l.label, until, ...(note ? { note } : {}) };
}

/**
 * Mark a contact away until `until` (inclusive), or replace their entry: checked by `parseAway`, then under the away
 * lock the hash is read once, the cap checked (a new field when 200 are stored is `away_limit`, 409), and the entry and
 * an `away` audit line written in one round. `by` is the acting login (`who.login`, else the actor).
 */
export async function setAway(scope: string, raw: AwayInput, who: Who, now: number, zone: Zone): Promise<{ ok: true; entry: AwayEntry } | SecFail> {
  const p = parseAway(raw, now, zone);
  if (!p.ok) return p;
  const entry: AwayEntry = { label: p.label, until: p.until, ...(p.note ? { note: p.note } : {}), by: who.login ?? who.actor, via: "web", at: new Date(now).toISOString() };
  return withLock(scope, LOCK, async (): Promise<{ ok: true; entry: AwayEntry } | SecFail> => {
    const rows = await db.hgetall<unknown>(SEC_KEYS.away(scope));
    if (!hasOwn(rows, p.key) && Object.keys(rows).length >= AWAY_MAX) return fail("away_limit", 409);
    await Promise.all([db.hset(SEC_KEYS.away(scope), p.key, entry), audit(scope, who, "away", "-", `label=${JSON.stringify(p.label)}; until=${p.until}`)]);
    return { ok: true, entry };
  });
}

/**
 * End a contact's absence now, `now` in the brand's `zone`. A running entry (until today or later) keeps its field with
 * `until` set to yesterday, so the "back" alert follows (`removed: false`); an entry that has already ended is removed
 * (`removed: true`, ruling R19). Either way one `away_end` audit line, in the same round as the write. A label with no
 * entry (or whose value is not one, which the daily clean-up removes) is `not_found`.
 */
export async function endAway(scope: string, label: unknown, who: Who, now: number, zone: Zone): Promise<{ ok: true; entry: AwayEntry; removed: boolean } | SecFail> {
  const l = labelOf(label);
  if (!l.ok) return l;
  const today = zoneDay(now, zone);
  return withLock(scope, LOCK, async (): Promise<{ ok: true; entry: AwayEntry; removed: boolean } | SecFail> => {
    const rows = await db.hgetall<unknown>(SEC_KEYS.away(scope));
    const cur = hasOwn(rows, l.key) ? entryOf(rows[l.key]) : null;
    if (!cur) return fail("not_found", 404);
    const name = `label=${JSON.stringify(cur.label)}`;
    if (cur.until < today) {
      await Promise.all([db.hdel(SEC_KEYS.away(scope), l.key), audit(scope, who, "away_end", "-", `${name}; removed`)]);
      return { ok: true, entry: cur, removed: true };
    }
    const entry: AwayEntry = { ...cur, until: addDays(today, -1), by: who.login ?? who.actor, at: new Date(now).toISOString() };
    await Promise.all([db.hset(SEC_KEYS.away(scope), l.key, entry), audit(scope, who, "away_end", "-", `${name}; until=${entry.until}`)]);
    return { ok: true, entry, removed: false };
  });
}

/** Running absences first, the soonest back first; then ended ones, the latest ended first; then by label. */
function byReturn(a: AwayEntry & { ended: boolean }, b: AwayEntry & { ended: boolean }): number {
  if (a.ended !== b.ended) return a.ended ? 1 : -1;
  return (a.ended ? b.until.localeCompare(a.until) : a.until.localeCompare(b.until)) || a.label.localeCompare(b.label);
}

/**
 * The brand's away list at `now` in `zone`, one read: every stored entry, `ended` once its last away day is before
 * today (kept until the clean-up, so the owner can see and remove what holds the cap). Values that are not entries are
 * left out.
 */
export async function listAway(scope: string, now: number, zone: Zone): Promise<(AwayEntry & { ended: boolean })[]> {
  const today = zoneDay(now, zone);
  const rows = await db.hgetall<unknown>(SEC_KEYS.away(scope));
  return Object.values(rows)
    .flatMap((raw) => {
      const e = entryOf(raw);
      return e ? [{ ...e, ended: e.until < today }] : [];
    })
    .sort(byReturn);
}

/**
 * The daily clean-up: removes the fields whose last away day is more than `AWAY_KEEP_DAYS` days before today (and values
 * that are not entries). One read when there is nothing to remove; otherwise, under the away lock, the hash is read
 * again (a write may have replaced an old entry meanwhile) and every field goes in one round of HDEL, with one
 * `away_clean` audit line. Returns how many were removed (0 when the lock is busy: the next day's run takes them).
 */
export async function cleanAway(scope: string, now: number, zone: Zone): Promise<number> {
  const today = zoneDay(now, zone);
  const stale = (rows: Record<string, unknown>) => Object.entries(rows).filter(([, raw]) => {
    const e = entryOf(raw);
    return !e || daysBetween(e.until, today) > AWAY_KEEP_DAYS;
  }).map(([field]) => field);
  if (!stale(await db.hgetall<unknown>(SEC_KEYS.away(scope))).length) return 0;
  const r = await withLock(scope, LOCK, async () => {
    const gone = stale(await db.hgetall<unknown>(SEC_KEYS.away(scope)));
    if (!gone.length) return 0;
    await Promise.all([
      ...gone.map((field) => db.hdel(SEC_KEYS.away(scope), field)),
      audit(scope, { actor: "cron", via: "cron" }, "away_clean", "-", `${gone.length} away contact(s) ended over ${AWAY_KEEP_DAYS} days ago`),
    ]);
    return gone.length;
  });
  return typeof r === "number" ? r : 0;
}
