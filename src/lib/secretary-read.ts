/**
 * Reem, the secretary: reads (open, done, deleted lists, the agenda, the to-do page), the daily purge, the account-wipe key list and alert fingerprints.
 */
import { CAPS, db } from "./db";
import { pmap } from "./parallel";
import { getBrand, pendingCount, type Task } from "./brand";
import { DEFAULT_ZONE, zoneOf, type Zone } from "./zones";
import { SEC_RESTORE_DAYS, computeAgenda, type Agenda, type AwayMap, type CalData, type LinkedFact, type SecItem } from "./secretary-agenda";
import { calendarView, type CalendarView } from "./secretary-calendar";
import { log } from "./log";
import { SEC_ID, SEC_KEYS, SEC_PURGE_BATCH, SERIES_ID, TASK_ID } from "./secretary-keys";
import type { Who } from "./secretary-input";
import { audit, listOpenItems, stateOf } from "./secretary-store";
import { calOf, calReads, usableCalendar, zoneFor } from "./secretary-zone";
import { closeLinked, timedReminders } from "./secretary-change";
import { snoozePreset } from "./secretary-owner";

/** What code knows of an inbox task, for the fact shown next to an agent's claim (`linkFactText`). */
export const factOf = (t: Task | null): LinkedFact | null => (t ? { title: t.title, status: t.status, ...(t.decidedAt ? { decidedAt: t.decidedAt } : {}), ...(t.published?.length ? { published: t.published } : {}) } : null);

/** Linked inbox tasks of some items, read under the same scope in one MGET, keyed by task id (null: the task is gone). */
async function linkedTasks(scope: string, items: SecItem[]): Promise<Map<string, Task | null>> {
  const ids = [...new Set(items.map((it) => it.links?.taskId).filter((id): id is string => !!id && TASK_ID.test(id)))];
  if (!ids.length) return new Map();
  const tasks = await db.mget<Task>(ids.map((id) => `task:${scope}:${id}`));
  return new Map(ids.map((id, i) => [id, tasks[i] ?? null]));
}

/**
 * The agenda of one scope at `now`, in the brand's zone and on its work calendar and away map, with the approvals inbox
 * count. Items whose linked inbox item was approved are closed first (`closeLinked`) and left out; `facts` holds what
 * code read about the links of the rest; `cal` and `away` are what the agenda was computed with, for callers that compute
 * more from the same list (the evening wrap). Reads: the open set, one MGET of items, the pending count, the brand file
 * (its zone), `sec:cal` and `sec:away` (`calFor`), and one MGET of linked tasks when any item has a link: the same
 * number whatever the number of items or away contacts.
 */
export async function agendaFor(scope: string, now = Date.now(), who: Who = { actor: "rule", via: "web" }): Promise<Agenda & { closed: number; facts: Record<string, LinkedFact | null>; cal: CalData; away: AwayMap }> {
  return (await agendaWith(scope, now, who)).agenda;
}
/** `agendaFor`, and the records it read the calendar from (`calReads`), for a caller that shows them too (the to-do page). */
async function agendaWith(scope: string, now: number, who: Who) {
  const [items, approvals, reads] = await Promise.all([listOpenItems(scope), pendingCount(scope), calReads(scope)]);
  const { zone, cal, away } = calOf(reads, now);
  const tasks = await linkedTasks(scope, items);
  let closed = new Set<string>();
  const approved = items.filter((it) => it.links?.taskId && tasks.get(it.links.taskId)?.status === "approved");
  if (approved.length) {
    const done = await Promise.all(approved.map((it) => closeLinked(scope, it.id, who, { zone, cal })));
    closed = new Set(approved.filter((_, i) => done[i]).map((it) => it.id));
  }
  const facts = Object.fromEntries([...tasks].map(([id, t]) => [id, factOf(t)]));
  return { agenda: { ...computeAgenda(items.filter((it) => !closed.has(it.id)), now, { approvals, zone, cal, away }), closed: closed.size, facts, cal, away }, reads };
}

/**
 * What the My to-dos page shows, read at one instant (server components may not read the clock themselves): the agenda
 * first, since it closes items whose linked inbox item was approved and those then show under "done". `facts` covers
 * the links of open and done items alike (one more MGET for the done ones), so every row can show what code checked.
 * The brand file, `sec:cal` and `sec:away` the agenda read are handed on, never read again: `brand`, the Working days
 * view (`working`: `calendarView`, the same view GET /api/secretary/calendar answers, of the stored settings when the
 * calendar can be built from them, `usableCalendar`) and the away hash as stored (`awayRows`, for `awayListOf`).
 */
export async function todoPage(scope: string, opts: { series: string }): Promise<{ now: number; zone: Zone; series: { id: string; items: SecItem[]; total: number; kept: boolean } }>;
export async function todoPage(scope: string): Promise<Awaited<ReturnType<typeof todoMain>>>;
export async function todoPage(scope: string, opts?: { series: string }) {
  return opts ? seriesPage(scope, opts.series) : todoMain(scope);
}

/**
 * The `?series=` view: one recurring series' closed copies (at most 200, newest close first) and how many it holds, read
 * from that series' own set (`seriesRows`) first. An id with no closed copies (unknown, another brand's, or a series
 * whose copies are all open) stops there with `total` 0: nothing else is read. On a hit one more round reads the brand's
 * zone (the brand file) and whether the series is kept; no agenda, calendar or away list is read either way.
 */
async function seriesPage(scope: string, id: string) {
  const now = Date.now();
  const { seriesRows } = await import("./secretary-series");
  const { items, total } = await seriesRows(scope, id, 200);
  if (total === 0) return { now, zone: DEFAULT_ZONE, series: { id, items: [], total: 0, kept: false } };
  const [brand, kept] = await Promise.all([getBrand(scope), db.sismember(SEC_KEYS.seriesKeep(scope), id)]);
  return { now, zone: zoneOf(brand), series: { id, items, total, kept: !!kept } };
}

async function todoMain(scope: string) {
  const now = Date.now();
  const { agenda, reads } = await agendaWith(scope, now, { actor: "rule", via: "web" });
  const [done, deleted] = await Promise.all([listDone(scope, 10), listDeleted(scope, now, 50)]);
  const doneTasks = await linkedTasks(scope, done.filter((it) => it.links?.taskId && !(it.links.taskId in agenda.facts)));
  const facts = { ...agenda.facts, ...Object.fromEntries([...doneTasks].map(([id, t]) => [id, factOf(t)])) };
  // Whether a reminder can be promised "at" its time, or only with the next morning brief.
  const timed = await timedReminders(now);
  const working: CalendarView = calendarView(usableCalendar(reads.stored, agenda.zone, now), agenda.zone, now);
  return { now, zone: agenda.zone, agenda, done, deleted, facts, tonight: snoozePreset("tonight", now, agenda.zone) !== null, timed, brand: reads.brand, working, awayRows: reads.rows };
}

/** The latest completed items (newest first), deleted ones left out. One list read and one MGET. */
export async function listDone(scope: string, limit: number = CAPS.secDone): Promise<SecItem[]> {
  const ids = (await db.lrange(SEC_KEYS.done(scope), 0, limit - 1)).filter((id) => SEC_ID.test(id));
  const rows = await db.mget<SecItem>(ids.map((id) => SEC_KEYS.item(scope, id)));
  const seen = new Set<string>();
  return rows.filter((it): it is SecItem => !!it && stateOf(it) === "done" && !seen.has(it.id) && !!seen.add(it.id));
}

/** Deleted items that can still be restored, soonest to expire first, at most `limit`. */
export async function listDeleted(scope: string, now = Date.now(), limit = 200): Promise<SecItem[]> {
  const ids = (await db.zrangeWithScores(SEC_KEYS.deleted(scope))).filter((m) => m.score > now && SEC_ID.test(m.member)).map((m) => m.member).slice(0, limit);
  const rows = await db.mget<SecItem>(ids.map((id) => SEC_KEYS.item(scope, id)));
  return rows.filter((it): it is SecItem => !!it && stateOf(it) === "deleted" && Date.parse(it.expiresAt ?? "") > now);
}

/**
 * Remove items deleted more than 30 days ago, at most `SEC_PURGE_BATCH` per scope per run (the rest wait for the next
 * day). An expired item can no longer be restored, so nothing races with this.
 */
export async function purgeExpired(scope: string, now = Date.now()): Promise<number> {
  const due = (await db.zrangeWithScores(SEC_KEYS.deleted(scope))).filter((m) => m.score <= now).slice(0, SEC_PURGE_BATCH).map((m) => m.member);
  if (!due.length) return 0;
  const valid = due.filter((id) => SEC_ID.test(id));
  const rows = await db.mget<SecItem>(valid.map((id) => SEC_KEYS.item(scope, id)));
  const gone = valid.filter((_, i) => !rows[i] || (rows[i]!.deletedAt && Date.parse(rows[i]!.expiresAt ?? "") <= now));
  const junk = due.filter((id) => !SEC_ID.test(id));
  const seriesOf = new Map(valid.map((id, i) => [id, rows[i]?.series?.id] as const));
  await pmap([...gone, ...junk], (id) => {
    const sid = seriesOf.get(id);
    return Promise.all([
      db.del(SEC_KEYS.item(scope, id)), db.zrem(SEC_KEYS.deleted(scope), id), db.srem(SEC_KEYS.all(scope), id), db.lrem(SEC_KEYS.done(scope), id), db.zrem(SEC_KEYS.open(scope), id), db.zrem(SEC_KEYS.due(scope), id),
      db.zrem(SEC_KEYS.sdone(scope), id), db.zrem(SEC_KEYS.spurge(scope), id), ...(sid && SERIES_ID.test(sid) ? [db.zrem(SEC_KEYS.series(scope, sid), id)] : []),
    ]);
  }, 8);
  // A series with no closed copy left leaves the list (and its warning marker goes); the next close adds it again.
  const touched = [...new Set(gone.map((id) => seriesOf.get(id)).filter((sid): sid is string => !!sid && SERIES_ID.test(sid)))];
  await pmap(touched, async (sid) => {
    if ((await db.zcard(SEC_KEYS.series(scope, sid))) === 0) await Promise.all([db.srem(SEC_KEYS.seriesList(scope), sid), db.del(SEC_KEYS.swarn(scope, sid))]);
  }, 8);
  if (gone.length) await audit(scope, { actor: "cron", via: "cron" }, "purge", "-", `${gone.length} item(s) deleted over ${SEC_RESTORE_DAYS} days ago`);
  return gone.length;
}

/**
 * The daily job's part: purge, and next to it the away list's clean-up (`cleanAway`: entries ended over 30 days ago);
 * then the recurring series' warning and deletion of closed copies (`seriesDaily`); then close linked items whose inbox item was approved. Returns the agenda it computed. A failed clean-up is logged by
 * its error's name and retried the next day: it never stops the agenda or the auto-close.
 */
export async function secretaryDaily(scope: string, now = Date.now()) {
  const [purged, awayCleaned] = await Promise.all([
    purgeExpired(scope, now),
    // Loaded here, not at the top: secretary-away.ts builds on this module.
    Promise.all([import("./secretary-away"), zoneFor(scope)])
      .then(([away, zone]) => away.cleanAway(scope, now, zone))
      .catch((e) => {
        log.error("sec away clean-up failed", e);
        return 0;
      }),
  ]);
  // The closed copies of recurring series: delete what was warned about and is due, then warn (secretary-series.ts,
  // rules 502-505). Never for an idle brand; a failure is logged and retried the next day.
  const series = await import("./secretary-series")
    .then((m) => m.seriesDaily(scope, now))
    .catch((e) => {
      log.error("sec series step failed", e);
      return { warned: 0, deleted: 0, idle: false };
    });
  const agenda = await agendaFor(scope, now, { actor: "cron", via: "cron" });
  return { purged, closed: agenda.closed, agenda, awayCleaned, warned: series.warned, deleted: series.deleted };
}

/**
 * Every key account deletion removes for one brand scope (locks expire in 10 s, the sweep's reminder leases in 330 s;
 * rate windows in a day). The scope's
 * member of the global `sec:duescopes` is not a key: `wipeAccount` removes it with `forgetDueScope`.
 */
export async function secretaryKeys(scope: string): Promise<string[]> {
  const [ids, props, series, books, meets] = await Promise.all([db.smembers(SEC_KEYS.all(scope)), db.smembers(SEC_KEYS.awayProps(scope)), db.smembers(SEC_KEYS.seriesList(scope)), db.smembers(SEC_KEYS.bookIds(scope)), db.smembers(SEC_KEYS.mprops(scope))]);
  // The alert counters and wrap markers live two days; every local day they can name, in any zone, from two days back
  // to tomorrow.
  const days = [...new Set([-2, -1, 0, 1].map((d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10)))];
  return [
    ...ids.map((id) => SEC_KEYS.item(scope, id)), SEC_KEYS.open(scope), SEC_KEYS.done(scope), SEC_KEYS.deleted(scope), SEC_KEYS.all(scope), SEC_KEYS.audit(scope),
    SEC_KEYS.due(scope), SEC_KEYS.walk(scope), SEC_KEYS.notes(scope), SEC_KEYS.cal(scope), SEC_KEYS.away(scope),
    // The linked calendar (Reem B3): the link record and its synced events.
    SEC_KEYS.calLink(scope), SEC_KEYS.calEvents(scope),
    ...days.flatMap((d) => [SEC_KEYS.alerts(scope, d), SEC_KEYS.wrap(scope, d)]),
    // Reem's away proposals (rule 485): each record and its outcome, by the ids in the index, and the index.
    ...props.flatMap((id) => [SEC_KEYS.awayProp(scope, id), SEC_KEYS.awayPropDone(scope, id)]), SEC_KEYS.awayProps(scope),
    // Recurring series (rule 508): the indexes, each listed series' set and warning marker, and the next-copy claim of every
    // id still in `sec:all`. A claim of an already purged copy is not found and lapses by its 2-day TTL.
    SEC_KEYS.seriesList(scope), SEC_KEYS.sdone(scope), SEC_KEYS.spurge(scope), SEC_KEYS.seriesKeep(scope),
    ...series.flatMap((sid) => [SEC_KEYS.series(scope, sid), SEC_KEYS.swarn(scope, sid)]),
    ...ids.map((id) => SEC_KEYS.spawn(scope, id)),
    // Bookings (Reem B2a): every claim the brand made, by the `{provider}:{externalId}` its index holds (an external id
    // may itself hold colons: a Calendly invitee is a URL), and the index.
    ...books.flatMap((m) => {
      const i = m.indexOf(":");
      return i > 0 ? [SEC_KEYS.bookClaim(scope, m.slice(0, i), m.slice(i + 1))] : [];
    }),
    SEC_KEYS.bookIds(scope),
    // Meeting proposals (Reem B2b): each pending set by the item ids its index holds, and the index. The approve lock
    // (`sec:lock:{scope}:mprop:{id}`, also taken by the pending writes) lives 60 s.
    ...meets.map((id) => SEC_KEYS.mprop(scope, id)), SEC_KEYS.mprops(scope),
    // The run counter of every item still in `sec:all` (one lapses by its TTL when its item was purged), and the proposing
    // lock (`sec:lock:{scope}:mrun:{id}`, 60 s).
    ...ids.map((id) => SEC_KEYS.mrun(scope, id)),
  ];
}
/** Account deletion: the scope leaves the sweep's global index and the calendar sync queue. */
export const forgetDueScope = async (scope: string): Promise<void> => {
  await Promise.all([db.zrem(SEC_KEYS.dueScopes, scope), db.zrem(SEC_KEYS.calDue, scope)]);
};

/**
 * The marker of one alert step (0, 1, 3 or 7) of one item, keyed by its anchor in ms: the due time for the owner's own
 * item (`Date.parse(dueAt)`, so its marker reads as it always did) and the chase moment's anchor for an item someone
 * else owes. A new due date or chase moment is a new signature, so an item that falls behind again starts afresh.
 */
export const overdueAlertFingerprint = (scope: string, id: string, anchorMs: number, step: number) => `todo-due:${scope}:${id}:${anchorMs}:${step}`;
/** The marker of the one "back from an absence" alert of an item: once per absence, named by its last day `until`. */
export const backFingerprint = (scope: string, id: string, until: string) => `todo-back:${scope}:${id}:${until}`;
