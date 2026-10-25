/**
 * Rules 4260-4279: Reem's Google Calendar read through Composio, next to the direct path in secretary-gcal.ts. Composio holds
 * the Google tokens; the link holds the connected account's id (sealed, secretary-cal-link.ts) and nothing else secret.
 * Read only: the two tools in composio-catalog.ts `googlecalendar` list the account's own calendars and read one calendar's
 * events, and the catalog lists no write tool, so Reem cannot create, move or delete an event through it.
 *
 * Everything an answer holds is untrusted. The calendars are cut to a name and an id here; each event goes through
 * `keepGoogle` in the sync exactly like a direct answer. Only a fixed word is thrown or logged, never Composio's text.
 */
import { composioRead, composioRevoke } from "./connectors/composio";
import { findKey, listOf } from "./connectors/composio-shape";
import { openAccount, sealAccount, type CalLink } from "./secretary-cal-link";
import type { EventsResult } from "./secretary-gcal";
import { log } from "./log";

/** The same event fields the direct path asks Google for: no description, attendee names, place or meeting link. */
export const EVENT_FIELDS = "items(status,summary,start,end,transparency,visibility,attendees(self,responseStatus))";

const cleanName = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) : "") || "—";

/** The Composio failure `composio.ts` shapes as "gcal 401: ..." is the only one that means the grant is gone. */
const refused = (e: unknown): boolean => e instanceof Error && /^gcal 401\b/.test(e.message);
const wasNotConnected = (e: unknown): boolean => e instanceof Error && e.message === "not_connected";

export const viaFields = (accountId: string) => ({ via: "composio" as const, cid: sealAccount(accountId), tokens: "" });

/**
 * The calendars the account owns, at most 50, as the direct list gives them. `primary` marks the account's own calendar, whose
 * id Google makes the account's address. Throws with `status` 401 when Composio says the grant is gone.
 */
export async function listCalendarsVia(scope: string, accountId: string): Promise<{ id: string; name: string; primary: boolean }[]> {
  let r: unknown;
  try {
    r = await composioRead(scope, "googlecalendar", "GOOGLECALENDAR_LIST_CALENDARS", { min_access_role: "owner", max_results: 50 }, accountId);
  } catch (e) {
    throw Object.assign(new Error("calendar_list_failed"), { status: refused(e) || wasNotConnected(e) ? 401 : 502 });
  }
  return listOf(r)
    .filter((c) => typeof c.id === "string" && c.id && (c.accessRole === undefined || c.accessRole === "owner"))
    .slice(0, 50)
    .map((c) => ({ id: c.id as string, name: cleanName(c.summaryOverride || c.summary), primary: c.primary === true }));
}

/** The raw events of the chosen calendar between two instants, requested from `link.calendarId` and nothing else. `raw` is untrusted. */
export async function fetchEventsVia(scope: string, link: CalLink, fromMs: number, toMs: number): Promise<EventsResult> {
  const accountId = openAccount(link);
  if (!link.calendarId) return { ok: false, kind: "gone" };
  if (!accountId) return { ok: false, kind: "auth" };
  try {
    const r = await composioRead(
      scope,
      "googlecalendar",
      "GOOGLECALENDAR_EVENTS_LIST",
      { calendarId: link.calendarId, timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), singleEvents: true, orderBy: "startTime", maxResults: 300, fields: EVENT_FIELDS },
      accountId,
    );
    const rows = findKey(r, ["items"], Array.isArray);
    return Array.isArray(rows) ? { ok: true, raw: rows } : { ok: false, kind: "retry" };
  } catch (e) {
    if (refused(e) || wasNotConnected(e)) return { ok: false, kind: "auth" };
    log.error("cal events fetch via composio failed", { reason: e instanceof Error && /^composio_/.test(e.message) ? e.message : "call_failed" });
    return { ok: false, kind: "retry" };
  }
}

/**
 * The connected account ends with the link (the direct path calls no revoke, because its Google grant is shared with the
 * publishing connection; this account is the calendar's alone). Revoke at Google through Composio, then delete there. A
 * failure is logged by name and never keeps the link alive: the owner asked for it gone.
 */
export async function releaseVia(scope: string, link: CalLink): Promise<void> {
  const id = openAccount(link);
  if (!id) return;
  await composioRevoke(scope, id).catch((e) => log.error("cal composio revoke failed", { reason: e instanceof Error && /^composio_|^not_/.test(e.message) ? e.message : "revoke_failed" }));
}
