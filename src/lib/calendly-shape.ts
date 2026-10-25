import { findKey, listOf, pick } from "./connectors/composio-shape";

/**
 * Reading Calendly's answers through Composio (rules 4300-4329). Pure: no calls, no store. The Calendly poll
 * (src/lib/secretary-calendly.ts) and the connect step (src/lib/connectors/via-composio.ts) both read through here.
 * Everything Composio returns is untrusted: a URI is used only after it matches one of the patterns below, and the
 * names and times go through `parseCalendly` (src/lib/secretary-booking.ts) before an item is made.
 */

const API = "https://api.calendly.com";
/** The owner's own user URI, the one value `CALENDLY_LIST_SCHEDULED_EVENTS` takes as `user`. */
export const CLY_USER_URI = /^https:\/\/api\.calendly\.com\/users\/[A-Za-z0-9_-]{1,100}$/;
/** A scheduled event's URI; group 1 is the uuid `CALENDLY_LIST_EVENT_INVITEES` takes. */
export const CLY_EVENT_URI = /^https:\/\/api\.calendly\.com\/scheduled_events\/([A-Za-z0-9_-]{1,100})$/;

/** The owner's user URI from `CALENDLY_GET_CURRENT_USER`, or null when the answer carries none that is Calendly's own. */
export function userUriOf(answer: unknown): string | null {
  const uri = pick(answer, ["uri"]);
  return uri && CLY_USER_URI.test(uri) ? uri : null;
}

/** The label the Integrations card shows: the Calendly profile name, never the address. */
export const userNameOf = (answer: unknown): string => (pick(answer, ["name"]) ?? "Calendly").replace(/\s+/g, " ").trim().slice(0, 80) || "Calendly";

/** The `next_page_token` of a list answer, when there is one more page. */
export function nextPageOf(answer: unknown): string | null {
  const t = findKey(answer, ["next_page_token"], (v) => typeof v === "string" && v.length > 0 && v.length <= 500);
  return typeof t === "string" ? t : null;
}

export type CalendlyEvent = { uri: string; uuid: string; name: string; start: string; end: string };

/** The events of a list answer that are Calendly's own and carry a start and an end; the rest are dropped. */
export function eventsOf(answer: unknown): CalendlyEvent[] {
  const out: CalendlyEvent[] = [];
  for (const r of listOf(answer, "uri")) {
    const m = typeof r.uri === "string" ? CLY_EVENT_URI.exec(r.uri) : null;
    if (!m || typeof r.start_time !== "string" || typeof r.end_time !== "string") continue;
    out.push({ uri: r.uri as string, uuid: m[1], name: typeof r.name === "string" ? r.name : "", start: r.start_time, end: r.end_time });
  }
  return out;
}

/**
 * The invitees of a list answer that belong to `ev`: an invitee's URI must sit under the event's own, so a row Composio
 * returns for another event (or a forged one) is never applied to this one.
 */
export function inviteesOf(answer: unknown, ev: CalendlyEvent): Record<string, unknown>[] {
  return listOf(answer, "uri").filter((r) => typeof r.uri === "string" && r.uri.startsWith(`${ev.uri}/invitees/`) && r.uri.length <= 300);
}

/**
 * One invitee of one event, in the shape Calendly's webhook delivers it (`invitee.created` or `invitee.canceled`), so the
 * poll and the webhook go through the same `parseCalendly` and the same claim on the invitee's URI: a booking that
 * arrives by both paths is one item. `old_invitee` and `rescheduled` are carried over, for a move and for the cancel a
 * reschedule sends.
 */
export function webhookBody(inv: Record<string, unknown>, ev: CalendlyEvent): unknown {
  const old = typeof inv.old_invitee === "string" && inv.old_invitee.startsWith(`${API}/`) ? inv.old_invitee : null;
  return {
    event: inv.status === "canceled" ? "invitee.canceled" : "invitee.created",
    payload: {
      uri: inv.uri,
      name: inv.name,
      old_invitee: old,
      rescheduled: inv.rescheduled === true,
      scheduled_event: { name: ev.name, start_time: ev.start, end_time: ev.end },
    },
  };
}
