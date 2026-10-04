import { afterEach, describe, expect, it, vi } from "vitest";
import { json, newMember, newUser, params, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { wipeAccount } from "@/lib/account";
import { getUser, saveUser } from "@/lib/auth";
import { saveBrands, scopeFor } from "@/lib/brands";
import { listNotifs, seenKey } from "@/lib/notifications";
import * as listRoute from "@/app/api/secretary/route";
import * as itemRoute from "@/app/api/secretary/[id]/route";
import * as keepRoute from "@/app/api/secretary/series/[seriesId]/keep/route";
import * as exportRoute from "@/app/api/secretary/series/[seriesId]/export/route";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { appDict } from "@/lib/app-i18n";
import Page from "@/app/[lang]/app/todo/page";
import TodoPanel, { type TodoRow } from "@/components/app/TodoPanel";
import { SEC_KEYS, newSecId, newSeriesId, purgeExpired, secretaryDaily, secretaryKeys, type Who } from "@/lib/secretary";
import { SERIES_KEEP_MAX, purgeSeries, requeueSeries, seriesRows, setSeriesKeep, warnSeries } from "@/lib/secretary-series";
import { formatWhen, zoneDay, type SecItem } from "@/lib/secretary-agenda";

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async (to: string, subject: string, text: string) => { sent.push({ to, subject, text }); return true; } }));
import * as cronDaily from "@/app/api/cron/daily/route";
// The app router only exists inside Next: the page's client components get a router whose refresh does nothing.
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const z = "Asia/Riyadh";
const create = (body: unknown) => listRoute.POST(json("/api/secretary", "POST", body));
const patch = (id: string, body: unknown) => itemRoute.PATCH(json(`/api/secretary/${id}`, "PATCH", body), params({ id }));
async function login() {
  const u = await newUser("secser");
  await signIn(u.email);
  return u;
}
async function add(body: Record<string, unknown>): Promise<SecItem> {
  const r = await create(body);
  const j = await r.json();
  expect(r.status, JSON.stringify(j)).toBe(200);
  return j.item as SecItem;
}
const inDays = (d: number, hh = 10) => `${zoneDay(Date.now() + d * 864e5, z)}T${String(hh).padStart(2, "0")}:00`;
const recurring = (title = "Water the plants") => add({ title, dueAt: inDays(1, 9), repeat: { every: "day" } });
const memKeys = () => { const m = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; lists: Map<string, unknown>; sets: Map<string, unknown>; zsets?: Map<string, unknown> } }).__nashrMem; return [...m.kv.keys(), ...m.lists.keys(), ...m.sets.keys(), ...(m.zsets?.keys() ?? [])]; };
const members = async (key: string) => (await db.zrangeWithScores(key)).map((m) => m.member);
const complete = async (id: string) => (await (await patch(id, { action: "complete", result: "ok" })).json()).item as SecItem;

describe("rule 496: series indexes follow every transition", () => {
  it("done → open, done → deleted and purge remove the id from series, sdone and spurge", async () => {
    const o = await login();
    const a = await complete((await recurring("A")).id);
    const sid = a.series!.id;
    expect(await members(SEC_KEYS.series(o.email, sid))).toEqual([a.id]);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([a.id]);
    expect(await db.smembers(SEC_KEYS.seriesList(o.email))).toEqual([sid]);
    const [row] = await db.zrangeWithScores(SEC_KEYS.series(o.email, sid));
    expect(row.score).toBe(Date.parse(a.completedAt!));

    // Reopen: out of all three, even when the copy was already warned about (in spurge).
    await db.zadd(SEC_KEYS.spurge(o.email), Date.now() + 864e5, a.id);
    expect((await patch(a.id, { action: "reopen" })).status).toBe(200);
    for (const k of [SEC_KEYS.series(o.email, sid), SEC_KEYS.sdone(o.email), SEC_KEYS.spurge(o.email)]) expect(await members(k)).toEqual([]);

    // Delete of a closed copy: out of all three.
    const done = await complete(a.id);
    await db.zadd(SEC_KEYS.spurge(o.email), Date.now() + 864e5, a.id);
    expect(done.series!.id).toBe(sid);
    expect((await patch(a.id, { action: "delete" })).status).toBe(200);
    for (const k of [SEC_KEYS.series(o.email, sid), SEC_KEYS.sdone(o.email), SEC_KEYS.spurge(o.email)]) expect(await members(k)).toEqual([]);

    // Purge: a copy that is still in them (seeded, as a crash between writes could leave it) goes with the item.
    await db.zadd(SEC_KEYS.series(o.email, sid), 1, a.id);
    await db.zadd(SEC_KEYS.sdone(o.email), 1, a.id);
    await db.zadd(SEC_KEYS.spurge(o.email), 1, a.id);
    // 2: A, and the untouched next copy the reopen deleted (rule 499), whose restore window ends the same day.
    expect(await purgeExpired(o.email, Date.now() + 31 * 864e5)).toBe(2);
    for (const k of [SEC_KEYS.series(o.email, sid), SEC_KEYS.sdone(o.email), SEC_KEYS.spurge(o.email)]) expect(await members(k)).toEqual([]);
  });

  it("deleted → done (restore) indexes the copy again", async () => {
    const o = await login();
    const a = await complete((await recurring()).id);
    const sid = a.series!.id;
    await patch(a.id, { action: "delete" });
    expect(await members(SEC_KEYS.series(o.email, sid))).toEqual([]);
    const r = await patch(a.id, { action: "restore" });
    expect(((await r.json()).item as SecItem).completedAt).toBeTruthy();
    expect(await members(SEC_KEYS.series(o.email, sid))).toEqual([a.id]);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([a.id]);
    expect(await db.smembers(SEC_KEYS.seriesList(o.email))).toEqual([sid]);
  });

  it("a kept series is not added to sdone, on a close or on a restore, but is in series", async () => {
    const o = await login();
    const first = await recurring();
    await db.sadd(SEC_KEYS.seriesKeep(o.email), first.series!.id);
    const a = await complete(first.id);
    expect(await members(SEC_KEYS.series(o.email, a.series!.id))).toEqual([a.id]);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([]);
    await patch(a.id, { action: "delete" });
    await patch(a.id, { action: "restore" });
    expect(await members(SEC_KEYS.series(o.email, a.series!.id))).toEqual([a.id]);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([]);
  });

  it("an item with no series touches none of the series keys", async () => {
    const o = await login();
    const a = await complete((await add({ title: "Plain", dueAt: inDays(1) })).id);
    await patch(a.id, { action: "reopen" });
    expect(memKeys().filter((k) => k.includes(o.email) && /^sec:(series|serieslist|sdone|spurge|serieskeep)/.test(k))).toEqual([]);
  });
});

describe("rule 508: account deletion removes every new key", () => {
  it("a closed recurring copy, its series set, serieslist, sdone, spurge, serieskeep, its swarn marker and the spawn claim of every copy still in sec:all are gone", async () => {
    const u = await login();
    const a = await complete((await recurring()).id);
    const sid = a.series!.id;
    const open = await recurring("Another");
    await db.zadd(SEC_KEYS.spurge(u.email), Date.now() + 864e5, a.id);
    await db.sadd(SEC_KEYS.seriesKeep(u.email), open.series!.id);
    expect(await db.setNx(SEC_KEYS.swarn(u.email, sid), "1", 30 * 864e5)).toBe(true);
    // The close wrote A's claim itself (rule 497).
    expect(await db.get(SEC_KEYS.spawn(u.email, a.id))).toBe(a.nextId);
    expect(await db.setNx(SEC_KEYS.spawn(u.email, open.id), "s0123456789abcdee", 2 * 864e5)).toBe(true);
    const keys = await secretaryKeys(u.email);
    for (const k of [SEC_KEYS.series(u.email, sid), SEC_KEYS.seriesList(u.email), SEC_KEYS.sdone(u.email), SEC_KEYS.spurge(u.email), SEC_KEYS.seriesKeep(u.email), SEC_KEYS.swarn(u.email, sid), SEC_KEYS.spawn(u.email, a.id), SEC_KEYS.spawn(u.email, open.id)]) expect(keys).toContain(k);
    await wipeAccount(u.email);
    expect(memKeys().filter((k) => k.startsWith("sec:") && k.includes(u.email))).toEqual([]);
  });

  it("purging the last copy of a series removes it from serieslist and its warning marker; a series with another closed copy stays", async () => {
    const o = await login();
    const first = await recurring("One");
    const a = await complete(first.id);
    const sid = a.series!.id;
    await db.setNx(SEC_KEYS.swarn(o.email, sid), "1", 30 * 864e5);
    // A second closed copy of the same series (same id, as a spawn would make it).
    const b = await complete((await add({ title: "Two", dueAt: inDays(2, 9) })).id);
    await db.set(SEC_KEYS.item(o.email, b.id), { ...b, series: { id: sid, n: 2 } });
    await db.zadd(SEC_KEYS.series(o.email, sid), Date.parse(b.completedAt!), b.id);
    await patch(a.id, { action: "delete" });
    expect(await purgeExpired(o.email, Date.now() + 31 * 864e5)).toBe(1);
    expect(await db.smembers(SEC_KEYS.seriesList(o.email))).toEqual([sid]);
    expect(await db.get(SEC_KEYS.swarn(o.email, sid))).not.toBeNull();
    expect(await members(SEC_KEYS.series(o.email, sid))).toEqual([b.id]);
    await patch(b.id, { action: "delete" });
    expect(await purgeExpired(o.email, Date.now() + 31 * 864e5)).toBe(1);
    expect(await db.smembers(SEC_KEYS.seriesList(o.email))).toEqual([]);
    expect(await db.get(SEC_KEYS.swarn(o.email, sid))).toBeNull();
    expect(await members(SEC_KEYS.series(o.email, sid))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Rules 502-505: the daily warning and deletion of closed copies (spec §5.2, R43, R44, R50, R54).

const DAY = 864e5;
/** 09:00 in Riyadh on a fixed day: same-day reruns stay on one local day. */
const T = Date.parse("2026-10-05T06:00:00Z");
const OWNER: Who = { actor: "owner", via: "web", login: "owner@test.example" };

/** One closed copy of a series, stored and indexed the way a close leaves it (indexWrites): sdone unless `sdone: false`. */
async function seedCopy(scope: string, sid: string, closedAt: number, p: Partial<SecItem> & { sdone?: boolean } = {}): Promise<SecItem> {
  const { sdone = true, ...rest } = p;
  const iso = new Date(closedAt).toISOString();
  const it: SecItem = {
    id: newSecId(), kind: "task", title: "Water the plants", description: "", result: "ok", direction: "i_owe", owedBy: "owner", owedTo: null,
    dueAt: iso, allDay: false, snoozeUntil: null, priority: 1, critical: false, links: {}, source: "owner", notes: [], createdAt: iso, updatedAt: iso,
    completedAt: iso, proposedDone: null, deletedAt: null, expiresAt: null, expectBy: null, lastChasedAt: null, remindAt: null, rev: 2, series: { id: sid, n: 1 }, ...rest,
  };
  await Promise.all([
    db.set(SEC_KEYS.item(scope, it.id), it), db.sadd(SEC_KEYS.all(scope), it.id), db.zadd(SEC_KEYS.series(scope, sid), closedAt, it.id), db.sadd(SEC_KEYS.seriesList(scope), sid),
    ...(sdone ? [db.zadd(SEC_KEYS.sdone(scope), closedAt, it.id)] : []),
  ]);
  return it;
}
const exists = async (scope: string, ids: string[]) => (await db.mget<SecItem>(ids.map((id) => SEC_KEYS.item(scope, id)))).map((x) => !!x);
const scoreOf = async (key: string, id: string) => (await db.zrangeWithScores(key)).find((m) => m.member === id)?.score;
const warnings = async (email: string) => (await listNotifs(email)).filter((n) => n.kind === "todo" && n.href.includes("?series="));

describe("rule 502: the unkept copy is warned and then deleted", () => {
  it("250 kept copies older than 90 days plus 1 unkept: the unkept one is warned, then deleted 7 or more days later", async () => {
    const o = await login();
    const kept = newSeriesId(), plain = newSeriesId();
    await db.sadd(SEC_KEYS.seriesKeep(o.email), kept);
    const old = await Promise.all(Array.from({ length: 250 }, (_, i) => seedCopy(o.email, kept, T - (200 + i) * DAY, { sdone: false })));
    const one = await seedCopy(o.email, plain, T - 100 * DAY);
    expect(await secretaryDaily(o.email, T)).toMatchObject({ warned: 1, deleted: 0 });
    expect(await scoreOf(SEC_KEYS.spurge(o.email), one.id)).toBe(T + 7 * DAY);
    expect(await warnings(o.email)).toHaveLength(1);
    expect(await secretaryDaily(o.email, T + 7 * DAY - 1)).toMatchObject({ warned: 0, deleted: 0 });
    expect(await exists(o.email, [one.id])).toEqual([true]);
    expect(await secretaryDaily(o.email, T + 7 * DAY)).toMatchObject({ deleted: 1 });
    expect(await exists(o.email, [one.id])).toEqual([false]);
    expect((await exists(o.email, old.map((x) => x.id))).every(Boolean)).toBe(true);
    expect(await members(SEC_KEYS.series(o.email, kept))).toHaveLength(250);
    // The deleted copy left every index; its series has no closed copy left, so it leaves the list too.
    for (const k of [SEC_KEYS.sdone(o.email), SEC_KEYS.spurge(o.email), SEC_KEYS.series(o.email, plain)]) expect(await members(k)).not.toContain(one.id);
    expect((await db.smembers(SEC_KEYS.all(o.email))).includes(one.id)).toBe(false);
    expect(await db.smembers(SEC_KEYS.seriesList(o.email))).toEqual([kept]);
    const log = (await db.lrange(SEC_KEYS.audit(o.email), 0, -1)).map((x) => JSON.parse(x));
    expect(log.filter((l) => l.action === "series_purge")).toEqual([expect.objectContaining({ actor: "cron", via: "cron", id: "-", diff: expect.stringMatching(/^1 /) })]);
  });

  it("sdone seeded DIRECTLY with 250 kept and ghost ids ahead of one real candidate: the candidate is still warned, and the skipped ids are removed (fails if the skip guard is deleted)", async () => {
    const o = await login();
    const kept = newSeriesId(), sid = newSeriesId();
    await db.sadd(SEC_KEYS.seriesKeep(o.email), kept);
    // 150 copies of a kept series, 60 ids with no record, 40 open records: all closed earlier than the candidate.
    const keptIds = (await Promise.all(Array.from({ length: 150 }, (_, i) => seedCopy(o.email, kept, T - (300 - i) * DAY)))).map((x) => x.id);
    const missing = Array.from({ length: 60 }, () => newSecId());
    await Promise.all(missing.map((id, i) => db.zadd(SEC_KEYS.sdone(o.email), T - (150 - i) * DAY, id)));
    const open = await Promise.all(Array.from({ length: 40 }, (_, i) => seedCopy(o.email, sid, T - (130 - i) * DAY, { completedAt: null })));
    const candidate = await seedCopy(o.email, sid, T - 85 * DAY);
    // Day 1: the 200-row window is all skipped ids; each one is removed as it is skipped.
    expect(await warnSeries(o.email, T)).toBe(0);
    expect(await members(SEC_KEYS.sdone(o.email))).toHaveLength(51);
    // Day 2: the candidate is reached and warned.
    expect(await warnSeries(o.email, T + DAY)).toBe(1);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([]);
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([candidate.id]);
    // Skipped never means deleted: the kept copies and the open records are all there.
    expect((await exists(o.email, [...keptIds, ...open.map((x) => x.id)])).every(Boolean)).toBe(true);
    expect(await members(SEC_KEYS.series(o.email, kept))).toHaveLength(150);
  });

  it("the last copy of an ended series and a restored copy of a kept series do not enter sdone", async () => {
    const o = await login();
    const first = await add({ title: "Twice", dueAt: inDays(1, 9), repeat: { every: "day", count: 2 } });
    const sid = first.series!.id;
    expect(await setSeriesKeep(o.email, sid, true, OWNER)).toMatchObject({ ok: true });
    const a = await complete(first.id);
    const b = await complete(a.nextId!);
    expect(b.series).toEqual({ id: sid, n: 2 });
    expect(b.nextId).toBeUndefined();
    expect((await members(SEC_KEYS.series(o.email, sid))).sort()).toEqual([a.id, b.id].sort());
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([]);
    expect((await patch(b.id, { action: "delete" })).status).toBe(200);
    expect((await patch(b.id, { action: "restore" })).status).toBe(200);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([]);
    expect(await members(SEC_KEYS.series(o.email, sid))).toContain(b.id);
  });
});

describe("rule 503: no copy is deleted without a warning at least 7 days earlier", () => {
  it("after un-keep, after a missed run, and when the warning push threw", async () => {
    // Un-keep: copies warned, then kept, then un-kept are warned again (a new notification) before any deletion.
    const o = await login();
    const sid = newSeriesId();
    const copies = await Promise.all([0, 1, 2].map((i) => seedCopy(o.email, sid, T - (200 + i) * DAY)));
    const ids = copies.map((x) => x.id);
    expect(await warnSeries(o.email, T)).toBe(3);
    expect(await setSeriesKeep(o.email, sid, true, OWNER)).toMatchObject({ ok: true, kept: true });
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([]);
    expect(await purgeSeries(o.email, T + 10 * DAY)).toBe(0);
    expect(await setSeriesKeep(o.email, sid, false, OWNER)).toMatchObject({ ok: true, kept: false });
    expect((await members(SEC_KEYS.sdone(o.email))).sort()).toEqual([...ids].sort());
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([]);
    expect(await purgeSeries(o.email, T + 30 * DAY)).toBe(0);
    expect(await warnSeries(o.email, T + 30 * DAY)).toBe(3);
    expect(await warnings(o.email)).toHaveLength(2);
    for (const id of ids) expect(await scoreOf(SEC_KEYS.spurge(o.email), id)).toBe(T + 37 * DAY);
    expect(await purgeSeries(o.email, T + 37 * DAY - 1)).toBe(0);
    expect(await purgeSeries(o.email, T + 37 * DAY)).toBe(3);

    // A missed run: copies 300 days old that were never warned are not deleted; the first warning gives them 7 days,
    // and a purge that then misses runs deletes them late, never early.
    const m = await login();
    const msid = newSeriesId();
    const late = await seedCopy(m.email, msid, T - 300 * DAY);
    expect(await purgeSeries(m.email, T)).toBe(0);
    expect(await purgeSeries(m.email, T + 400 * DAY)).toBe(0);
    expect(await exists(m.email, [late.id])).toEqual([true]);
    expect(await warnSeries(m.email, T)).toBe(1);
    expect(await scoreOf(SEC_KEYS.spurge(m.email), late.id)).toBe(T + 7 * DAY);
    expect(await purgeSeries(m.email, T + 6 * DAY)).toBe(0);
    expect(await purgeSeries(m.email, T + 40 * DAY)).toBe(1);

    // The push threw: nothing moves and no marker is set; the fingerprint is handed back, so a retry the same day warns.
    const p = await login();
    const psid = newSeriesId();
    const c = await seedCopy(p.email, psid, T - 100 * DAY);
    const set = db.set.bind(db);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(db, "set").mockImplementation((k, v, ttl) => (k.startsWith("notifs:") ? Promise.reject(new TypeError("bell down")) : set(k, v, ttl)));
    expect(await warnSeries(p.email, T)).toBe(0);
    spy.mockRestore();
    expect(errors.mock.calls).toContainEqual(["sec series warning failed", "TypeError"]);
    expect(await members(SEC_KEYS.sdone(p.email))).toEqual([c.id]);
    expect(await members(SEC_KEYS.spurge(p.email))).toEqual([]);
    expect(await db.get(SEC_KEYS.swarn(p.email, psid))).toBeNull();
    expect(await purgeSeries(p.email, T + 100 * DAY)).toBe(0);
    expect(await warnSeries(p.email, T + 3600e3)).toBe(1);
    expect(await scoreOf(SEC_KEYS.spurge(p.email), c.id)).toBe(T + 3600e3 + 7 * DAY);
  });

  it("the daily step re-adds closed copies of unkept series missing from both sdone and spurge, and only those", async () => {
    const o = await login();
    const sid = newSeriesId(), kept = newSeriesId();
    const lost = await seedCopy(o.email, sid, T - 50 * DAY, { sdone: false });
    const warned = await seedCopy(o.email, sid, T - 95 * DAY, { sdone: false });
    await db.zadd(SEC_KEYS.spurge(o.email), T + DAY, warned.id);
    const waiting = await seedCopy(o.email, sid, T - 10 * DAY);
    await db.sadd(SEC_KEYS.seriesKeep(o.email), kept);
    const keptCopy = await seedCopy(o.email, kept, T - 50 * DAY, { sdone: false });
    // A ghost in the series set (its record was purged) is dropped from the set, not queued.
    const ghost = newSecId();
    await db.zadd(SEC_KEYS.series(o.email, sid), T - 60 * DAY, ghost);
    // A malformed member never reaches a key (no MGET of it) and is dropped from the set too.
    await db.zadd(SEC_KEYS.series(o.email, sid), T - 61 * DAY, "../x");
    const mget = vi.spyOn(db, "mget");
    expect(await requeueSeries(o.email)).toBe(1);
    expect(mget.mock.calls.flatMap((c) => c[0] as string[]).some((k) => k.includes("../x"))).toBe(false);
    expect(await members(SEC_KEYS.series(o.email, sid))).not.toContain("../x");
    expect(await scoreOf(SEC_KEYS.sdone(o.email), lost.id)).toBe(T - 50 * DAY);
    expect((await members(SEC_KEYS.sdone(o.email))).sort()).toEqual([lost.id, waiting.id].sort());
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([warned.id]);
    expect(await members(SEC_KEYS.series(o.email, sid))).not.toContain(ghost);
    expect(await members(SEC_KEYS.sdone(o.email))).not.toContain(keptCopy.id);
    expect(await requeueSeries(o.email)).toBe(0);
  });

  it("setSeriesKeep: keep takes the copies out of sdone and spurge, un-keep puts them back in sdone only, the 501st kept series is keep_limit 409; seriesRows reads one series newest first", async () => {
    const o = await login();
    const sid = newSeriesId();
    const a = await seedCopy(o.email, sid, T - 100 * DAY);
    const b = await seedCopy(o.email, sid, T - 99 * DAY, { sdone: false });
    await db.zadd(SEC_KEYS.spurge(o.email), T + DAY, b.id);
    expect(await setSeriesKeep(o.email, sid, true, OWNER)).toEqual({ ok: true, kept: true, moved: 2 });
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([]);
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([]);
    expect(await setSeriesKeep(o.email, sid, false, OWNER)).toEqual({ ok: true, kept: false, moved: 2 });
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([a.id, b.id]);
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([]);
    // Un-keeping a series that is not kept changes nothing.
    expect(await setSeriesKeep(o.email, sid, false, OWNER)).toEqual({ ok: true, kept: false, moved: 0 });
    const log = (await db.lrange(SEC_KEYS.audit(o.email), 0, -1)).map((x) => JSON.parse(x)).reverse();
    expect(log.map((l) => [l.action, l.id, l.login])).toEqual([["series_keep", sid, OWNER.login], ["series_unkeep", sid, OWNER.login], ["series_unkeep", sid, OWNER.login]]);
    expect(await setSeriesKeep(o.email, "not-a-series", true, OWNER)).toMatchObject({ ok: false, error: "not_found", status: 404 });
    // The limit: 500 kept series; one more is refused, one already kept is not.
    const many = Array.from({ length: SERIES_KEEP_MAX }, () => newSeriesId());
    await Promise.all(many.map((x) => db.sadd(SEC_KEYS.seriesKeep(o.email), x)));
    expect(await setSeriesKeep(o.email, sid, true, OWNER)).toMatchObject({ ok: false, error: "keep_limit", status: 409 });
    expect(await db.sismember(SEC_KEYS.seriesKeep(o.email), sid)).toBe(false);
    expect(await setSeriesKeep(o.email, many[0], true, OWNER)).toMatchObject({ ok: true });

    const other = await seedCopy(o.email, newSeriesId(), T - 5 * DAY);
    const r = await seriesRows(o.email, sid, 1);
    expect(r.total).toBe(2);
    expect(r.items.map((x) => x.id)).toEqual([b.id]);
    expect((await seriesRows(o.email, sid, 200)).items.map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await seriesRows(o.email, sid, 200)).items.map((x) => x.id)).not.toContain(other.id);
    expect(await seriesRows(o.email, "../x", 200)).toEqual({ items: [], total: 0 });
  });

  it("a copy restored after its series was warned moves silently no earlier than 7 days after the restore-time run", async () => {
    const o = await login();
    const sid = newSeriesId();
    const a = await seedCopy(o.email, sid, T - 200 * DAY);
    const b = await seedCopy(o.email, sid, T - 200 * DAY);
    expect(await warnSeries(o.email, T)).toBe(2);
    // B is deleted and restored (it leaves spurge and goes back into sdone at its old close), 10 days after the warning.
    expect((await patch(b.id, { action: "delete" })).status).toBe(200);
    expect((await patch(b.id, { action: "restore" })).status).toBe(200);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([b.id]);
    // The marker is live (10 days): silent, but max(close + 90 d, warned + 7 d) is long past, so now + 7 d wins.
    expect(await warnSeries(o.email, T + 10 * DAY)).toBe(1);
    expect(await warnings(o.email)).toHaveLength(1);
    expect(await scoreOf(SEC_KEYS.spurge(o.email), b.id)).toBe(T + 17 * DAY);
    expect(await purgeSeries(o.email, T + 11 * DAY)).toBe(1);
    expect(await exists(o.email, [a.id, b.id])).toEqual([false, true]);
    expect(await purgeSeries(o.email, T + 17 * DAY - 1)).toBe(0);
    expect(await purgeSeries(o.email, T + 17 * DAY)).toBe(1);
  });

  it("a warn run racing a keep leaves a stale spurge entry; un-keep within 7 days clears it, so a new warning comes before any deletion", async () => {
    const o = await login();
    const sid = newSeriesId();
    const c = await seedCopy(o.email, sid, T - 200 * DAY);
    const zadd = db.zadd.bind(db);
    let raced = false;
    // The owner keeps the series after the warn run read the keep set and pushed, before it writes the copy to spurge.
    vi.spyOn(db, "zadd").mockImplementation(async (k, score, m) => {
      if (k === SEC_KEYS.spurge(o.email) && !raced) {
        raced = true;
        expect(await setSeriesKeep(o.email, sid, true, OWNER)).toMatchObject({ ok: true, kept: true });
      }
      return zadd(k, score, m);
    });
    expect(await warnSeries(o.email, T)).toBe(1);
    vi.mocked(db.zadd).mockRestore();
    expect(raced).toBe(true);
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([c.id]);
    // Un-keep 3 days later: out of spurge, back in sdone, marker gone.
    expect(await setSeriesKeep(o.email, sid, false, OWNER)).toMatchObject({ ok: true, kept: false, moved: 1 });
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([]);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([c.id]);
    expect(await purgeSeries(o.email, T + 7 * DAY)).toBe(0);
    expect(await warnSeries(o.email, T + 3 * DAY)).toBe(1);
    expect(await warnings(o.email)).toHaveLength(2);
    expect(await scoreOf(SEC_KEYS.spurge(o.email), c.id)).toBe(T + 10 * DAY);
    expect(await purgeSeries(o.email, T + 10 * DAY - 1)).toBe(0);
    expect(await purgeSeries(o.email, T + 10 * DAY)).toBe(1);
  });
});

describe("rule 504: the purge is safe", () => {
  it("a reopen between the purge's read and its delete survives", async () => {
    const o = await login();
    const sid = newSeriesId();
    const a = await seedCopy(o.email, sid, T - 100 * DAY, { sdone: false });
    const b = await seedCopy(o.email, sid, T - 100 * DAY, { sdone: false });
    await Promise.all([a, b].map((x) => db.zadd(SEC_KEYS.spurge(o.email), T - DAY, x.id)));
    const read = db.zrangeByScore.bind(db);
    vi.spyOn(db, "zrangeByScore").mockImplementationOnce(async (k, max, limit) => {
      const r = await read(k, max, limit);
      // After the purge read its list and before it takes the item locks: A is reopened; B is reopened and closed again.
      expect((await patch(a.id, { action: "reopen" })).status).toBe(200);
      expect((await patch(b.id, { action: "reopen" })).status).toBe(200);
      expect((await patch(b.id, { action: "complete", result: "again" })).status).toBe(200);
      return r;
    });
    expect(await purgeSeries(o.email, T)).toBe(0);
    const [ra, rb] = await db.mget<SecItem>([SEC_KEYS.item(o.email, a.id), SEC_KEYS.item(o.email, b.id)]);
    expect(ra).toMatchObject({ completedAt: null, deletedAt: null });
    expect(rb).toMatchObject({ result: "again", deletedAt: null });
    // B closed again: back in the warn window, not in the purge one.
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([b.id]);
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([]);
  });

  it("under the lock the purge reads the copy again: a later spurge score or a record no longer closed is not deleted, even with a stale index", async () => {
    const o = await login();
    const sid = newSeriesId();
    const later = await seedCopy(o.email, sid, T - 100 * DAY, { sdone: false });
    const open = await seedCopy(o.email, sid, T - 100 * DAY, { sdone: false });
    await Promise.all([later, open].map((x) => db.zadd(SEC_KEYS.spurge(o.email), T - DAY, x.id)));
    // The record says open (a write whose index update was lost): the windows still list it.
    await db.set(SEC_KEYS.item(o.email, open.id), { ...open, completedAt: null });
    const read = db.zrangeByScore.bind(db);
    vi.spyOn(db, "zrangeByScore").mockImplementationOnce(async (k, max, limit) => {
      const r = await read(k, max, limit);
      // Between the read and the lock: a new warning moved this copy later.
      await db.zadd(SEC_KEYS.spurge(o.email), T + 5 * DAY, later.id);
      return r;
    });
    expect(await purgeSeries(o.email, T)).toBe(0);
    expect(await exists(o.email, [later.id, open.id])).toEqual([true, true]);
    expect(await scoreOf(SEC_KEYS.spurge(o.email), later.id)).toBe(T + 5 * DAY);
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([later.id]);
  });

  it("secretaryDaily itself runs no series step for an archived brand or a suspended account", async () => {
    const a = await newUser("seridle");
    const at = new Date(T).toISOString();
    await saveBrands(a.email, [{ id: "default", name: "", createdAt: at, status: "active" }, { id: "old", name: "Old", createdAt: at, status: "archived" }]);
    const s = await newUser("seridles");
    await saveUser({ ...(await getUser(s.email))!, suspended: true });
    for (const scope of [scopeFor(a.email, "old"), scopeFor(a.email, "gone"), s.email]) {
      const sid = newSeriesId();
      const w = await seedCopy(scope, sid, T - 100 * DAY);
      const d = await seedCopy(scope, sid, T - 100 * DAY, { sdone: false });
      await db.zadd(SEC_KEYS.spurge(scope), T - DAY, d.id);
      expect(await secretaryDaily(scope, T), scope).toMatchObject({ warned: 0, deleted: 0 });
      expect(await exists(scope, [w.id, d.id]), scope).toEqual([true, true]);
      expect(await members(SEC_KEYS.sdone(scope)), scope).toEqual([w.id]);
    }
    expect(await warnings(a.email)).toEqual([]);
    expect(await warnings(s.email)).toEqual([]);
  });

  it("a copy whose series was kept after its warning, or that was restored after a delete, is not deleted", async () => {
    const o = await login();
    const sid = newSeriesId(), kept = newSeriesId();
    const a = await seedCopy(o.email, kept, T - 100 * DAY, { sdone: false });
    await db.zadd(SEC_KEYS.spurge(o.email), T - DAY, a.id);
    await db.sadd(SEC_KEYS.seriesKeep(o.email), kept);
    // B was warned, then deleted and restored: the restore put it back in sdone (not warned since).
    const b = await seedCopy(o.email, sid, T - 100 * DAY, { sdone: false });
    await db.zadd(SEC_KEYS.spurge(o.email), T - DAY, b.id);
    expect((await patch(b.id, { action: "delete" })).status).toBe(200);
    expect((await patch(b.id, { action: "restore" })).status).toBe(200);
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([a.id]);
    expect(await purgeSeries(o.email, T)).toBe(0);
    expect(await exists(o.email, [a.id, b.id])).toEqual([true, true]);
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([]);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([b.id]);
  });

  it("one copy's read throwing mid-run skips only that copy: the others are deleted, counted and audited, and it is retried the next day", async () => {
    const o = await login();
    const sid = newSeriesId();
    const copies = await Promise.all([0, 1, 2, 3].map(() => seedCopy(o.email, sid, T - 100 * DAY, { sdone: false })));
    await Promise.all(copies.map((x) => db.zadd(SEC_KEYS.spurge(o.email), T - DAY, x.id)));
    const bad = copies[2];
    const get = db.get.bind(db);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(db, "get").mockImplementation(((k: string) => (k === SEC_KEYS.item(o.email, bad.id) ? Promise.reject(new TypeError("redis down")) : get(k))) as typeof db.get);
    expect(await purgeSeries(o.email, T)).toBe(3);
    spy.mockRestore();
    expect(errors.mock.calls).toContainEqual(["sec series purge item failed", "TypeError"]);
    expect(await exists(o.email, copies.map((x) => x.id))).toEqual([false, false, true, false]);
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([bad.id]);
    // The series still has a closed copy: it stays listed.
    expect(await db.smembers(SEC_KEYS.seriesList(o.email))).toEqual([sid]);
    const audits = async () => (await db.lrange(SEC_KEYS.audit(o.email), 0, -1)).map((x) => JSON.parse(x)).filter((l) => l.action === "series_purge");
    expect(await audits()).toEqual([expect.objectContaining({ diff: expect.stringMatching(/^3 /) })]);
    // The next day it is deleted, with its own line.
    expect(await purgeSeries(o.email, T + DAY)).toBe(1);
    expect(await exists(o.email, [bad.id])).toEqual([false]);
    expect((await audits()).map((l) => l.diff.split(" ")[0]).sort()).toEqual(["1", "3"]);
    expect(await db.smembers(SEC_KEYS.seriesList(o.email))).toEqual([]);
  });

  it("a soft-deleted copy (deletedAt set, closed long ago) with a stale spurge entry is not purged", async () => {
    const o = await login();
    const sid = newSeriesId();
    const d = await seedCopy(o.email, sid, T - 200 * DAY, { sdone: false, deletedAt: new Date(T - 2 * DAY).toISOString() });
    await db.zadd(SEC_KEYS.spurge(o.email), T - DAY, d.id);
    expect(await purgeSeries(o.email, T)).toBe(0);
    expect(await db.get(SEC_KEYS.item(o.email, d.id))).toMatchObject({ id: d.id, deletedAt: expect.any(String) });
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([]);
  });

  it("normal items are never purged", async () => {
    const o = await login();
    const plain = await complete((await add({ title: "Plain", dueAt: inDays(1) })).id);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([]);
    // Even put in both windows by hand (as a bad write could), a copy with no series is never warned about or deleted.
    await db.zadd(SEC_KEYS.sdone(o.email), T - 200 * DAY, plain.id);
    await db.zadd(SEC_KEYS.spurge(o.email), T - DAY, plain.id);
    expect(await warnSeries(o.email, T)).toBe(0);
    expect(await purgeSeries(o.email, T)).toBe(0);
    expect(await db.get(SEC_KEYS.item(o.email, plain.id))).toMatchObject({ id: plain.id, result: "ok" });
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([]);
    expect(await members(SEC_KEYS.spurge(o.email))).toEqual([]);
    expect(await warnings(o.email)).toEqual([]);
  });

  it("idle brands are not warned or purged (through the cron route)", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-series");
    const now = Date.now();
    const active = await newUser("seract");
    const archived = await newUser("serarch");
    const archScope = scopeFor(archived.email, "old");
    const at = new Date(now).toISOString();
    await saveBrands(archived.email, [{ id: "default", name: "", createdAt: at, status: "active" }, { id: "old", name: "Old", createdAt: at, status: "archived" }]);
    const susp = await newUser("sersusp");
    await saveUser({ ...(await getUser(susp.email))!, suspended: true });
    const seeded = await Promise.all([active.email, archScope, susp.email].map(async (scope) => {
      const sid = newSeriesId();
      const toWarn = await seedCopy(scope, sid, now - 100 * DAY);
      const toDelete = await seedCopy(scope, sid, now - 100 * DAY, { sdone: false });
      await db.zadd(SEC_KEYS.spurge(scope), now - DAY, toDelete.id);
      return { scope, toWarn, toDelete };
    }));
    const res = await cronDaily.GET(new Request("https://nashr.test/api/cron/daily", { headers: { authorization: "Bearer cron-secret-series" } }));
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.results[active.email]).toContain("todo:0p0c0a1w1d");
    expect(report.results[`idle:${archScope}`]).toBe("idle");
    expect(report.results[`idle:${susp.email}`]).toBe("idle");
    const [act, ...idle] = seeded;
    expect(await exists(act.scope, [act.toWarn.id, act.toDelete.id])).toEqual([true, false]);
    expect(await members(SEC_KEYS.spurge(act.scope))).toEqual([act.toWarn.id]);
    for (const x of idle) {
      expect(await exists(x.scope, [x.toWarn.id, x.toDelete.id])).toEqual([true, true]);
      expect(await members(SEC_KEYS.sdone(x.scope))).toEqual([x.toWarn.id]);
      expect(await members(SEC_KEYS.spurge(x.scope))).toEqual([x.toDelete.id]);
    }
    expect(await warnings(archived.email)).toEqual([]);
    expect(await warnings(susp.email)).toEqual([]);
    expect(await warnings(active.email)).toHaveLength(1);
  });
});

describe("rule 505: the warning", () => {
  it("names at most 5 series then 'and k more', and moves only the named ids", async () => {
    const o = await login();
    const sids = Array.from({ length: 7 }, () => newSeriesId());
    const copies = await Promise.all(sids.map((sid, i) => seedCopy(o.email, sid, T - (100 - i) * DAY, { title: `Series ${i}` })));
    expect(await warnSeries(o.email, T)).toBe(5);
    const [w] = await warnings(o.email);
    expect(w).toMatchObject({ kind: "todo", agent: "reem", href: `/ar/app/todo?series=${sids[0]}` });
    for (let i = 0; i < 5; i++) expect(w.body).toContain(`«Series ${i}»`);
    expect(w.body).not.toContain("Series 5");
    expect(w.body).not.toContain("Series 6");
    expect(w.body).toContain("ومهمتان متكررتان أخريان");
    expect((await members(SEC_KEYS.spurge(o.email))).sort()).toEqual(copies.slice(0, 5).map((x) => x.id).sort());
    expect((await members(SEC_KEYS.sdone(o.email))).sort()).toEqual(copies.slice(5).map((x) => x.id).sort());
    const markers = await db.mget(sids.map((sid) => SEC_KEYS.swarn(o.email, sid)));
    expect(markers.map((x) => x !== null)).toEqual([true, true, true, true, true, false, false]);
    // The next day names the other two.
    expect(await warnSeries(o.email, T + DAY)).toBe(2);
    expect(await warnings(o.email)).toHaveLength(2);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([]);
  });

  it("a same-day rerun moves nothing; the fingerprint is the per-brand one", async () => {
    const o = await login();
    await seedCopy(o.email, newSeriesId(), T - 100 * DAY);
    expect(await warnSeries(o.email, T)).toBe(1);
    const later = await seedCopy(o.email, newSeriesId(), T - 100 * DAY);
    expect(await warnSeries(o.email, T + 2 * 3600e3)).toBe(0);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([later.id]);
    expect(await warnings(o.email)).toHaveLength(1);
    const fp = seenKey(o.email, `todo-purge:${zoneDay(T, z)}`);
    expect(await db.get(fp)).not.toBeNull();
    const ttl = await db.ttl(fp);
    expect(ttl).toBeGreaterThan(7 * 86400 - 60);
    expect(ttl).toBeLessThanOrEqual(7 * 86400);
    // Another brand of the same account has its own fingerprint, so its warning goes out the same day.
    const b2 = scopeFor(o.email, "b2");
    await seedCopy(b2, newSeriesId(), T - 100 * DAY);
    expect(await warnSeries(b2, T + 2 * 3600e3)).toBe(1);
    expect(await db.get(seenKey(o.email, `todo-purge:${zoneDay(T, z)}#b2`))).not.toBeNull();
    expect(await warnings(o.email)).toHaveLength(2);
    // The next local day names the series that waited.
    expect(await warnSeries(o.email, T + DAY)).toBe(1);
    expect(await members(SEC_KEYS.sdone(o.email))).toEqual([]);
  });

  it("a daily series run for 120 simulated days produces four warning notifications (one per 30-day marker, never one per day), and every copy is deleted at least 7 days after a warning that named its series (R44)", async () => {
    const o = await login();
    const sid = newSeriesId();
    const closedAt = new Map<string, number>(), deletedAt = new Map<string, number>();
    const warned: number[] = [];
    for (let d = 0; d < 240; d++) {
      const now = T + d * DAY;
      if (d < 120) closedAt.set((await seedCopy(o.email, sid, now)).id, now);
      const before = (await warnings(o.email)).length;
      await warnSeries(o.email, now);
      if ((await warnings(o.email)).length > before) warned.push(now);
      await purgeSeries(o.email, now);
      const ids = [...closedAt.keys()].filter((id) => !deletedAt.has(id));
      const live = await exists(o.email, ids);
      ids.forEach((id, i) => { if (!live[i]) deletedAt.set(id, now); });
    }
    expect(deletedAt.size).toBe(120);
    for (const [id, del] of deletedAt) {
      expect(del).toBeGreaterThanOrEqual(closedAt.get(id)! + 90 * DAY);
      expect(warned.some((w) => w <= del - 7 * DAY)).toBe(true);
    }
    // One warning per 30-day marker: the first in its first 30 days, about monthly after, never one per day.
    expect(warned[0]).toBe(T + 83 * DAY);
    expect(warned.filter((w) => w < warned[0] + 30 * DAY)).toHaveLength(1);
    expect(warned).toEqual([83, 113, 143, 173].map((d) => T + d * DAY));
  });

  it("when the 30-day marker lapses the series is named again", async () => {
    const o = await login();
    const sid = newSeriesId();
    await seedCopy(o.email, sid, T - 84 * DAY);
    expect(await warnSeries(o.email, T)).toBe(1);
    expect(await db.get(SEC_KEYS.swarn(o.email, sid))).toBe(T);
    // 29 days later the marker holds: a copy reaching the window moves silently, at least 7 days after the warning and
    // 7 days after this run (max(closed + 90 d, warned + 7 d, now + 7 d)).
    const quiet = await seedCopy(o.email, sid, T + 29 * DAY - 84 * DAY);
    expect(await warnSeries(o.email, T + 29 * DAY)).toBe(1);
    expect(await warnings(o.email)).toHaveLength(1);
    expect(await scoreOf(SEC_KEYS.spurge(o.email), quiet.id)).toBe(Math.max(T + 29 * DAY - 84 * DAY + 90 * DAY, T + 7 * DAY, T + 36 * DAY));
    expect(await scoreOf(SEC_KEYS.spurge(o.email), quiet.id)).toBe(T + 36 * DAY);
    // 30 days after the warning it has lapsed: named again.
    const named = await seedCopy(o.email, sid, T + 30 * DAY - 84 * DAY);
    expect(await warnSeries(o.email, T + 30 * DAY)).toBe(1);
    expect(await warnings(o.email)).toHaveLength(2);
    expect(await scoreOf(SEC_KEYS.spurge(o.email), named.id)).toBe(T + 37 * DAY);
    expect(await db.get(SEC_KEYS.swarn(o.email, sid))).toBe(T + 30 * DAY);
  });

  it("text uses arCount and Latin digits", async () => {
    sent.length = 0;
    const o = await login();
    const counts = [1, 2, 3, 11];
    const sids = counts.map(() => newSeriesId());
    await Promise.all(sids.flatMap((sid, i) => Array.from({ length: counts[i] }, (_, k) => seedCopy(o.email, sid, T - (100 - i) * DAY - k * 3600e3, { title: `T${i}` }))));
    expect(await warnSeries(o.email, T)).toBe(17);
    const [w] = await warnings(o.email);
    const date = formatWhen(new Date(T + 7 * DAY).toISOString(), true, "ar", T, z);
    expect(w.body).toBe([
      `فيه نسخة واحدة من «T0» بتنحذف ابتداءً من ${date}.`,
      `فيه نسختين من «T1» بتنحذف ابتداءً من ${date}.`,
      `فيه 3 نسخ من «T2» بتنحذف ابتداءً من ${date}.`,
      `فيه 11 نسخة من «T3» بتنحذف ابتداءً من ${date}.`,
      "تقدر تحتفظ بالسجل أو تنزّله CSV",
    ].join("\n"));
    expect(w.body + w.title).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/);
    expect(date).toMatch(/\d/);
    // The preference is "all" by default: one email, with the link.
    expect(sent.filter((m) => m.to === o.email)).toEqual([expect.objectContaining({ subject: w.title, text: expect.stringContaining(`/ar/app/todo?series=${sids[0]}`) })]);

    // English, and the preference "none": the notification, and no email.
    const e = await login();
    await saveUser({ ...(await getUser(e.email))!, lang: "en" });
    await db.set(`profile:${e.email}`, { emails: "none" });
    const esid = newSeriesId();
    await Promise.all([0, 1].map((k) => seedCopy(e.email, esid, T - 100 * DAY - k * 3600e3, { title: "Rent" })));
    const one = newSeriesId();
    await seedCopy(e.email, one, T - 99 * DAY, { title: "Fees" });
    expect(await warnSeries(e.email, T)).toBe(3);
    const [we] = await warnings(e.email);
    const en = formatWhen(new Date(T + 7 * DAY).toISOString(), true, "en", T, z);
    expect(we.href).toBe(`/en/app/todo?series=${esid}`);
    expect(we.body).toBe([`2 closed copies of "Rent" will be deleted from ${en}.`, `1 closed copy of "Fees" will be deleted from ${en}.`, "Keep the history or download it as CSV"].join("\n"));
    expect(sent.filter((m) => m.to === e.email)).toEqual([]);
  });
});

const keepCall = (seriesId: string, body: unknown) => keepRoute.PUT(json(`/api/secretary/series/${seriesId}/keep`, "PUT", body), params({ seriesId }));
const exportCall = (seriesId: string, q = "") => exportRoute.GET(json(`/api/secretary/series/${seriesId}/export${q}`, "GET"), params({ seriesId }));
const auditLines = async (scope: string) => (await db.lrange(SEC_KEYS.audit(scope), 0, -1)).map((x) => JSON.parse(x)).filter((l) => String(l.action).startsWith("series_"));

describe("rule 506: the keep route", () => {
  it("a member's keep:false gets 403 and writes nothing; keep:true is allowed and audited once", async () => {
    const o = await login();
    const a = await complete((await recurring("Kept")).id);
    const sid = a.series!.id;
    const m = await newMember(o, "member");
    await signIn(m.email);
    const r = await keepCall(sid, { keep: false });
    expect(r.status).toBe(403);
    expect(await auditLines(o.email)).toEqual([]);
    const k = await keepCall(sid, { keep: true });
    expect(k.status).toBe(200);
    expect(await k.json()).toMatchObject({ ok: true, kept: true });
    expect((await auditLines(o.email)).filter((l) => l.action === "series_keep")).toHaveLength(1);
    expect(await db.sismember(SEC_KEYS.seriesKeep(o.email), sid)).toBe(true);
    await signIn(o.email);
    const u = await keepCall(sid, { keep: false });
    expect(u.status).toBe(200);
    expect(await u.json()).toMatchObject({ ok: true, kept: false });
    expect((await auditLines(o.email)).filter((l) => l.action === "series_unkeep")).toHaveLength(1);
  });
  it("a malformed or unknown id gets 404 and writes nothing; another brand's well-formed id gets 404; a bad body is 400", async () => {
    const o = await login();
    const a = await complete((await recurring("Mine")).id);
    for (const bad of ["x", "R0123456789abcdef", newSeriesId()]) {
      expect((await keepCall(bad, { keep: true })).status).toBe(404);
      expect(await db.sismember(SEC_KEYS.seriesKeep(o.email), bad)).toBe(false);
    }
    expect((await keepCall(a.series!.id, { keep: "yes" })).status).toBe(400);
    expect((await keepCall(a.series!.id, {})).status).toBe(400);
    expect(await auditLines(o.email)).toEqual([]);
    const other = await login();
    expect((await keepCall(a.series!.id, { keep: true })).status).toBe(404);
    expect(await db.sismember(SEC_KEYS.seriesKeep(other.email), a.series!.id)).toBe(false);
    expect(await db.sismember(SEC_KEYS.seriesKeep(o.email), a.series!.id)).toBe(false);
    expect(await auditLines(other.email)).toEqual([]);
  });
  it("is rate limited per login before the existence check", async () => {
    await login();
    const z = vi.spyOn(db, "zcard");
    const rate = await import("@/lib/rate");
    vi.spyOn(rate, "allow").mockResolvedValue(false);
    const r = await keepCall(newSeriesId(), { keep: true });
    expect(r.status).toBe(429);
    expect(z).not.toHaveBeenCalled();
  });
  it("a 501st kept series answers keep_limit 409", async () => {
    const o = await login();
    const a = await complete((await recurring("Extra")).id);
    await Promise.all(Array.from({ length: SERIES_KEEP_MAX }, () => db.sadd(SEC_KEYS.seriesKeep(o.email), newSeriesId())));
    const r = await keepCall(a.series!.id, { keep: true });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("keep_limit");
    expect(await db.sismember(SEC_KEYS.seriesKeep(o.email), a.series!.id)).toBe(false);
  });
});

describe("rule 507: the CSV export", () => {
  it("a result with a comma, a quote, a new line and a leading = is exported safely, with a BOM, the id as file name and the skip as text", async () => {
    const o = await login();
    const first = await add({ title: "=HYPERLINK(1)", dueAt: inDays(1, 9), repeat: { every: "day" } });
    const sid = (await complete(first.id)).series!.id;
    const second = await add({ title: "Plain", dueAt: inDays(1, 9), repeat: { every: "day" } });
    const sid2 = (await (await patch(second.id, { action: "skip" })).json()).item.series.id as string;
    const withText = await add({ title: "Weekly", dueAt: inDays(1, 9), repeat: { every: "day" } });
    const sid3 = (await (await patch(withText.id, { action: "complete", result: '=cmd, "quoted"\nline two' })).json()).item.series.id as string;
    const r3 = await exportCall(sid3);
    expect(r3.status).toBe(200);
    expect(r3.headers.get("content-disposition")).toBe(`attachment; filename="series-${sid3}.csv"`);
    expect(r3.headers.get("content-type")).toContain("text/csv");
    const bytes = new Uint8Array(await r3.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // Response.text() would strip the BOM
    const t3 = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(t3).toContain(`"'=cmd, ""quoted""\nline two"`);
    expect(t3.split("\r\n")[0]).toBe('\uFEFF"title","due","closed at","result","closed by"');
    const t2 = await (await exportCall(sid2)).text();
    expect(t2).toContain("تخطيت هالمرة");
    expect(t2).not.toContain(`"skipped"`);
    expect(await (await exportCall(sid2, "?lang=en")).text()).toContain("Skipped this time");
    expect(t3).toContain(`"${o.email}"`);
    expect(await (await exportCall(sid)).text()).toContain(`"'=HYPERLINK(1)"`);
  });
  it("due and closed at are written in the brand's zone, an all-day copy as its local day, and an auto-closed copy as text", async () => {
    await login();
    const first = await add({ title: "Daily", dueAt: inDays(1, 0), repeat: { every: "day" } });
    const sid = (await complete(first.id)).series!.id;
    const csv = await (await exportCall(sid)).text();
    const row = csv.split("\r\n")[1];
    expect(row).not.toMatch(/T\d\d:\d\d:\d\d\.\d{3}Z/);
    expect(row).toMatch(/"\d{4}-\d\d-\d\d( \d\d:\d\d)?","\d{4}-\d\d-\d\d \d\d:\d\d"/);
  });
  it("only that series' set is read, and another brand's or an unknown id gives 404", async () => {
    const o = await login();
    const a = await complete((await recurring("A")).id);
    const b = await complete((await recurring("B")).id);
    const ranges = vi.spyOn(db, "zrangeWithScores");
    const r = await exportCall(a.series!.id);
    expect(r.status).toBe(200);
    expect(ranges.mock.calls.map((c) => c[0])).toEqual([SEC_KEYS.series(o.email, a.series!.id)]);
    const csv = await r.text();
    expect(csv).toContain("A");
    expect(csv).not.toContain(`"${b.title}"`);
    const reads = vi.spyOn(db, "mget");
    reads.mockClear();
    expect((await exportCall("nope")).status).toBe(404);
    expect((await exportCall(newSeriesId())).status).toBe(404);
    expect(reads).not.toHaveBeenCalled();
    await login();
    expect((await exportCall(a.series!.id)).status).toBe(404);
  });
  it("is rate limited per login before the existence check", async () => {
    await login();
    const z = vi.spyOn(db, "zcard");
    const rate = await import("@/lib/rate");
    vi.spyOn(rate, "allow").mockResolvedValue(false);
    expect((await exportCall(newSeriesId())).status).toBe(429);
    expect(z).not.toHaveBeenCalled();
  });
});

describe("rule 509: the repeat controls and the series view on the to-do page", () => {
  const render = async (lang: "ar" | "en", series?: string | string[]) => new Response(await renderToReadableStream(await Page({ params: Promise.resolve({ lang }), ...(series === undefined ? {} : { searchParams: Promise.resolve({ series }) }) }))).text();
  const ARABIC_INDIC = /[٠-٩۰-۹]/;
  const switchesOf = (html: string) => [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
  const timesOf = (html: string) => [...html.matchAll(/<input[^>]*type="time"[^>]*>/g)].map((m) => m[0]);
  const rowOf = (over: Partial<TodoRow> = {}): TodoRow => ({
    id: "s0123456789abcdef", rev: 1, title: "Water the plants", description: "", due: "Tomorrow", dueLocal: null, who: "", next: "", badges: [], theirs: false, chase: "", proposed: null, fact: "", result: null, notes: [],
    remind: null, remindLocal: null, phone: null, whatsapp: null, repeat: "Repeats every day", repeatRule: { every: "day", interval: 1, weekdays: [], monthDay: null, until: "", count: null, remindBefore: null }, seriesId: "r0123456789abcdef", closedBy: null, ...over,
  });
  const panelHtml = async (canClose: boolean, canWrite: boolean, row: TodoRow = rowOf()) => new Response(await renderToReadableStream(createElement(TodoPanel, {
    t: appDict.en, zoneLabel: "Riyadh", sections: [{ bucket: "today", title: "Today", rows: [row] }], approvals: null, snoozed: 0, allClear: false, empty: false, done: [], deleted: [], tonight: false,
    canClose, canWrite, todoHref: "/en/app/todo", timed: true, briefAt: "08:00", lang: "en", inboxHref: "/en/app", away: { entries: [], labels: [], canEdit: false, today: "2026-10-03", last: "2027-01-01" },
  }))).text();

  it("Skip is for todo.close and Stop repeat for todo.write: a member sees no >Skip<, an admin does; read-only sees neither", async () => {
    const o = await login();
    await recurring("Water");
    const admin = await newMember(o, "admin", "s509a");
    const member = await newMember(o, "member", "s509m");
    await signIn(admin.email);
    const forAdmin = await render("en");
    expect(forAdmin).toContain(">Skip<");
    expect(forAdmin).toContain(">Stop repeat<");
    await signIn(member.email);
    const forMember = await render("en");
    expect(forMember).not.toContain(">Skip<");
    expect(forMember).toContain(">Stop repeat<");
    expect((await render("ar"))).not.toContain(`>${appDict.ar.todo.repeat.skip}<`);
    // No login can lack todo.write today, so the gate is pinned on the component.
    const readOnly = await panelHtml(false, false);
    expect(readOnly).not.toContain(">Skip<");
    expect(readOnly).not.toContain(">Stop repeat<");
    expect(readOnly).not.toContain(">Repeat<");
    const full = await panelHtml(true, true);
    expect(full).toContain(">Skip<");
    expect(full).toContain(">Stop repeat<");
    expect(full).toContain(">Repeat<");
    // A copy that does not repeat has neither Skip nor Stop repeat.
    expect(await panelHtml(true, true, rowOf({ repeat: null, repeatRule: null, seriesId: null }))).not.toContain(">Skip<");
  });

  it("a recurring row shows its rule as a badge, Latin digits in ar and en, the Hijri rules with their anchor", async () => {
    await login();
    await add({ title: "Staff meeting", dueAt: inDays(2, 9), repeat: { every: "week", interval: 2, weekdays: [0, 2] } });
    await add({ title: "Rent", dueAt: inDays(3, 9), repeat: { every: "hmonth", monthDay: 15 } });
    await add({ title: "Zakat", dueAt: inDays(4, 9), repeat: { every: "hyear" } });
    for (const lang of ["ar", "en"] as const) {
      const html = await render(lang);
      expect(html).not.toMatch(ARABIC_INDIC);
      const text = html.replace(/<[^>]*>/g, "\n");
      expect(text).toMatch(lang === "en" ? /Repeats every 2 weeks on Sunday and Tuesday/ : /يتكرر كل أسبوعين/);
      expect(text).toMatch(lang === "en" ? /Repeats every Hijri month on day 15/ : /يتكرر كل شهر هجري، يوم 15/);
      // The Hijri-year rule names the month and day of its anchor, never a bare "every Hijri year".
      expect(text).toMatch(lang === "en" ? /Repeats every Hijri year on \d+ [A-Z]/ : /يتكرر كل سنة هجرية، في \d+ /);
    }
  });

  it("the series view shows only that series' rows, reads only that series' set, and says a skip in words", async () => {
    const o = await login();
    const a = await complete((await recurring("Series A")).id);
    const skipped = (await (await patch((await add({ title: "Series B", dueAt: inDays(1, 9), repeat: { every: "day" } })).id, { action: "skip" })).json()).item as SecItem;
    const sidA = a.series!.id, sidB = skipped.series!.id;
    const ranges = vi.spyOn(db, "zrangeWithScores");
    const hash = vi.spyOn(db, "hgetall");
    const lists = vi.spyOn(db, "lrange");
    const html = await render("en", sidA);
    expect(html).toContain("Series A");
    expect(html).not.toContain("Series B");
    expect(ranges.mock.calls.map((c) => c[0])).toEqual([SEC_KEYS.series(o.email, sidA)]);
    expect(hash).not.toHaveBeenCalled();
    expect(lists).not.toHaveBeenCalled();
    expect(html).toContain("Download CSV");
    expect(html).toContain(`/api/secretary/series/${sidA}/export?lang=en`);
    expect(html).toContain("Back to My to-dos");
    // A skipped copy reads as words through resultText, never the stored marker.
    const b = await render("en", sidB);
    expect(b).toContain("Skipped this time");
    expect(b).not.toContain("__skipped");
    expect(await render("ar", sidB)).toContain(appDict.ar.todo.skipped);
    expect(await render("ar", sidA)).not.toMatch(ARABIC_INDIC);
  });

  it("an unknown id, another brand's id and a malformed id: not found without reading anything else; malformed counts as absent", async () => {
    await login();
    const a = await complete((await recurring("Mine")).id);
    const other = await login();
    expect(other.email).toBeTruthy();
    const gets = vi.spyOn(db, "get");
    const mgets = vi.spyOn(db, "mget");
    const smembers = vi.spyOn(db, "sismember");
    for (const id of [newSeriesId(), a.series!.id]) {
      const html = await render("en", id);
      expect(html).toContain(appDict.en.todo.series.notFound);
      expect(html).not.toContain("Mine");
      expect(html).not.toContain("Download CSV");
    }
    // Only the login's own session reads (user, member, active brand, session): no brand file, no calendar, no item.
    expect(gets.mock.calls.map((c) => String(c[0])).filter((k) => !/^(user|member|activebrand|session):/.test(k))).toEqual([]);
    expect(mgets).not.toHaveBeenCalled();
    expect(smembers).not.toHaveBeenCalled();
    gets.mockRestore();
    for (const bad of ["nope", ["a", "b"], ""]) {
      const html = await render("en", bad as string);
      expect(html).toContain(appDict.en.todo.title);
      expect(html).not.toContain(appDict.en.todo.series.notFound);
    }
  });

  it("the Keep history switch is only in the series view; off needs todo.close", async () => {
    const o = await login();
    const a = await complete((await recurring("Kept")).id);
    const sid = a.series!.id;
    expect(switchesOf(await render("en")).length).toBeGreaterThan(3); // Working days' own
    const base = switchesOf(await render("en")).length;
    const admin = await newMember(o, "admin", "s509ka");
    const member = await newMember(o, "member", "s509km");
    await signIn(member.email);
    const first = switchesOf(await render("en", sid));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('aria-checked="false"');
    expect(first[0]).not.toContain('disabled=""');
    expect(base).toBeGreaterThan(1);
    expect((await setSeriesKeep(o.email, sid, true, { actor: "owner", via: "web" })).ok).toBe(true);
    const kept = switchesOf(await render("en", sid));
    expect(kept[0]).toContain('aria-checked="true"');
    expect(kept[0]).toContain('disabled=""');
    expect(await render("en", sid)).toContain(appDict.en.todo.series.keepOffOwner);
    await signIn(admin.email);
    const forAdmin = switchesOf(await render("en", sid));
    expect(forAdmin[0]).toContain('aria-checked="true"');
    expect(forAdmin[0]).not.toContain('disabled=""');
  });

  it("the add form has repeat selects and checkboxes but no extra type=time and no new switch; rule 487's counts hold", async () => {
    await login();
    const before = await render("en");
    await recurring("Weekly");
    const after = await render("en");
    expect(timesOf(after)).toHaveLength(2);
    expect(timesOf(before)).toHaveLength(2);
    expect(switchesOf(after)).toHaveLength(switchesOf(before).length);
    expect(after).toContain(appDict.en.todo.repeat.none);
    expect(after).toContain(appDict.en.todo.repeat.units.hyear);
    expect(after).toContain(">Does not repeat<");
  });
});
