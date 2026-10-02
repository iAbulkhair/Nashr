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
 *   ending it again changes nothing (ruling R21: a double click on "End now" must not lose the back alert). Only an
 *   explicit remove deletes a field, so the owner can free ended entries from the cap (ruling R19). The daily clean-up
 *   (`cleanAway`, from `secretaryDaily`) removes entries ended over `AWAY_KEEP_DAYS` days ago.
 * - A key the store's HGETALL cannot give back as a field (`__proto__`, `constructor`, `prototype`) is `bad_request`
 *   (ruling R22): such a field would be invisible, unendable and never cleaned.
 * - From Reem's chat an absence is only proposed (`proposeAway`, the `contact_away` tool, spec §3.2): a record of 7 days
 *   shown as a card, which a person with `todo.write` saves or dismisses (`decideAwayProposal`, once); Save runs
 *   `setAway` / `endAway` above, so every check holds again when it is pressed.
 * - Free: no credits, no model call. Every key is built from the caller's scope; the label is the only thing a request
 *   names, and it only ever becomes a field of that scope's hash.
 */
import { randomBytes } from "crypto";
import { db } from "./db";
import { AGENT_IDS } from "./agents";
import type { Zone } from "./zones";
import { OWNER_ALIASES, SEC_KEYS, audit, cleanLine, fail, isLocalDay, listOpenItems, withLock, zoneFor, type SecFail, type Who } from "./secretary";
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
/**
 * Keys the store cannot hold as a field (ruling R22): the Upstash HGETALL deserialiser assigns `obj[key]`, so a field
 * named `__proto__` (or one that shadows `constructor`, `prototype`) is lost or misread on every read.
 */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
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
  // Nothing visible left (blank, or only soft hyphens and the like), or a key no hash field can be (ruling R22).
  if (!key || RESERVED_KEYS.has(key)) return fail("bad_request", 400, "label");
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
 * an `away` audit line written in one round. `by` is the acting login (`who.login`, else the actor). `tag` ends the audit
 * line, saying where the write came from (a proposal from Reem's chat).
 */
export async function setAway(scope: string, raw: AwayInput, who: Who, now: number, zone: Zone, tag?: string): Promise<{ ok: true; entry: AwayEntry } | SecFail> {
  const p = parseAway(raw, now, zone);
  if (!p.ok) return p;
  const entry: AwayEntry = { label: p.label, until: p.until, ...(p.note ? { note: p.note } : {}), by: who.login ?? who.actor, via: "web", at: new Date(now).toISOString() };
  return withLock(scope, LOCK, async (): Promise<{ ok: true; entry: AwayEntry } | SecFail> => {
    const rows = await db.hgetall<unknown>(SEC_KEYS.away(scope));
    if (!hasOwn(rows, p.key) && Object.keys(rows).length >= AWAY_MAX) return fail("away_limit", 409);
    await Promise.all([db.hset(SEC_KEYS.away(scope), p.key, entry), audit(scope, who, "away", "-", `label=${JSON.stringify(p.label)}; until=${p.until}${tag ? `; ${tag}` : ""}`)]);
    return { ok: true, entry };
  });
}

export type AwayEnded = { ok: true; entry: AwayEntry; removed: boolean; changed: boolean };

/**
 * End a contact's absence now, `now` in the brand's `zone`, idempotently (ruling R21). A running entry (until today or
 * later) keeps its field with `until` set to yesterday, so the "back" alert follows; an entry that has already ended is
 * left as it is (`changed: false`, no audit line). `remove: true` deletes the field whatever its state (`removed: true`,
 * HDEL): the owner's way to free ended entries from the cap (ruling R19). A change writes one `away_end` audit line in
 * the same round, ended by `tag` when given. A label with no entry (or whose value is not one, which the daily clean-up
 * removes) is `not_found`.
 */
export async function endAway(scope: string, label: unknown, who: Who, now: number, zone: Zone, opts: { remove?: boolean; tag?: string } = {}): Promise<AwayEnded | SecFail> {
  const l = labelOf(label);
  if (!l.ok) return l;
  const today = zoneDay(now, zone);
  const tag = opts.tag ? `; ${opts.tag}` : "";
  return withLock(scope, LOCK, async (): Promise<AwayEnded | SecFail> => {
    const rows = await db.hgetall<unknown>(SEC_KEYS.away(scope));
    const cur = hasOwn(rows, l.key) ? entryOf(rows[l.key]) : null;
    if (!cur) return fail("not_found", 404);
    const name = `label=${JSON.stringify(cur.label)}`;
    if (opts.remove) {
      await Promise.all([db.hdel(SEC_KEYS.away(scope), l.key), audit(scope, who, "away_end", "-", `${name}; removed${tag}`)]);
      return { ok: true, entry: cur, removed: true, changed: true };
    }
    if (cur.until < today) return { ok: true, entry: cur, removed: false, changed: false };
    const entry: AwayEntry = { ...cur, until: addDays(today, -1), by: who.login ?? who.actor, at: new Date(now).toISOString() };
    await Promise.all([db.hset(SEC_KEYS.away(scope), l.key, entry), audit(scope, who, "away_end", "-", `${name}; until=${entry.until}${tag}`)]);
    return { ok: true, entry, removed: false, changed: true };
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

// ---------------------------------------------------------------------------------------------------------------
// Absences Reem proposes in chat (spec §3.2, rules 485-486): a card a person saves.

/** How long a proposal waits for its Save, and how long its outcome is kept after the decision. */
export const AWAY_PROPOSAL_TTL_S = 7 * 86400;
/** The claim a Save holds while it runs: longer than the away lock (10 s), short enough that a killed request frees it. */
const SAVE_CLAIM_S = 60;
const PROPOSAL_ID = /^[a-f0-9]{16}$/;

export type AwayProposalState = "open" | "saved" | "dismissed" | "expired";
/**
 * An absence Reem proposed (`contact_away`). `label` is the name as typed (cleaned like an item's party) and `key` its
 * `partyKey`; `until` is the last away day, or null to end the absence now; `openItems` is how many open items that
 * contact owes, and `contact` the name those items (else the away list) give the contact, when any. `state` is filled in
 * when a chat thread is read (`awayProposalStates`), never stored.
 */
export type AwayProposal = { id: string; label: string; key: string; until: string | null; openItems: number; contact?: string; at: string; state?: AwayProposalState };
/** What the tool call may set: nothing else is read. */
export type AwayProposalInput = { name: unknown; until?: unknown; clear?: unknown };

/** The tool names the contact `name`: a refusal about the label names that field. */
const asName = (f: SecFail): SecFail => (f.field === "label" ? { ...f, field: "name" } : f);

/**
 * Propose an absence, `now` in the brand's `zone`, checked like `setAway` (a contact, a last day from today to today +
 * 366, `bad_request` for `until` together with `clear`) or, with `clear: true`, like `endAway` (the contact is away now:
 * `not_found` when not on the list, `nothing_to_change` when the absence already ended). The away list and the open items
 * are read in one round: a new contact when the list is full is `away_limit`, and the items owed by that contact are
 * counted. The id goes into the scope's index first, then the record with its 7-day TTL, so the account wipe finds every
 * proposal saved. Nothing is written to the away list.
 */
export async function proposeAway(scope: string, input: AwayProposalInput, now: number, zone: Zone): Promise<{ ok: true; p: AwayProposal } | SecFail> {
  const { clear } = input;
  if (clear !== undefined && clear !== null && typeof clear !== "boolean") return fail("bad_request", 400, "clear");
  const ending = clear === true;
  let label: string, key: string, until: string | null;
  if (ending) {
    if (input.until !== undefined && input.until !== null && input.until !== "") return fail("bad_request", 400, "until");
    const l = labelOf(input.name);
    if (!l.ok) return asName(l);
    if (NOT_CONTACTS.has(l.key)) return fail("not_contact", 400, "name");
    ({ label, key } = l);
    until = null;
  } else {
    const a = parseAway({ label: input.name, until: input.until }, now, zone);
    if (!a.ok) return asName(a);
    ({ label, key, until } = a);
  }
  const [rows, items] = await Promise.all([db.hgetall<unknown>(SEC_KEYS.away(scope)), listOpenItems(scope)]);
  const cur = hasOwn(rows, key) ? entryOf(rows[key]) : null;
  if (ending) {
    if (!cur) return fail("not_found", 404, "name");
    if (cur.until < zoneDay(now, zone)) return fail("nothing_to_change", 409, "name");
  } else if (!hasOwn(rows, key) && Object.keys(rows).length >= AWAY_MAX) {
    return fail("away_limit", 409);
  }
  // The owner's and the agents' keys are never a contact's (NOT_CONTACTS), so only items a contact owes match.
  const owed = items.filter((it) => it.owedBy !== "owner" && partyKey(it.owedBy) === key);
  const contact = owed[0]?.owedBy ?? cur?.label;
  const p: AwayProposal = { id: randomBytes(8).toString("hex"), label, key, until, openItems: owed.length, ...(contact ? { contact } : {}), at: new Date(now).toISOString() };
  await db.sadd(SEC_KEYS.awayProps(scope), p.id);
  await db.set(SEC_KEYS.awayProp(scope, p.id), p, AWAY_PROPOSAL_TTL_S);
  return { ok: true, p };
}

/** A stored proposal, or null when the value is not one. */
function proposalOf(raw: unknown, id: string): AwayProposal | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.id !== id || typeof o.label !== "string" || !(o.until === null || isLocalDay(o.until))) return null;
  return o as unknown as AwayProposal;
}

/** Where each proposal stands, read in one MGET, so a reloaded chat shows a decided card as decided. */
export async function awayProposalStates(scope: string, ids: string[]): Promise<Record<string, AwayProposalState>> {
  const ok = [...new Set(ids.filter((id) => PROPOSAL_ID.test(id)))];
  if (!ok.length) return {};
  const rows = await db.mget<unknown>([...ok.map((id) => SEC_KEYS.awayProp(scope, id)), ...ok.map((id) => SEC_KEYS.awayPropDone(scope, id))]);
  return Object.fromEntries(ok.map((id, i): [string, AwayProposalState] => {
    const done = rows[ok.length + i];
    if (done === "saved" || done === "dismissed") return [id, done];
    return [id, rows[i] ? "open" : "expired"];
  }));
}

export type AwayDecided = { ok: true; state: "saved" | "dismissed"; entry?: AwayEntry };

/**
 * A person's answer to an absence Reem proposed, once. The id must be one (`not_found` otherwise, before any read), and
 * the proposal is read only from `scope`. A decided proposal is `already_decided` (409): the outcome is checked first,
 * then claimed with SET NX on `secawayprop-done:{scope}:{id}`, so of two answers at once one wins. Dismiss writes nothing
 * else. Save applies it through `setAway` (or `endAway` for an end) as `who`, in the brand's zone, with every check run
 * again: its `away` / `away_end` audit line names the login and ends with "proposed in Reem's chat ({id})". A Save the
 * checks refuse (a last day now past, a full list, a busy lock) frees the claim and changes nothing, so the card can be
 * saved later or dismissed. A decided proposal's record is deleted; its outcome stays 7 days.
 */
export async function decideAwayProposal(scope: string, id: string, action: "save" | "dismiss", who: Who, now = Date.now()): Promise<AwayDecided | SecFail> {
  if (!PROPOSAL_ID.test(id)) return fail("not_found", 404);
  const recordKey = SEC_KEYS.awayProp(scope, id);
  const doneKey = SEC_KEYS.awayPropDone(scope, id);
  const [raw, done] = await db.mget<unknown>([recordKey, doneKey]);
  if (done) return fail("already_decided", 409);
  const p = proposalOf(raw, id);
  if (!p) return fail("not_found", 404);
  if (action === "dismiss") {
    if (!(await db.setNx(doneKey, "dismissed", AWAY_PROPOSAL_TTL_S))) return fail("already_decided", 409);
    await db.del(recordKey);
    return { ok: true, state: "dismissed" };
  }
  if (!(await db.setNx(doneKey, "saving", SAVE_CLAIM_S))) return fail("already_decided", 409);
  let r: { ok: true; entry: AwayEntry } | SecFail;
  try {
    const zone = await zoneFor(scope);
    const tag = `proposed in Reem's chat (${id})`;
    if (p.until === null) {
      const e = await endAway(scope, p.label, who, now, zone, { tag });
      // The contact left the away list since the proposal: there is no absence to end.
      r = !e.ok && e.error === "not_found" ? fail("nothing_to_change", 409, "name") : e;
    } else {
      r = await setAway(scope, { label: p.label, until: p.until }, who, now, zone, tag);
    }
  } catch (e) {
    await db.del(doneKey).catch(() => {});
    throw e;
  }
  if (!r.ok) {
    await db.del(doneKey);
    return r;
  }
  await Promise.all([db.set(doneKey, "saved", AWAY_PROPOSAL_TTL_S), db.del(recordKey)]);
  return { ok: true, state: "saved", entry: r.entry };
}
