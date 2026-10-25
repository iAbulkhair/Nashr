/**
 * Reem's Calendly bookings read through Composio (rules 4300-4329, flows.md §42a). Calendly's webhooks need a paid plan
 * (`calendly_plan` in src/lib/secretary-booking.ts); the reads below do not, so an owner on Calendly's free plan connects
 * Calendly in Composio and this poll finds the bookings. The webhook stays for every owner it works for, and both paths
 * end in `applyBooking` with the invitee's URI as the booking id, so a booking that arrives by both is one item.
 *
 * Read only: three Composio tools (src/lib/connectors/composio-catalog.ts, `calendly`), nothing is booked, cancelled or
 * edited in Calendly. What they return is untrusted: URIs are matched (src/lib/calendly-shape.ts), names and times go
 * through `parseCalendly`, and the item is made by the same code as a webhook's.
 *
 * Schedule: the scopes with a Calendly connection are in `sec:cly:due`, each polled every 15 minutes by the secretary
 * tick, 30 a tick, 6 at a time. A scope's poll holds `lock:cly:{scope}`. `sec:cly:memo:{scope}` remembers which events
 * were applied so a poll costs two list calls and one invitee call per new or newly cancelled event.
 */
import { getUser } from "./auth";
import { isSuspended } from "./suspension";
import { listBrands, scopeFor } from "./brands";
import { composioRead } from "./connectors/composio";
import { isComposio } from "./connectors/composio-shape";
import { ReconnectRequired, refusedToken } from "./connectors/fresh";
import { getConnection } from "./connectors/store";
import { CLY_USER_URI, eventsOf, inviteesOf, nextPageOf, webhookBody, type CalendlyEvent } from "./calendly-shape";
import { hashBookToken, type BookRecord } from "./booking-token";
import { applyBooking, parseCalendly, BOOK_WINDOW, type ApplyResult } from "./secretary-booking";
import { SEC_KEYS } from "./secretary";
import { db } from "./db";
import { pmap } from "./parallel";
import { log } from "./log";
import { accountOfScope } from "./account-id";

export const CLY_SYNC_MS = 15 * 60_000;
export const CLY_TICK_MAX = 30;
export const CLY_CONCURRENCY = 6;
/** Invitee reads at once within one scope's poll. */
const CLY_INVITEE_CONCURRENCY = 3;
/** Events looked at for invitees in one poll; the rest wait for the next one. */
export const CLY_EVENTS_PER_POLL = 25;
/** Events in one list call, and the pages followed: 200 events either way. */
const CLY_PAGE = 100;
const CLY_PAGES = 2;
/** The poll reads events starting from a day ago (a late create, a cancel) to 90 days ahead. */
const CLY_AHEAD_MS = 90 * 86_400_000;
const CLY_LOCK_S = 90;
const CLY_BUSY_RETRY_MS = 60_000;
const CLY_ERROR_RETRY_MS = 900_000;
/** A poll starts only this long before the deadline: it is a few Composio calls of up to 20 s each. */
const CLY_START_MARGIN_MS = 30_000;
const MEMO_TTL_S = 45 * 86_400;
const MEMO_ACTIVE = "a";
const MEMO_CANCELED = "c";

export type CalendlySweepReport = { scopes: number; polled: number; created: number; moved: number; removed: number; retried: number; deferred: number };
export const emptyCalendlyReport = (): CalendlySweepReport => ({ scopes: 0, polled: 0, created: 0, moved: 0, removed: 0, retried: 0, deferred: 0 });
type Outcome = "polled" | "retried" | "deferred" | "dropped";

export const scheduleCalendlyPoll = (scope: string, atMs: number) => db.zadd(SEC_KEYS.clyDue, atMs, scope);
/** The connection went (disconnect, account deletion): the scope leaves the queue and its memo goes. */
export const dropCalendlyPoll = (scope: string) => Promise.all([db.zrem(SEC_KEYS.clyDue, scope), db.del(SEC_KEYS.clyMemo(scope))]);

const iso = (ms: number) => new Date(ms).toISOString();

/** The events of one status in the window, at most `CLY_PAGES` pages. */
async function listEvents(scope: string, acc: string, user: string, status: "active" | "canceled", now: number): Promise<{ events: CalendlyEvent[]; complete: boolean }> {
  const events: CalendlyEvent[] = [];
  let token: string | null = null;
  for (let page = 0; page < CLY_PAGES; page++) {
    const args: Record<string, unknown> = { user, status, count: CLY_PAGE, sort: "start_time:asc", min_start_time: iso(now - BOOK_WINDOW.backMs), max_start_time: iso(now + CLY_AHEAD_MS) };
    if (token) args.page_token = token;
    const r = await composioRead(scope, "calendly", "CALENDLY_LIST_SCHEDULED_EVENTS", args, acc);
    events.push(...eventsOf(r));
    token = nextPageOf(r);
    if (!token) return { events, complete: true };
  }
  return { events, complete: false };
}

/** The apply step of one invitee, counted in the report. A "busy" result is the caller's to try again. */
function count(report: CalendlySweepReport, r: ApplyResult) {
  if (r === "created") report.created++;
  if (r === "moved") report.moved++;
  if (r === "removed") report.removed++;
}

/** One scope's poll with its lock held. */
async function pollLocked(scope: string, now: number, report: CalendlySweepReport): Promise<Outcome> {
  const conn = await getConnection(scope, "calendly").catch(() => null);
  const acc = conn?.data.calendly;
  const user = conn?.meta?.calUser;
  // No connection, a connection that needs reconnecting, or one that is not Composio's: nothing to poll, and it leaves the queue.
  if (!conn || !isComposio(conn) || conn.needsReconnect || !acc || !user || !CLY_USER_URI.test(user)) {
    await db.zrem(SEC_KEYS.clyDue, scope);
    return "dropped";
  }
  const owner = accountOfScope(scope);
  const [login, brands] = await Promise.all([getUser(owner), listBrands(owner)]);
  const meta = brands.find((b) => scopeFor(owner, b.id) === scope);
  if (!login || isSuspended(login) || meta?.status !== "active") {
    await db.zrem(SEC_KEYS.clyDue, scope);
    return "dropped";
  }
  const rec: BookRecord = { login: login.email, scope, provider: "calendly", lang: login.lang === "ar" ? "ar" : "en", createdAt: conn.connectedAt };
  // The per-link daily cap (`book:new:{hash}`) needs a hash; this connection's own is derived from the scope.
  const hash = hashBookToken("composio-calendly:" + scope);

  let active: Awaited<ReturnType<typeof listEvents>>;
  let canceled: Awaited<ReturnType<typeof listEvents>>;
  try {
    [active, canceled] = await Promise.all([listEvents(scope, acc, user, "active", now), listEvents(scope, acc, user, "canceled", now)]);
  } catch (e) {
    const err = await refusedToken(scope, "calendly", e);
    if (err instanceof ReconnectRequired) {
      await db.zrem(SEC_KEYS.clyDue, scope);
      return "dropped";
    }
    throw e;
  }
  const memo = await db.hgetall<string>(SEC_KEYS.clyMemo(scope));
  const todo = [
    ...active.events.filter((e) => memo[e.uuid] !== MEMO_ACTIVE).map((e) => ({ e, status: "active" as const })),
    ...canceled.events.filter((e) => memo[e.uuid] !== MEMO_CANCELED).map((e) => ({ e, status: "canceled" as const })),
  ].slice(0, CLY_EVENTS_PER_POLL);

  // A disconnect or a new connection since this poll began: nothing is applied from the old one.
  const still = await getConnection(scope, "calendly").catch(() => null);
  if (!still || still.connectedAt !== conn.connectedAt || still.needsReconnect) return "dropped";
  const done: [string, string][] = [];
  await pmap(
    todo,
    async ({ e, status }) => {
      let r: unknown;
      try {
        r = await composioRead(scope, "calendly", "CALENDLY_LIST_EVENT_INVITEES", { uuid: e.uuid, status, count: 20, sort: "created_at:asc" }, acc);
      } catch (err) {
        log.error("calendly invitees read failed", err);
        return;
      }
      const results = await Promise.all(inviteesOf(r, e).map((inv) => applyBooking(rec, parseCalendly(webhookBody(inv, e)), hash, now)));
      for (const res of results) count(report, res);
      // An event with an invitee that was busy is not remembered: the next poll applies it again, and the claims make that safe.
      if (!results.includes("busy")) done.push([e.uuid, status === "active" ? MEMO_ACTIVE : MEMO_CANCELED]);
    },
    CLY_INVITEE_CONCURRENCY,
  );
  // Fields for events no longer in either list go, but only when both lists were read whole.
  const seen = new Set([...active.events, ...canceled.events].map((e) => e.uuid));
  const gone = active.complete && canceled.complete ? Object.keys(memo).filter((k) => !seen.has(k)) : [];
  await Promise.all([...done.map(([k, v]) => db.hset(SEC_KEYS.clyMemo(scope), k, v)), ...gone.map((k) => db.hdel(SEC_KEYS.clyMemo(scope), k))]);
  if (done.length || Object.keys(memo).length) await db.expire(SEC_KEYS.clyMemo(scope), MEMO_TTL_S);
  // The connection may have gone during the reads: it is not put back in the queue.
  const last = await getConnection(scope, "calendly").catch(() => null);
  if (!last || last.connectedAt !== conn.connectedAt) return "dropped";
  await scheduleCalendlyPoll(scope, now + CLY_SYNC_MS);
  return "polled";
}

/** One scope's poll under its lock; a lock that is busy means look again in a minute. */
async function pollOne(scope: string, now: number, report: CalendlySweepReport): Promise<Outcome> {
  const lock = `lock:cly:${scope}`;
  const token = await db.lockOwned(lock, CLY_LOCK_S);
  if (!token) {
    await scheduleCalendlyPoll(scope, now + CLY_BUSY_RETRY_MS);
    return "deferred";
  }
  try {
    return await pollLocked(scope, now, report);
  } finally {
    await db.unlockOwned(lock, token);
  }
}

/**
 * The Calendly part of the secretary tick: takes the (at most `CLY_TICK_MAX`) scopes whose next poll has come out of
 * `sec:cly:due` and polls them `CLY_CONCURRENCY` at a time. Nothing new starts within 30 s of `deadline`; those scopes keep
 * their past score and come first next tick. A scope whose poll threw (Composio down, a rate limit) is logged by name,
 * counts as `retried` and is looked at again in 15 minutes. The members are scopes the sweep took from the queue; no key
 * is built from anything else.
 */
export async function sweepCalendly(now: number, deadline: number): Promise<CalendlySweepReport> {
  const scopes = (await db.zrangeByScore(SEC_KEYS.clyDue, now, CLY_TICK_MAX)).map((m) => m.member).filter((s) => s.length > 0 && s.length <= 320);
  const report: CalendlySweepReport = { ...emptyCalendlyReport(), scopes: scopes.length };
  await pmap(
    scopes,
    async (scope) => {
      if (Date.now() >= deadline - CLY_START_MARGIN_MS) {
        report.deferred++;
        return;
      }
      try {
        const o = await pollOne(scope, now, report);
        if (o === "polled") report.polled++;
        else if (o === "deferred") report.deferred++;
      } catch (e) {
        log.error("calendly poll failed", e);
        report.retried++;
        await scheduleCalendlyPoll(scope, now + CLY_ERROR_RETRY_MS).catch(() => {});
      }
    },
    CLY_CONCURRENCY,
  );
  return report;
}
