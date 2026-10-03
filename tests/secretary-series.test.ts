import { describe, expect, it } from "vitest";
import { json, newUser, params, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { wipeAccount } from "@/lib/account";
import * as listRoute from "@/app/api/secretary/route";
import * as itemRoute from "@/app/api/secretary/[id]/route";
import { SEC_KEYS, purgeExpired, secretaryKeys } from "@/lib/secretary";
import { zoneDay, type SecItem } from "@/lib/secretary-agenda";

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
    expect(await purgeExpired(o.email, Date.now() + 31 * 864e5)).toBe(1);
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
    expect(await db.setNx(SEC_KEYS.spawn(u.email, a.id), "s0123456789abcdef", 2 * 864e5)).toBe(true);
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
