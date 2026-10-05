/**
 * Bookings in (Reem B2a): the provider webhooks of Cal.com and Calendly turned into open items.
 *
 * The two signature checks and the two parsers are pure: neither reads a store nor throws. `applyBooking` acts on the
 * parsed booking in the link's own brand scope (never one from the payload).
 *
 * Privacy: a parser keeps the attendee's name, the event-type name, the start, the end and the provider's own
 * booking id (and the previous id of a rescheduled booking), cleaned and cut. It never reads the attendee's email or
 * phone, what they typed at booking, the video link or the cancellation reason, so those cannot reach a record, a
 * log line or an agent's prompt from here.
 *
 * Provider formats, checked against each provider's documentation on 2026-10-05:
 *   Cal.com  header `x-cal-signature-256`: hex HMAC-SHA256 of the raw body. Body `{ triggerEvent, payload }` with
 *            `payload.uid` (this booking), `payload.startTime`, `payload.endTime`, `payload.attendees[].name`,
 *            `payload.eventTitle` or the slug `payload.type`, and for a reschedule `payload.rescheduleUid`: the
 *            PREVIOUS booking's uid. A rescheduled Cal.com booking has a new uid.
 *   Calendly header `Calendly-Webhook-Signature`: `t=<unix>,v1=<hex>`, hex HMAC-SHA256 of `{t}.{body}`. Body
 *            `{ event, payload }` where `payload` is the invitee: `uri` (this invitee), `name`, `rescheduled`,
 *            `old_invitee`, `scheduled_event.{name,start_time,end_time}`. A reschedule sends `invitee.created` (naming
 *            `old_invitee`) and `invitee.canceled` (`rescheduled: true`), in no guaranteed order.
 */
import { createHmac } from "crypto";
import { isAgentId } from "./agents";
import type { BookRecord } from "./booking-token";
import { db } from "./db";
import { allow, sameSecret } from "./rate";
import { OWNER_ALIASES, SEC_ID, SEC_KEYS, calFor, changeItem, cleanLine, createItem, parseFields, removeBySystem, stateOf, type Who } from "./secretary";
import { SEC_LIMITS, zoneLocalInput } from "./secretary-agenda";
import type { Zone } from "./zones";

export type Parsed = {
  kind: "create" | "move" | "cancel" | "ignore";
  externalId: string;
  oldExternalId?: string;
  name: string;
  eventName: string;
  /** ISO UTC instants; empty only for `ignore`, and for a `cancel` that did not carry them. */
  start: string;
  end: string;
};

/** How far a Calendly timestamp may be from now, either way (spec B2-R4; Calendly recommends three minutes). */
export const CALENDLY_TOLERANCE_S = 300;

const LIMITS = { id: 200, name: 80, eventName: 120 } as const;

const hmacHex = (key: string, data: string) => createHmac("sha256", key).update(data, "utf8").digest("hex");

export function verifyCalcomSignature(body: string, header: string | null | undefined, key: string): boolean {
  if (typeof body !== "string" || typeof header !== "string" || typeof key !== "string" || !key) return false;
  return sameSecret(hmacHex(key, body), header.trim().toLowerCase());
}

export function verifyCalendlySignature(body: string, header: string | null | undefined, key: string, nowMs: number): boolean {
  if (typeof body !== "string" || typeof header !== "string" || typeof key !== "string" || !key || !Number.isFinite(nowMs)) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t" && !t) t = v;
    else if (k === "v1") sigs.push(v.toLowerCase());
  }
  if (!/^\d{1,12}$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > CALENDLY_TOLERANCE_S) return false;
  const want = hmacHex(key, `${t}.${body}`);
  return sigs.some(s => sameSecret(want, s));
}

const IGNORE: Parsed = { kind: "ignore", externalId: "", name: "", eventName: "", start: "", end: "" };
const ignore = (): Parsed => ({ ...IGNORE });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? cleanLine(v).slice(0, max).trim() : "");
/** An instant: a date-time with `Z` or an offset. One without would be read in the server's own zone, so it is refused. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
/** A provider's instant as ISO UTC, or "" when it is not an ISO date-time with a zone. */
const instant = (v: unknown): string => {
  if (typeof v !== "string" || v.length > 40 || !ISO.test(v)) return "";
  const ms = Date.parse(v);
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : "";
};
/** Both instants valid and the end after the start, else neither. */
const span = (a: unknown, b: unknown): { start: string; end: string } | null => {
  const start = instant(a), end = instant(b);
  return start && end && Date.parse(end) > Date.parse(start) ? { start, end } : null;
};

export function parseCalcom(body: unknown): Parsed {
  try {
    if (!isObj(body) || !isObj(body.payload)) return ignore();
    const p = body.payload;
    const trigger = body.triggerEvent;
    if (trigger !== "BOOKING_CREATED" && trigger !== "BOOKING_RESCHEDULED" && trigger !== "BOOKING_CANCELLED") return ignore();
    const externalId = text(p.uid, LIMITS.id);
    if (!externalId) return ignore();
    const when = span(p.startTime, p.endTime);
    const first = Array.isArray(p.attendees) ? p.attendees[0] : undefined;
    const name = isObj(first) ? text(first.name, LIMITS.name) : "";
    const eventName = text(p.eventTitle, LIMITS.eventName) || text(p.type, LIMITS.eventName);
    if (trigger === "BOOKING_CANCELLED") return { kind: "cancel", externalId, name, eventName, start: when?.start ?? "", end: when?.end ?? "" };
    if (!when || !name) return ignore();
    if (trigger === "BOOKING_CREATED") return { kind: "create", externalId, name, eventName, ...when };
    const old = text(p.rescheduleUid, LIMITS.id);
    return { kind: "move", externalId, ...(old && old !== externalId ? { oldExternalId: old } : {}), name, eventName, ...when };
  } catch {
    return ignore();
  }
}

export function parseCalendly(body: unknown): Parsed {
  try {
    if (!isObj(body) || !isObj(body.payload)) return ignore();
    const p = body.payload;
    const event = body.event;
    if (event !== "invitee.created" && event !== "invitee.canceled") return ignore();
    const externalId = text(p.uri, LIMITS.id);
    if (!externalId) return ignore();
    const se = isObj(p.scheduled_event) ? p.scheduled_event : {};
    const when = span(se.start_time, se.end_time);
    const name = text(p.name, LIMITS.name);
    const eventName = text(se.name, LIMITS.eventName);
    if (event === "invitee.canceled") {
      // A reschedule sends a cancel too; the matching create owns the move, whichever arrives first.
      if (p.rescheduled === true) return ignore();
      return { kind: "cancel", externalId, name, eventName, start: when?.start ?? "", end: when?.end ?? "" };
    }
    if (!when || !name) return ignore();
    const old = text(p.old_invitee, LIMITS.id);
    if (old && old !== externalId) return { kind: "move", externalId, oldExternalId: old, name, eventName, ...when };
    return { kind: "create", externalId, name, eventName, ...when };
  } catch {
    return ignore();
  }
}

/** What one delivery did. "busy": a lock or the store was not available; the route answers 503 and the provider retries. */
export type ApplyResult = "created" | "moved" | "removed" | "noop" | "busy";

/** How long a booking's claim names its item: past any reschedule or cancel a provider still sends. */
export const BOOK_CLAIM_S = 400 * 86400;
/** New items one booking link may create a day (`book:new:{hash}`): a leaked link cannot spend the owner's 200. */
export const BOOK_NEW_PER_DAY = 60;
/** A booking more than a day in the past or more than 366 days ahead is not put on the list. */
export const BOOK_WINDOW = { backMs: 864e5, aheadMs: 366 * 864e5 } as const;
/** The claim's value while its item is being created; it lapses in a minute if that run dies. */
const PENDING = "pending";
const PENDING_S = 60;
const MIN = 60_000;
const SYSTEM: Who = { actor: "rule", via: "cron" };
const PROVIDER_NAME = { calcom: "Cal.com", calendly: "Calendly" } as const;
const WORDS = {
  en: { title: (n: string) => `Meeting with ${n}`, guest: "a guest", via: (p: string) => `booked via ${p}` },
  ar: { title: (n: string) => `اجتماع مع ${n}`, guest: "ضيف", via: (p: string) => `حُجز عبر ${p}` },
} as const;
/** The account behind a brand scope (`email` or `email#brandId`), whose daily allowance a creation spends. */
const accountOf = (scope: string) => scope.split("#")[0];

/**
 * The item's fields from a booking: title in the link's language, the event-type name and the provider in the
 * description, the guest as `owedTo` (a name that would read as the owner or an agent is left out of the party), the
 * start as the brand zone's local `YYYY-MM-DDTHH:mm`, and `remindAt` at the end only while it is ahead. Nothing else of
 * the payload: no email, phone, link, notes or reason ever reaches here (the parsers keep none).
 */
function fieldsOf(rec: BookRecord, p: Parsed, zone: Zone): Record<string, unknown> {
  const w = WORDS[rec.lang === "ar" ? "ar" : "en"];
  const name = cleanLine(p.name).slice(0, SEC_LIMITS.party).trim();
  const low = name.toLowerCase();
  const party = name && !(OWNER_ALIASES as readonly string[]).includes(low) && !isAgentId(low) ? name : null;
  const event = cleanLine(p.eventName).slice(0, 120).trim();
  // The item keeps minutes: a reminder that would round to now or earlier is no reminder (`remind_past`).
  const remindMs = Math.floor(Date.parse(p.end) / MIN) * MIN;
  return {
    kind: "task", direction: "i_owe", owedTo: party,
    title: w.title(name || w.guest).slice(0, SEC_LIMITS.title),
    description: [event, w.via(PROVIDER_NAME[rec.provider])].filter(Boolean).join(" · "),
    dueAt: zoneLocalInput(Date.parse(p.start), zone),
    remindAt: remindMs > Date.now() + MIN ? zoneLocalInput(remindMs, zone) : null,
  };
}

/** Name `externalId` as `itemId`'s booking: the index first, so account deletion finds every claim it could leave. */
async function claimFor(rec: BookRecord, externalId: string, itemId: string) {
  await db.sadd(SEC_KEYS.bookIds(rec.scope), `${rec.provider}:${externalId}`);
  await db.set(SEC_KEYS.bookClaim(rec.scope, rec.provider, externalId), itemId, BOOK_CLAIM_S);
}

/**
 * Create the booking's item, once: the claim is taken with SET NX before anything else, so a replay, or the same
 * delivery five times at once, finds it taken and does nothing. Then the link's own daily cap (before `createItem`, so
 * the 61st spends none of the owner's `sec:create`), then `createItem` as the rule (the owner's 200 a day and 500 open
 * still apply). A creation that does not happen releases the claim, so a later delivery of it can try again.
 */
async function createBooked(rec: BookRecord, p: Parsed, hash: string): Promise<ApplyResult> {
  const scope = rec.scope;
  const key = SEC_KEYS.bookClaim(scope, rec.provider, p.externalId);
  await db.sadd(SEC_KEYS.bookIds(scope), `${rec.provider}:${p.externalId}`);
  if (!(await db.setNx(key, PENDING, PENDING_S))) return "noop";
  let itemId: string | null = null;
  let busy = false;
  try {
    const [ok, { zone, cal }] = await Promise.all([allow(`book:new:${hash}`, BOOK_NEW_PER_DAY, 86400), calFor(scope)]);
    if (ok) {
      const r = await createItem({ email: accountOf(scope), scope }, fieldsOf(rec, p, zone), { ...SYSTEM, source: "booking" }, { zone, cal });
      if (r.ok) itemId = r.item.id;
      else busy = r.status === 503;
    }
  } finally {
    if (itemId) await db.set(key, itemId, BOOK_CLAIM_S);
    else await db.del(key);
  }
  return itemId ? "created" : busy ? "busy" : "noop";
}

/**
 * Move the booking's item to the new start, end and reminder (`changeItem` update as the rule, under the item's lock)
 * and name the new external id as that item too, so a later cancel or move under it finds the same item. An item the
 * owner closed or deleted is left as it is ("noop"), still claimed. "gone": the claimed item no longer exists (purged
 * after its 30 days), so the caller creates it again.
 */
async function moveBooked(rec: BookRecord, p: Parsed, itemId: string, claimed: boolean): Promise<ApplyResult | "gone"> {
  const { zone, cal } = await calFor(rec.scope);
  const f = fieldsOf(rec, p, zone);
  const parsed = parseFields({ dueAt: f.dueAt, remindAt: f.remindAt }, Date.now(), zone);
  if (!parsed.ok) return "noop";
  const r = await changeItem(rec.scope, itemId, { action: "update", fields: parsed.fields }, SYSTEM, undefined, zone, cal);
  if (!r.ok && r.status === 503) return "busy";
  if (!r.ok && r.error === "not_found") return "gone";
  if (!claimed) await claimFor(rec, p.externalId, itemId);
  return r.ok ? "moved" : "noop";
}

/**
 * Act on one parsed booking for the link `rec` (whose token hashes to `hash`, the per-link cap's bucket). Every key is
 * built from `rec.scope` and `rec.provider`, never from the payload; the payload gives only the external ids, the name,
 * the event-type name and the instants.
 *
 * - create: one item (`createBooked`). A booking whose start is more than a day back or more than 366 days ahead: noop.
 * - move: the item named by the previous id first (a Cal.com reschedule has a new uid; a Calendly one a new invitee),
 *   then by this id; moved (`moveBooked`). Neither id known, or the item they name purged: created, as a create.
 *   Same window as a create.
 * - cancel: only the id is read (its start and end may be empty). The open item it names is removed (`removeBySystem`,
 *   restorable for 30 days, audit `booking_cancel` by the rule); unknown, closed or already removed: noop.
 * - ignore: noop.
 * A claim another delivery is still creating, a held item lock, or a store failure: "busy".
 */
export async function applyBooking(rec: BookRecord, p: Parsed, hash: string, nowMs: number = Date.now()): Promise<ApplyResult> {
  try {
    if (p.kind === "ignore" || !p.externalId) return "noop";
    const claimKey = (id: string) => SEC_KEYS.bookClaim(rec.scope, rec.provider, id);
    if (p.kind === "cancel") {
      const held = await db.get<string>(claimKey(p.externalId));
      if (held === PENDING) return "busy";
      if (typeof held !== "string" || !SEC_ID.test(held)) return "noop";
      const r = await removeBySystem(rec.scope, held, SYSTEM, "booking_cancel", { only: (it) => stateOf(it) === "open" });
      return r === "deleted" ? "removed" : r === "failed" ? "busy" : "noop";
    }
    const start = Date.parse(p.start), end = Date.parse(p.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "noop";
    if (start < nowMs - BOOK_WINDOW.backMs || start > nowMs + BOOK_WINDOW.aheadMs) return "noop";
    if (p.kind === "move") {
      const ids = [...(p.oldExternalId ? [p.oldExternalId] : []), p.externalId];
      const held = await Promise.all(ids.map((id) => db.get<string>(claimKey(id))));
      const itemId = held.find((h): h is string => typeof h === "string" && SEC_ID.test(h));
      if (itemId) {
        const r = await moveBooked(rec, p, itemId, held[held.length - 1] === itemId);
        if (r !== "gone") return r;
        // The claim outlived its item: release this id's stale claim so the create below can take it.
        if (held[held.length - 1] === itemId) await db.del(claimKey(p.externalId));
      } else if (held.includes(PENDING)) return "busy";
    }
    return await createBooked(rec, p, hash);
  } catch (e) {
    console.error("booking apply failed", e instanceof Error ? e.name : "error");
    return "busy";
  }
}
