import { db } from "./db";
import { isSuspended } from "./suspension";
import { getUser } from "./auth";
import { listBrands } from "./brands";
import { brandFingerprint, brandTag, pushNotifs, withBrand, type Notif } from "./notifications";
import { emailAllowed, readPrefs } from "./notify-prefs";
import { log } from "./log";
import { sendEmail } from "./notify";
import { appOrigin } from "./origin";
import { COPY, paragraphs } from "../emails";
import { pmap } from "./parallel";
import { SEC_ID, SEC_KEYS, SEC_PURGE_BATCH, SERIES_ID, audit, fail, stateOf, withLock, zoneFor, type SecFail, type Who } from "./secretary";
import { arCount, formatWhen, zoneDay, type SecItem } from "./secretary-agenda";
import type { Zone } from "./zones";
import { accountOfScope, brandOfScope } from "./account-id";
import { appHrefInBrand } from "@/lib/ws-href";

/**
 * The closed copies of recurring series: warned about, then deleted 90 days after their close (spec §5, rulings R43,
 * R44, R50, R54). Rules 502-505 in docs/system/tests.md.
 *
 * Safety, in order of importance: a copy is deleted only when it is still closed, its series is not kept, it carries a
 * series, it sat in `sec:spurge` (where only a warning that named its series, or a live 30-day marker set by one, puts
 * it, at a score at least 7 days after that warning) and its brand is active. Every check is made again under the item's
 * lock just before the delete.
 */

const DAY = 864e5;
/** A closed copy is deleted this long after its close. */
export const SERIES_PURGE_MS = 90 * DAY;
/** The warning goes out this long before the deletion, at the least. */
export const SERIES_NOTICE_MS = 7 * DAY;
/** One warning per series per this long (`sec:swarn`, R44): copies reaching the window inside it move silently. */
export const SERIES_MARKER_MS = 30 * DAY;
/** At most this many kept series per brand (`keep_limit`). */
export const SERIES_KEEP_MAX = 500;
/** At most this many series named in one warning; the rest wait for the next day. */
const NAMED_MAX = 5;

/** The account and the brand behind a scope (rule 1986). */
const accountOf = accountOfScope;
const brandIdOf = brandOfScope;
const closedAt = (it: SecItem, fallback: number) => Date.parse(it.completedAt ?? "") || fallback;

type Copy = { id: string; c: number };
type Group = { sid: string; title: string; copies: Copy[] };

/** The warning's text in the owner's language: one line per named series, "and k more", then what they can do. */
function warningText(named: { title: string; n: number; date: string }[], more: number, lang: "ar" | "en"): { title: string; body: string } {
  if (lang === "ar") {
    const lines = named.map((s) => `فيه ${arCount(s.n, { one: "نسخة واحدة", two: "نسختين", few: "نسخ", many: "نسخة" })} من «${s.title.slice(0, 80)}» بتنحذف ابتداءً من ${s.date}.`);
    if (more) lines.push(`و${arCount(more, { one: "مهمة متكررة أخرى", two: "مهمتان متكررتان أخريان", few: "مهام متكررة أخرى", many: "مهمة متكررة أخرى" })}.`);
    lines.push("تقدر تحتفظ بالسجل أو تنزّله CSV");
    return { title: "تنبيه حذف: نسخ منجزة من مهام متكررة", body: lines.join("\n") };
  }
  const lines = named.map((s) => `${s.n === 1 ? "1 closed copy" : `${s.n} closed copies`} of "${s.title.slice(0, 80)}" will be deleted from ${s.date}.`);
  if (more) lines.push(`and ${more} more recurring ${more === 1 ? "to-do" : "to-dos"}.`);
  lines.push("Keep the history or download it as CSV");
  return { title: "Deletion notice: closed copies of recurring to-dos", body: lines.join("\n") };
}

/**
 * Warn (spec §5.2): the copies in `sec:sdone` whose 90-day mark is within 7 days, at most `SEC_PURGE_BATCH` a run.
 * - Ids that cannot be warned about leave `sec:sdone` (R50): no record, not closed, no series, or a kept series. They are
 *   never deleted for it: leaving the window is all that happens, and the daily `requeueSeries` adds back a closed copy of
 *   an unkept series that ended up in neither window.
 * - A series with a live marker (`sec:swarn`, warned under 30 days ago) moves silently, to
 *   `max(closed + 90 d, warned + 7 d, now + 7 d)`: a copy restored long after the warning still gets 7 days from now.
 * - The others: at most 5 named in one notification per brand and local day (its fingerprint), "and k more" for the
 *   rest, which stay for the next day. Only when the notification was pushed are their markers set and their copies moved,
 *   to `max(closed + 90 d, now + 7 d)`. A push that threw or found the day's fingerprint claimed moves none of them.
 * Answers how many copies moved to `sec:spurge`.
 */
export async function warnSeries(scope: string, now = Date.now()): Promise<number> {
  const due = await db.zrangeByScore(SEC_KEYS.sdone(scope), now - (SERIES_PURGE_MS - SERIES_NOTICE_MS), SEC_PURGE_BATCH);
  if (!due.length) return 0;
  const valid = due.filter((m) => SEC_ID.test(m.member));
  const [kept, rows] = await Promise.all([db.smembers(SEC_KEYS.seriesKeep(scope)), db.mget<SecItem>(valid.map((m) => SEC_KEYS.item(scope, m.member)))]);
  const keep = new Set(kept);
  const rowOf = new Map(valid.map((m, i) => [m.member, rows[i]] as const));
  const drop: string[] = [];
  const groups = new Map<string, Group>();
  for (const m of due) {
    const it = rowOf.get(m.member);
    const sid = it?.series?.id;
    if (!it || stateOf(it) !== "done" || !sid || !SERIES_ID.test(sid) || keep.has(sid)) { drop.push(m.member); continue; }
    const c = closedAt(it, m.score);
    // Closed again since it was indexed: not in the window yet by its own close time.
    if (c + SERIES_PURGE_MS - SERIES_NOTICE_MS > now) continue;
    const g = groups.get(sid) ?? { sid, title: it.title, copies: [] };
    g.copies.push({ id: it.id, c });
    groups.set(sid, g);
  }
  if (drop.length) await Promise.all(drop.map((id) => db.zrem(SEC_KEYS.sdone(scope), id)));
  if (!groups.size) return 0;
  // Ordered by each series' earliest copy: `due` is lowest score first, so the insertion order already is.
  const list = [...groups.values()];
  const marks = await db.mget<number | string>(list.map((g) => SEC_KEYS.swarn(scope, g.sid)));
  const silent: { g: Group; w: number }[] = [];
  const fresh: Group[] = [];
  list.forEach((g, i) => {
    const w = Number(marks[i]);
    if (marks[i] !== null && Number.isFinite(w) && now - w < SERIES_MARKER_MS) silent.push({ g, w });
    else fresh.push(g);
  });
  let moved = 0;
  if (silent.length) {
    const rowsS = silent.flatMap(({ g, w }) => g.copies.map((x) => ({ id: x.id, at: Math.max(x.c + SERIES_PURGE_MS, w + SERIES_NOTICE_MS, now + SERIES_NOTICE_MS) })));
    // Into the purge window first, then out of the warn one: a crash between leaves the copy in both, never in neither.
    await Promise.all(rowsS.map((r) => db.zadd(SEC_KEYS.spurge(scope), r.at, r.id)));
    await Promise.all(rowsS.map((r) => db.zrem(SEC_KEYS.sdone(scope), r.id)));
    moved += rowsS.length;
  }
  if (!fresh.length) return moved;
  const named = fresh.slice(0, NAMED_MAX);
  const email = accountOf(scope);
  try {
    const [user, zone, tag] = await Promise.all([getUser(email), zoneFor(scope), brandTag(email, scope)]);
    const lang = user?.lang === "en" ? "en" : "ar";
    const at = (g: Group) => Math.max(Math.min(...g.copies.map((x) => x.c + SERIES_PURGE_MS)), now + SERIES_NOTICE_MS);
    const text = warningText(named.map((g) => ({ title: g.title, n: g.copies.length, date: formatWhen(new Date(at(g)).toISOString(), true, lang, now, zone) })), fresh.length - named.length, lang);
    const title = withBrand(text.title, tag);
    const href = appHrefInBrand(scope, lang, `/todo?series=${named[0].sid}`);
    const n: Omit<Notif, "id" | "at"> = { kind: "todo", agent: "reem", title, body: text.body, href };
    const [pushed] = await pushNotifs(email, [{ n, fingerprint: brandFingerprint(scope, `todo-purge:${zoneDay(now, zone as Zone)}`), ttlDays: 7, scope }]);
    // The day's warning went out already (another run): its copies wait for the next local day.
    if (!pushed) return moved;
    // The marker first (SET, not SET NX: a stale marker whose TTL has not lapsed yet is replaced), then the copies.
    await Promise.all(named.map((g) => db.set(SEC_KEYS.swarn(scope, g.sid), now, Math.ceil(SERIES_MARKER_MS / 1000))));
    const rowsN = named.flatMap((g) => g.copies.map((x) => ({ id: x.id, at: Math.max(x.c + SERIES_PURGE_MS, now + SERIES_NOTICE_MS) })));
    await Promise.all(rowsN.map((r) => db.zadd(SEC_KEYS.spurge(scope), r.at, r.id)));
    await Promise.all(rowsN.map((r) => db.zrem(SEC_KEYS.sdone(scope), r.id)));
    moved += rowsN.length;
    try {
      // Reem's reminder switch (rule 1147); the old "none" level reads as off, as before.
      if (emailAllowed(await readPrefs(scope, email), "reminders")) await sendEmail({ to: email, subject: title, text: `${text.body}\n\n${appOrigin()}${href}`, template: "notice", context: { title, paragraphs: paragraphs(text.body), cta: { href: `${appOrigin()}${href}`, label: COPY[lang].notice.todo } }, locale: lang });
    } catch (e) {
      log.error("sec series warning email failed", e);
    }
  } catch (e) {
    log.error("sec series warning failed", e);
  }
  return moved;
}

/**
 * Repair (R50): a closed copy of an unkept series that is in neither window (a crash between writes, an id the warn step
 * left after a keep raced an un-keep) goes back into `sec:sdone` at its close time, so it is warned about before any
 * deletion. An id in a series set with no record is dropped from the set. Answers how many copies went back.
 */
export async function requeueSeries(scope: string): Promise<number> {
  const [list, kept, sdone, spurge] = await Promise.all([
    db.smembers(SEC_KEYS.seriesList(scope)), db.smembers(SEC_KEYS.seriesKeep(scope)), db.zrangeWithScores(SEC_KEYS.sdone(scope)), db.zrangeWithScores(SEC_KEYS.spurge(scope)),
  ]);
  const keep = new Set(kept);
  const unkept = list.filter((sid) => SERIES_ID.test(sid) && !keep.has(sid));
  if (!unkept.length) return 0;
  const queued = new Set([...sdone, ...spurge].map((m) => m.member));
  const sets = await pmap(unkept, (sid) => db.zrangeWithScores(SEC_KEYS.series(scope, sid)), 8);
  const missing = unkept.flatMap((sid, i) => sets[i].filter((m) => !queued.has(m.member)).map((m) => ({ sid, id: m.member, score: m.score })));
  if (!missing.length) return 0;
  // Only well-formed ids reach a key; any other member is a ghost, dropped from its series set.
  const valid = missing.filter((m) => SEC_ID.test(m.id));
  const chunks: (typeof missing)[] = [];
  for (let i = 0; i < valid.length; i += 500) chunks.push(valid.slice(i, i + 500));
  const rows = (await pmap(chunks, (ch) => db.mget<SecItem>(ch.map((m) => SEC_KEYS.item(scope, m.id))), 4)).flat();
  const back = valid.filter((m, i) => rows[i] && stateOf(rows[i]!) === "done" && rows[i]!.series?.id === m.sid);
  const ghosts = [...missing.filter((m) => !SEC_ID.test(m.id)), ...valid.filter((_, i) => !rows[i])];
  await Promise.all([
    ...back.map((m) => db.zadd(SEC_KEYS.sdone(scope), m.score, m.id)),
    ...ghosts.map((m) => db.zrem(SEC_KEYS.series(scope, m.sid), m.id)),
  ]);
  return back.length;
}

/**
 * Delete (spec §5.2): the warned copies whose time came, at most `SEC_PURGE_BATCH` a run, each under its item lock
 * (`pmap`, 8 at a time). Under the lock the copy is read again with its `sec:spurge` score: it is deleted only while it
 * is still in `sec:spurge` with a score due now, still closed, of a series that is not kept, and 90 days past its close.
 * Otherwise it leaves `sec:spurge` (and, closed again since its warning, goes back to `sec:sdone` to be warned again).
 * A copy whose lock is busy, or whose step threw, waits for the next day. Answers how many copies were deleted, and the
 * one `series_purge` audit line carries that same count.
 */
export async function purgeSeries(scope: string, now = Date.now()): Promise<number> {
  const due = await db.zrangeByScore(SEC_KEYS.spurge(scope), now, SEC_PURGE_BATCH);
  if (!due.length) return 0;
  const bad = due.filter((m) => !SEC_ID.test(m.member)).map((m) => m.member);
  if (bad.length) await Promise.all(bad.map((id) => db.zrem(SEC_KEYS.spurge(scope), id)));
  const ids = due.filter((m) => SEC_ID.test(m.member)).map((m) => m.member);
  // One copy's failure (a Redis call that threw, its lock) is logged and skipped: it stays in `sec:spurge` and the next day
  // retries it, while the others are still deleted, counted and audited.
  const out = await pmap(ids, async (id) => {
    try {
      const r = await withLock(scope, id, () => purgeOne(scope, id, now));
      return typeof r === "string" ? r : null;
    } catch (e) {
      log.error("sec series purge item failed", e);
      return null;
    }
  }, 8);
  const gone = out.filter((x): x is string => typeof x === "string");
  if (!gone.length) return 0;
  // A series with no closed copy left leaves the list and its marker goes. Read again after: a copy closed in between
  // puts it back, so `secretaryKeys` still finds its set.
  await pmap([...new Set(gone)], async (sid) => {
    try {
      if ((await db.zcard(SEC_KEYS.series(scope, sid))) > 0) return;
      await Promise.all([db.srem(SEC_KEYS.seriesList(scope), sid), db.del(SEC_KEYS.swarn(scope, sid))]);
      if ((await db.zcard(SEC_KEYS.series(scope, sid))) > 0) await db.sadd(SEC_KEYS.seriesList(scope), sid);
    } catch (e) {
      log.error("sec series list cleanup failed", e);
    }
  }, 8);
  try {
    await audit(scope, { actor: "cron", via: "cron" }, "series_purge", "-", `${gone.length} closed copy(ies) of recurring to-dos deleted 90 days after their close`);
  } catch (e) {
    log.error("sec series purge audit failed", e);
  }
  return gone.length;
}

/**
 * One copy of `purgeSeries`, under its item lock: answers its series id when the record was deleted, null otherwise. The
 * record is deleted first, alone: once that write returns the copy is gone and counted, and an index write that throws
 * after it is only logged (a leftover id is dropped by the next purge, requeue or `purgeExpired`).
 */
async function purgeOne(scope: string, id: string, now: number): Promise<string | null> {
  const [it, score] = await Promise.all([db.get<SecItem>(SEC_KEYS.item(scope, id)), db.zscore(SEC_KEYS.spurge(scope), id)]);
  // Taken out of the window (reopened, deleted, kept) or moved later since the read: nothing to do.
  if (score === null || score > now) return null;
  if (!it) {
    await Promise.all([db.zrem(SEC_KEYS.spurge(scope), id), db.zrem(SEC_KEYS.sdone(scope), id)]);
    return null;
  }
  const sid = it.series?.id;
  if (stateOf(it) !== "done" || !sid || !SERIES_ID.test(sid)) {
    await db.zrem(SEC_KEYS.spurge(scope), id);
    return null;
  }
  if (await db.sismember(SEC_KEYS.seriesKeep(scope), sid)) {
    await db.zrem(SEC_KEYS.spurge(scope), id);
    return null;
  }
  const c = closedAt(it, 0);
  if (!c || c + SERIES_PURGE_MS > now) {
    // Closed again after its warning (the index should have moved it): warned again before any deletion.
    await db.zadd(SEC_KEYS.sdone(scope), c || now, id);
    await db.zrem(SEC_KEYS.spurge(scope), id);
    return null;
  }
  await db.del(SEC_KEYS.item(scope, id));
  try {
    await Promise.all([
      db.del(SEC_KEYS.spawn(scope, id)), db.srem(SEC_KEYS.all(scope), id), db.lrem(SEC_KEYS.done(scope), id),
      db.zrem(SEC_KEYS.open(scope), id), db.zrem(SEC_KEYS.due(scope), id), db.zrem(SEC_KEYS.deleted(scope), id),
      db.zrem(SEC_KEYS.spurge(scope), id), db.zrem(SEC_KEYS.sdone(scope), id), db.zrem(SEC_KEYS.series(scope, sid), id),
    ]);
  } catch (e) {
    log.error("sec series purge index cleanup failed", e);
  }
  return sid;
}

/**
 * Keep a series' history, or stop keeping it (spec §5.2). Serialised per brand (`withLock` on "serieskeep").
 * - Keep: `keep_limit` (409) when 500 series are kept already and this one is not; `sec:serieskeep` is written first, then
 *   the series' copies leave `sec:sdone` and `sec:spurge`, and its marker goes.
 * - Un-keep (of a kept series): the copies leave `sec:spurge` (a stale entry from a warn run that raced the keep) and go
 *   back into `sec:sdone` only, and the marker goes, so they are named in a new warning at least 7 days before any deletion.
 * The id is checked for its form only (`not_found`, 404): the route checks that the series exists (one ZCARD). One audit
 * line, `series_keep` or `series_unkeep`, with `who`: the route does not write another. `moved`: copies taken out of or put
 * back into the windows.
 */
export async function setSeriesKeep(scope: string, id: string, keep: boolean, who: Who): Promise<{ ok: true; kept: boolean; moved: number } | SecFail> {
  if (!SERIES_ID.test(id)) return fail("not_found", 404);
  const r = await withLock(scope, "serieskeep", async (): Promise<{ ok: true; kept: boolean; moved: number } | SecFail> => {
    const was = await db.sismember(SEC_KEYS.seriesKeep(scope), id);
    let moved = 0;
    if (keep) {
      if (!was && ((await db.scardMany([SEC_KEYS.seriesKeep(scope)]))[0] ?? 0) >= SERIES_KEEP_MAX) return fail("keep_limit", 409);
      await db.sadd(SEC_KEYS.seriesKeep(scope), id);
      const copies = await db.zrangeWithScores(SEC_KEYS.series(scope, id));
      await pmap(copies, (m) => Promise.all([db.zrem(SEC_KEYS.sdone(scope), m.member), db.zrem(SEC_KEYS.spurge(scope), m.member)]), 8);
      await db.del(SEC_KEYS.swarn(scope, id));
      moved = copies.length;
    } else if (was) {
      await db.srem(SEC_KEYS.seriesKeep(scope), id);
      const copies = await db.zrangeWithScores(SEC_KEYS.series(scope, id));
      // Out of `sec:spurge` too: an entry a racing warn run wrote after the keep must not delete without a new warning.
      await pmap(copies, async (m) => { await db.zrem(SEC_KEYS.spurge(scope), m.member); await db.zadd(SEC_KEYS.sdone(scope), m.score, m.member); }, 8);
      await db.del(SEC_KEYS.swarn(scope, id));
      moved = copies.length;
    }
    await audit(scope, who, keep ? "series_keep" : "series_unkeep", id, `${moved} closed copy(ies)`);
    return { ok: true, kept: keep, moved };
  }, 60);
  return r;
}

/**
 * One series' closed copies, newest close first, at most `limit` (the `?series=` view, the CSV export), with how many
 * the series set holds. Reads `sec:series:{scope}:{id}` only; records chunked 500 to an MGET (`pmap`). A record that is
 * missing, not closed or of another series is left out.
 */
export async function seriesRows(scope: string, id: string, limit: number): Promise<{ items: SecItem[]; total: number }> {
  if (!SERIES_ID.test(id)) return { items: [], total: 0 };
  const all = await db.zrangeWithScores(SEC_KEYS.series(scope, id));
  const ids = all.map((m) => m.member).reverse().filter((x) => SEC_ID.test(x)).slice(0, Math.max(0, limit));
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
  const rows = (await pmap(chunks, (ch) => db.mget<SecItem>(ch.map((x) => SEC_KEYS.item(scope, x))), 4)).flat();
  return { items: rows.filter((it): it is SecItem => !!it && stateOf(it) === "done" && it.series?.id === id), total: all.length };
}

/**
 * The daily job's series steps for one brand scope: delete what is due, repair the windows, then warn. Nothing runs for
 * an idle brand (no account, a suspended account, an archived or missing brand row), whatever path called it. Each step's
 * failure is logged by its error's name and counted as 0: the next day retries it, and a failed warning never lets a
 * deletion through (deletion reads only `sec:spurge`).
 */
export async function seriesDaily(scope: string, now = Date.now()): Promise<{ warned: number; deleted: number; idle: boolean }> {
  const email = accountOf(scope);
  const [user, brands] = await Promise.all([getUser(email), listBrands(email)]);
  const row = brands.find((b) => b.id === brandIdOf(scope));
  if (!user || isSuspended(user) || !row || row.status !== "active") return { warned: 0, deleted: 0, idle: true };
  const step = <T,>(name: string, f: () => Promise<T>, empty: T) => f().catch((e) => {
    log.error(`sec series ${name} failed`, e);
    return empty;
  });
  const deleted = await step("purge", () => purgeSeries(scope, now), 0);
  await step("requeue", () => requeueSeries(scope), 0);
  const warned = await step("warn", () => warnSeries(scope, now), 0);
  return { warned, deleted, idle: false };
}
