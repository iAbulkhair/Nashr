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
import { safeFetch } from "./safe-fetch";
import { OWNER_ALIASES, SEC_ID, SEC_KEYS, calFor, changeItem, cleanLine, createItem, newSecId, parseFields, reindexOpen, removeBySystem, stateOf, withLock, type Who } from "./secretary";
import { SEC_LIMITS, zoneLocalInput, type SecItem } from "./secretary-agenda";
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
/**
 * A claim's value once its booking was cancelled before its item was written (`removeBySystem`'s `missing` hook):
 * nothing is created for that booking after.
 */
const CANCELLED = "cancelled";
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

const claimKeyOf = (rec: BookRecord, externalId: string) => SEC_KEYS.bookClaim(rec.scope, rec.provider, externalId);

/**
 * Claim `externalId` for `itemId` unless it is claimed already (SET NX, 400 days; never overwritten, so a claim that
 * names another item stays as it is). The index first, so account deletion finds every claim it could leave. Returns
 * the value the claim holds now: `itemId` when this call took it, the earlier value otherwise (null when it was released
 * between the two calls).
 */
async function claim(rec: BookRecord, externalId: string, itemId: string): Promise<string | null> {
  await db.sadd(SEC_KEYS.bookIds(rec.scope), `${rec.provider}:${externalId}`);
  const key = claimKeyOf(rec, externalId);
  if (await db.setNx(key, itemId, BOOK_CLAIM_S)) return itemId;
  return db.get<string>(key);
}

/**
 * Write the booking's item at the claimed id `id`, once (the `sec:spawn` pattern). Under the item's lock: the claim
 * `key` must still name `id` (a cancel that came first marked it cancelled; a refusal released it), and when the record
 * exists already (an earlier run, or another delivery at the same moment) nothing is created: "exists", after its
 * indexes are written again in case that run died between the record and its indexes. Otherwise the link's own cap
 * (before `createItem`, so a refused creation spends none of the owner's `sec:create`), then `createItem` at `id` as the
 * rule; the owner's 200 a day and 500 open still apply. A refusal (a cap, a validation) releases the claim, so a later
 * delivery can try again; a 503 or a throw keeps it, so the provider's retry finishes this creation at the same id.
 * There is no window in which a retry finds the claim taken but cannot finish it, and none in which a second item can
 * be made.
 */
async function createAt(rec: BookRecord, p: Parsed, hash: string, id: string, key: string): Promise<ApplyResult | "exists"> {
  const scope = rec.scope;
  const { zone, cal } = await calFor(scope);
  const r = await withLock(scope, id, async (): Promise<ApplyResult | "exists"> => {
    const [held, cur] = await Promise.all([db.get<string>(key), db.get<SecItem>(SEC_KEYS.item(scope, id))]);
    if (held !== id) return "noop";
    if (cur) {
      await reindexOpen(scope, cur);
      return "exists";
    }
    if (!(await allow(`book:new:${hash}`, BOOK_NEW_PER_DAY, 86400))) {
      await db.del(key);
      return "noop";
    }
    const made = await createItem({ email: accountOf(scope), scope }, fieldsOf(rec, p, zone), { ...SYSTEM, source: "booking" }, { zone, cal, id });
    if (made.ok) return "created";
    if (made.status === 503) return "busy";
    await db.del(key);
    return "noop";
  });
  // A lock that timed out (`SecFail`, 503): the retry finishes this creation.
  return typeof r === "string" ? r : "busy";
}

/**
 * A booking not seen before: claim its id (and, for a move whose ids were unknown, the previous id too, for the same
 * item) for a new item id, then write the item there (`createAt`). A delivery that finds the claim taken finishes the
 * same creation at the claimed id, which is a no-op when the item exists; a claim marked cancelled creates nothing.
 */
async function createBooked(rec: BookRecord, p: Parsed, hash: string, alsoIds: string[] = []): Promise<ApplyResult> {
  const id = await claim(rec, p.externalId, newSecId());
  if (id === null) return "busy";
  if (!SEC_ID.test(id)) return "noop";
  await Promise.all(alsoIds.map((x) => claim(rec, x, id)));
  const r = await createAt(rec, p, hash, id, claimKeyOf(rec, p.externalId));
  return r === "exists" ? "noop" : r;
}

/**
 * Move the booking's item to the new start, end and reminder (`changeItem` update as the rule, under the item's lock)
 * and claim the new external id for that item (SET NX: a claim naming another item is left alone), so a later cancel or
 * move under it finds the same item. An item the owner closed or deleted is left as it is ("noop"). A claim whose item
 * does not exist (a creation that died or is still running, or an item purged after its 30 days) is finished at that id
 * with the new times (`createAt`); when that creation turns out to exist after all, the move is applied to it once more.
 */
async function moveBooked(rec: BookRecord, p: Parsed, hash: string, itemId: string, fromKey: string, again = false): Promise<ApplyResult> {
  const { zone, cal } = await calFor(rec.scope);
  const f = fieldsOf(rec, p, zone);
  const parsed = parseFields({ dueAt: f.dueAt, remindAt: f.remindAt }, Date.now(), zone);
  if (!parsed.ok) return "noop";
  const r = await changeItem(rec.scope, itemId, { action: "update", fields: parsed.fields }, SYSTEM, undefined, zone, cal);
  if (!r.ok && r.status === 503) return "busy";
  if (!r.ok && r.error === "not_found") {
    const made = await createAt(rec, p, hash, itemId, fromKey);
    if (made === "exists") return again ? "noop" : moveBooked(rec, p, hash, itemId, fromKey, true);
    if (made === "created") await claim(rec, p.externalId, itemId);
    return made;
  }
  await claim(rec, p.externalId, itemId);
  return r.ok ? "moved" : "noop";
}

/**
 * Act on one parsed booking for the link `rec` (whose token hashes to `hash`, the per-link cap's bucket). Every key is
 * built from `rec.scope` and `rec.provider`, never from the payload; the payload gives only the external ids, the name,
 * the event-type name and the instants.
 *
 * - create: one item (`createBooked`). A booking whose start is more than a day back or more than 366 days ahead: noop.
 * - move: the item named by the previous id first (a Cal.com reschedule has a new uid; a Calendly one a new invitee),
 *   then by this id; moved (`moveBooked`). Neither id known: created, as a create, both ids claimed for it. A booking
 *   cancelled before its item was written: noop. Same window as a create.
 * - cancel: only the id is read (its start and end may be empty). The open item it names is removed (`removeBySystem`,
 *   restorable for 30 days, audit `booking_cancel` by the rule); a claimed item not yet written is marked cancelled
 *   under its lock, so its creation never happens; unknown, closed or already removed: noop.
 * - ignore: noop.
 * A held item lock or a store failure: "busy" (the provider retries, and the retry finishes what this one began).
 */
export async function applyBooking(rec: BookRecord, p: Parsed, hash: string, nowMs: number = Date.now()): Promise<ApplyResult> {
  try {
    if (p.kind === "ignore" || !p.externalId) return "noop";
    if (p.kind === "cancel") {
      const key = claimKeyOf(rec, p.externalId);
      const held = await db.get<string>(key);
      if (typeof held !== "string" || !SEC_ID.test(held)) return "noop";
      const r = await removeBySystem(rec.scope, held, SYSTEM, "booking_cancel", {
        only: (it) => stateOf(it) === "open",
        missing: () => db.set(key, CANCELLED, BOOK_CLAIM_S),
      });
      return r === "deleted" ? "removed" : r === "failed" ? "busy" : "noop";
    }
    const start = Date.parse(p.start), end = Date.parse(p.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "noop";
    if (start < nowMs - BOOK_WINDOW.backMs || start > nowMs + BOOK_WINDOW.aheadMs) return "noop";
    if (p.kind === "move") {
      const keys = [...(p.oldExternalId ? [p.oldExternalId] : []), p.externalId].map((x) => claimKeyOf(rec, x));
      const held = await Promise.all(keys.map((k) => db.get<string>(k)));
      const i = held.findIndex((h) => typeof h === "string" && SEC_ID.test(h));
      if (i >= 0) return await moveBooked(rec, p, hash, held[i]!, keys[i]);
      if (held.includes(CANCELLED)) return "noop";
      return await createBooked(rec, p, hash, p.oldExternalId ? [p.oldExternalId] : []);
    }
    return await createBooked(rec, p, hash);
  } catch (e) {
    console.error("booking apply failed", e instanceof Error ? e.name : "error");
    return "busy";
  }
}

const CALENDLY_API = "https://api.calendly.com";
const CALENDLY_TIMEOUT_MS = 10_000;
/** A Calendly resource URI is an address on Calendly's own API. */
const calendlyUri = (v: unknown): v is string => typeof v === "string" && v.startsWith(`${CALENDLY_API}/`) && v.length <= 300;

export type CalendlySetup = { ok: true } | { ok: false; error: "calendly_rejected" | "calendly_plan" };

/**
 * Subscribe Calendly to our webhook for the owner of `pat`, a personal access token the owner pasted. Two calls, both
 * through `safeFetch` (https only): `GET /users/me` for the user and organization addresses (Calendly's subscription
 * call requires `organization` even for `scope: "user"`), then `POST /webhook_subscriptions` for
 * `invitee.created` and `invitee.canceled` with `signing_key`, the key `verifyCalendlySignature` later checks against.
 *
 * The token lives only in this function's two Authorization headers: never stored, logged, put in a URL, returned or
 * carried by an error. Every failure is a typed answer, never a throw and never a message: a refusal from the plan
 * (402 or 403 on the subscription: webhooks need Calendly's Standard plan or above) is `calendly_plan`; anything else,
 * including a malformed answer, a 5xx and a network error, is `calendly_rejected`.
 */
export async function calendlySubscribe(pat: string, url: string, signingKey: string): Promise<CalendlySetup> {
  const rejected = { ok: false, error: "calendly_rejected" } as const;
  const call = (path: string, init: RequestInit) =>
    safeFetch(
      `${CALENDLY_API}${path}`,
      { ...init, headers: { authorization: `Bearer ${pat}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(CALENDLY_TIMEOUT_MS) },
      { httpsOnly: true },
    );
  try {
    const me = await call("/users/me", { method: "GET" });
    if (!me.ok) return rejected;
    const resource = ((await me.json()) as { resource?: { uri?: unknown; current_organization?: unknown } } | null)?.resource;
    if (!resource || !calendlyUri(resource.uri) || !calendlyUri(resource.current_organization)) return rejected;
    const res = await call("/webhook_subscriptions", {
      method: "POST",
      body: JSON.stringify({ url, events: ["invitee.created", "invitee.canceled"], organization: resource.current_organization, user: resource.uri, scope: "user", signing_key: signingKey }),
    });
    if (res.ok) return { ok: true };
    return res.status === 402 || res.status === 403 ? { ok: false, error: "calendly_plan" } : rejected;
  } catch {
    return rejected;
  }
}
