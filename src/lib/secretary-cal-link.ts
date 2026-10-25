/**
 * Reem B3: the store of the brand's linked calendar (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §6).
 * One link per brand scope (`sec:cal:link:{scope}`), its synced events (`sec:cal:events:{scope}`, TTL 24 h) and the global
 * sorted set of scopes due for a sync (`sec:cal:due`). Every key comes from a scope the caller already owns; tokens are
 * stored only sealed with `encrypt` (CONNECT_SECRET) and never leave this module in clear except through `openTokens`.
 * Importers: the calendar routes, the sync and the agenda (later tasks). Import cycle with secretary.ts (ruling R1):
 * every use of `SEC_KEYS` is inside a function body.
 */
import { db } from "./db";
import { decrypt, encrypt } from "./connectors/store";
import type { CalProvider } from "./connectors/registry";
import { SEC_KEYS } from "./secretary";
import type { Meeting } from "./secretary-meetings";

export type CalLink = {
  v: 1;
  provider: CalProvider;
  login: string;
  account: string;
  accountDomain?: string;
  proof: "domain" | "declaration" | null;
  declaration?: { by: string; at: string; v: number };
  calendarId?: string;
  calendarName?: string;
  /** The calendars the owner may pick from, as the callback listed them; `until` is the ms the list expires. */
  choices?: { ids: string[]; names: string[]; until: number };
  /** `sealTokens` output: the AES-256-GCM blob of `{ access, refresh, expiresAt }`. Empty for a Composio link, which holds no token. */
  tokens: string;
  /**
   * Rule 4260: `"composio"` when the calendar is read through Composio (secretary-gcal-via.ts) instead of Thakeen's own Google app.
   * Absent on every earlier link, which keeps reading as a direct one (expand: old code ignores both fields). `cid` is the
   * Composio connected-account id sealed with `sealAccount`; the only secret such a record holds.
   */
  via?: "composio";
  cid?: string;
  state: "choose" | "ok" | "reconnect";
  lostReason?: "token" | "calendar" | "domain" | "brand" | "owner";
  connectedAt: number;
  lastSyncAt?: number;
  rev: number;
};
export type CalTokens = { access: string; refresh: string; expiresAt: number };
export type CalEvents = { syncedAt: number; events: Meeting[] };

/** Synced data older than this (45 minutes) holds nothing: Reem acts as if there were no calendar. */
export const CAL_STALE_MS = 45 * 60_000;
/** The events record lives a day, so a brand that stops syncing leaves nothing behind. */
const EVENTS_TTL_S = 86_400;

export const getLink = (scope: string) => db.get<CalLink>(SEC_KEYS.calLink(scope));
export const putLink = (scope: string, link: CalLink) => db.set(SEC_KEYS.calLink(scope), link);

export const sealTokens = (t: CalTokens): string => encrypt(JSON.stringify({ access: t.access, refresh: t.refresh, expiresAt: t.expiresAt }));
/** The link's tokens, or null when the blob does not decrypt or does not hold the three fields. */
export function openTokens(link: Pick<CalLink, "tokens">): CalTokens | null {
  try {
    const t = JSON.parse(decrypt(link.tokens)) as Partial<CalTokens>;
    if (typeof t.access !== "string" || typeof t.refresh !== "string" || typeof t.expiresAt !== "number") return null;
    return { access: t.access, refresh: t.refresh, expiresAt: t.expiresAt };
  } catch {
    return null;
  }
}

export const sealAccount = (id: string): string => encrypt(id);
/** The Composio account id of a Composio link, or null for a direct link, a missing id or a blob that does not decrypt. */
export function openAccount(link: Pick<CalLink, "via" | "cid">): string | null {
  if (link.via !== "composio" || !link.cid) return null;
  try {
    const id = decrypt(link.cid);
    return id ? id : null;
  } catch {
    return null;
  }
}

/** Writes the synced events with their 24 h expiry. */
export const putEvents = (scope: string, ev: CalEvents) => db.set(SEC_KEYS.calEvents(scope), ev, EVENTS_TTL_S);

/** Unlinking: the link, the events and the scope's place in the sync queue, in one round. */
export async function dropLink(scope: string): Promise<void> {
  await Promise.all([db.del(SEC_KEYS.calLink(scope)), db.del(SEC_KEYS.calEvents(scope)), db.zrem(SEC_KEYS.calDue, scope)]);
}

/** Sets the scope's next sync time (replaces an earlier score, unlike the reminders' lower-only index). */
export const scheduleSync = (scope: string, atMs: number) => db.zadd(SEC_KEYS.calDue, atMs, scope);

/** The events of a linked, working calendar that were synced within `CAL_STALE_MS`; otherwise nothing. Pure. */
export function freshMeetings(link: CalLink | null, ev: CalEvents | null, now: number): Meeting[] {
  if (!link || link.state !== "ok" || !ev) return [];
  if (!Number.isFinite(ev.syncedAt) || now - ev.syncedAt > CAL_STALE_MS) return [];
  return Array.isArray(ev.events) ? ev.events : [];
}

/** What every reader of the calendar asks: this brand's meetings that can be trusted right now. */
export async function meetingsNow(scope: string, now: number): Promise<Meeting[]> {
  const [link, ev] = await Promise.all([getLink(scope), db.get<CalEvents>(SEC_KEYS.calEvents(scope))]);
  return freshMeetings(link, ev, now);
}
