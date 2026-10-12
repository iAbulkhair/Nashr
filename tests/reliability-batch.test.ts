import { afterEach, describe, expect, it, vi } from "vitest";
import { db, mgetChunked } from "@/lib/db";
import { listTasks, rebuildIndex, saveTask, type Task } from "@/lib/brand";
import { createConversation, listConversations, searchConversations } from "@/lib/conversations";
import { push } from "@/lib/chat";
import { track, userEvents } from "@/lib/track";
import { runDaily, saveSchedule } from "@/lib/schedule";
import { SEC_KEYS, timedReminders } from "@/lib/secretary";
import { sweepReminders } from "@/lib/secretary-remind";
import { newUser } from "./helpers/session";

/**
 * Rules 1430-1434 (docs/system/tests/1430-reliability-batch.md): reads of many keys are batched, Reem's tick marks timed
 * reminders whoever schedules it, and the daily reconcile runs with the brief off. Rule 1435 is tests/redis-loops.test.ts.
 */
let n = 0;
const scope = () => `rel${++n}@test.example`;
const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, type: "social", channel: "instagram", title: `title ${id}`, body: "body", status: "approved", createdAt: new Date().toISOString(), lang: "ar", ...over });
const taskGets = (spy: { mock: { calls: unknown[][] } }, prefix: string) => spy.mock.calls.filter(([k]) => typeof k === "string" && k.startsWith(prefix)).length;

afterEach(() => vi.restoreAllMocks());

describe("mgetChunked (rule 1430)", () => {
  it("keeps key order and nulls, sends one MGET per chunk, and nothing for no keys", async () => {
    const s = scope();
    await Promise.all(Array.from({ length: 7 }, (_, i) => (i === 3 ? null : db.set(`mg:${s}:${i}`, { i }))));
    const mget = vi.spyOn(db, "mget");
    const rows = await mgetChunked<{ i: number }>(Array.from({ length: 7 }, (_, i) => `mg:${s}:${i}`), 3);
    expect(rows.map((r) => r?.i ?? null)).toEqual([0, 1, 2, null, 4, 5, 6]);
    expect(mget).toHaveBeenCalledTimes(3);
    expect(await mgetChunked([])).toEqual([]);
    expect(mget).toHaveBeenCalledTimes(3);
  });
});

describe("task lists read records in chunked MGETs (rule 1430)", () => {
  it("listTasks reads 200 newest plus the pending backlog with no per-task GET, same order, ghosts still cleared", async () => {
    const s = scope();
    // 230 decided tasks (the newest 200 are the head) and 20 older pending ones outside it.
    await Promise.all(Array.from({ length: 20 }, (_, i) => saveTask(s, task(`p${i}`, { status: "pending", createdAt: daysAgo(100 + i) }), true)));
    await Promise.all(Array.from({ length: 230 }, (_, i) => saveTask(s, task(`t${i}`, { createdAt: daysAgo(i % 80) }), true)));
    await listTasks(s); // first use indexes the workspace (its own chunked reads); the second call is the page view
    await db.sadd(`pending:${s}`, "ghost"); // counted by the badge, no record
    const get = vi.spyOn(db, "get");
    const mget = vi.spyOn(db, "mget");
    const rows = await listTasks(s);
    expect(taskGets(get, `task:${s}:`), "no task record is read one GET at a time").toBe(0);
    expect(mget).toHaveBeenCalledTimes(3); // 200 head + 20 tail = 220 keys, chunks of 100
    expect(rows).toHaveLength(220);
    const head = await db.lrange(`tasks:${s}`, 0, 199);
    expect(rows.slice(0, 200).map((t) => t.id)).toEqual(head);
    expect(rows.slice(200).map((t) => t.id)).toEqual(Array.from({ length: 20 }, (_, i) => `p${i}`));
    await vi.waitFor(async () => expect(await db.smembers(`pending:${s}`)).not.toContain("ghost"));
  });

  it("rebuildIndex reads every task in chunks, not one GET each", async () => {
    const s = scope();
    for (let i = 0; i < 250; i += 50) await Promise.all(Array.from({ length: 50 }, (_, j) => saveTask(s, task(`r${i + j}`), true)));
    const get = vi.spyOn(db, "get");
    const mget = vi.spyOn(db, "mget");
    expect(await rebuildIndex(s)).toHaveLength(250);
    expect(taskGets(get, `task:${s}:`)).toBe(0);
    expect(mget).toHaveBeenCalledTimes(3);
  });
});

describe("conversations (rule 1431)", () => {
  it("listConversations reads its records in one MGET; search reads every thread and still finds each hit", async () => {
    const s = scope();
    const convs = [];
    for (let i = 0; i < 5; i++) convs.push(await createConversation(s, `conv ${i}`));
    await Promise.all(convs.map((c, i) => push(s, { role: "user", content: i % 2 ? `needle in ${i}` : `nothing ${i}`, at: daysAgo(i) }, c.id)));
    await push(s, { role: "user", content: "a needle in the default thread", at: daysAgo(9) });
    const get = vi.spyOn(db, "get");
    const mget = vi.spyOn(db, "mget");
    expect(await listConversations(s)).toHaveLength(5);
    expect(taskGets(get, `conv:${s}:`)).toBe(0);
    expect(mget).toHaveBeenCalledTimes(1);
    const hits = await searchConversations(s, "NEEDLE");
    expect(hits.map((h) => h.conversationId).sort()).toEqual([convs[1].id, convs[3].id, "default"].sort());
    expect(hits[0].at >= hits[1].at).toBe(true); // newest first
  });
});

describe("Reem's tick marker (rule 1432)", () => {
  it("a sweep marked as the tick writes sec:tick:last; the daily fallback's sweep does not", async () => {
    await db.del(SEC_KEYS.tick);
    await sweepReminders(Date.now());
    expect(await timedReminders()).toBe(false);
    await sweepReminders(Date.now(), { tick: true });
    expect(await timedReminders()).toBe(true);
    await db.del(SEC_KEYS.tick);
  });
});

describe("console counters (rule 1433)", () => {
  it("userEvents reads the eleven counters in one MGET", async () => {
    const s = scope();
    await track(s, "chat");
    await track(s, "chat");
    await track(s, "approve");
    const get = vi.spyOn(db, "get");
    const mget = vi.spyOn(db, "mget");
    expect(await userEvents(s)).toEqual({ chat: 2, approve: 1 });
    expect(taskGets(get, `uev:${s}:`)).toBe(0);
    expect(mget).toHaveBeenCalledTimes(1);
  });
});

describe("the daily reconcile runs with the brief off (rule 1434)", () => {
  it("runDaily answers null with the brief off, yet repairs the pending set and rebuilds a stale index", async () => {
    const u = await newUser("relbriefoff");
    await saveSchedule(u.email, { dailyBrief: false });
    await saveTask(u.email, task("w1", { status: "pending" }), true);
    await db.srem(`pending:${u.email}`, "w1"); // a write that failed half way
    await db.del(`tidxv:${u.email}`); // never indexed
    expect(await runDaily(u)).toBeNull();
    expect(await db.smembers(`pending:${u.email}`)).toContain("w1");
    expect(await db.get(`tidxv:${u.email}`)).not.toBeNull();
  });
});
