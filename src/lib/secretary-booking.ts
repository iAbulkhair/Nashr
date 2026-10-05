/**
 * Bookings in (Reem B2a): the provider webhooks of Cal.com and Calendly turned into open items.
 *
 * This part is pure: the two signature checks and the two parsers. Neither reads a store nor throws.
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
import { sameSecret } from "./rate";
import { cleanLine } from "./secretary";

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
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** A provider's instant as ISO UTC, or "" when it is not an ISO date-time. */
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
