import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { newUser, params, settle, signIn } from "./helpers/session";
import { vjson } from "./helpers/version";
import { getUser, acct } from "@/lib/auth";
import { getTask, listLite, listTasks, pendingCount, pendingIds, rebuildPending, saveTask, waitingIds, type Brand, type Task } from "@/lib/brand";
import { db } from "@/lib/db";
import { handleOf } from "@/lib/ws-handle";
import { followUps, listNotifs } from "@/lib/notifications";
import { getSchedule, runDaily, saveSchedule } from "@/lib/schedule";
import { kpis } from "@/lib/stats";
import { NOT_NOW_DAYS, clockStart, dueForNotNow, moveIdle, soonNotNow } from "@/lib/not-now";
import { runTool } from "@/lib/chat";
import * as taskRoute from "@/app/api/tasks/[id]/route";

/**
 * Rules 2340-2347: "Not now" in the approvals inbox (Fizzy's entropy pattern, study 2026-10-19 pattern 1, founder's
 * 14-day default). docs/system/tests/2340-inbox-not-now.md lists what each test pins.
 */
const DAY = 864e5;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, type: "social", channel: "instagram", title: `title ${id}`, body: "قهوة اليوم من محمصتنا في الرياض", status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...over });
const patch = async (id: string, body: unknown) => { const res = await taskRoute.PATCH(await vjson(`/api/tasks/${id}`, "PATCH", body), params({ id })); await settle(); return res; };
// A session user and a cron roster entry carry their scope; runTool and runDaily read `user.scope ?? user.email`.
const live = async (u: { email: string }) => ({ ...(await getUser(acct(u)))!, scope: acct(u) });
const owner = async (prefix: string) => { const u = await newUser(prefix); await db.set(`brand:${acct(u)}`, brand); await signIn(u.email); return u; };
let n = 0;
const scope = () => `notnow${++n}@test.example`;

describe("rules 2340-2341: the stored shape and the Not now subset", () => {
  it("a set-aside item stays pending, leaves the count, and stays in the inbox list", async () => {
    const s = scope();
    await saveTask(s, task("a"), true);
    await saveTask(s, task("b", { notNow: { at: ago(0), by: "owner" } }), true);
    expect((await pendingIds(s)).sort()).toEqual(["a", "b"]);
    expect(await waitingIds(s)).toEqual(["a"]);
    expect(await pendingCount(s)).toBe(1);
    expect((await listTasks(s)).map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(await db.smembers(`notnow:${s}`)).toEqual(["b"]);
    // The light row carries it, so counts and the daily move read no task bodies.
    expect((await listLite(s)).find((l) => l.id === "b")?.notNow).toEqual({ at: expect.any(String), by: "owner" });
  });
  it("a decision takes the id out of both sets", async () => {
    const s = scope();
    await saveTask(s, task("a", { notNow: { at: ago(0), by: "auto" } }), true);
    await saveTask(s, { ...task("a"), status: "approved" });
    expect(await db.smembers(`notnow:${s}`)).toEqual([]);
    expect(await db.smembers(`pending:${s}`)).toEqual([]);
  });
  it("the daily reconcile rebuilds the subset: an id older code left behind is dropped", async () => {
    const s = scope();
    await saveTask(s, task("a"), true);
    await saveTask(s, task("b", { notNow: { at: ago(0), by: "owner" } }), true);
    await db.sadd(`notnow:${s}`, "a"); // older code never writes notnow:, so it can go stale
    await db.srem(`notnow:${s}`, "b");
    expect(await rebuildPending(s)).toBe(2);
    expect(await db.smembers(`notnow:${s}`)).toEqual(["b"]);
  });
});

describe("rule 2342: what counts as waiting", () => {
  it("the KPIs, the 48-hour nudge and the chat's list_inbox leave set-aside items out", async () => {
    const u = await owner("nnk");
    await saveTask(acct(u), task("w", { createdAt: ago(3) }), true);
    await saveTask(acct(u), task("x", { createdAt: ago(3), notNow: { at: ago(1), by: "owner" } }), true);
    expect((await kpis(acct(u))).pending).toBe(1);
    const nudges = (await followUps((await live(u)), acct(u))).filter((x) => x.kind === "pending");
    expect(nudges.map((x) => x.title)).toEqual([expect.stringContaining("1 عنصر")]);
    expect(await runTool((await live(u)), "list_inbox", {}, [])).toMatch(/1 pending, 1 set aside under Not now/);
  });
  it("the source of every waiting count reads isWaiting or waitingIds, never status === \"pending\" alone", () => {
    const read = (p: string) => readFileSync(p, "utf8");
    expect(read("src/lib/schedule.ts")).toMatch(/const pending = tasks\.filter\(isWaiting\)\.length/);
    expect(read("src/lib/lifecycle.ts")).toMatch(/pending: tasks\.filter\(isWaiting\)\.length/);
    expect(read("src/app/[lang]/app/b/[brand]/chat/page.tsx")).toMatch(/rows\.find\(isWaiting\)/);
    expect(read("src/lib/secretary-walk.ts")).toMatch(/waitingIds\(scope\)/);
    expect(read("src/lib/secretary-walk.ts")).toMatch(/!!t && isWaiting\(t\)/);
    expect(read("src/lib/notifications.ts")).toMatch(/const stale = tasks\.filter\(\(t\) => isWaiting\(t\)/);
    expect(read("src/lib/notifications.ts")).toMatch(/const weak = tasks\.filter\(\(t\) => isWaiting\(t\)/);
  });
});

describe("rule 2343: the 14-day move", () => {
  it("the clock starts at the latest of creation, last touch and the workspace's first run", () => {
    const t = { status: "pending" as const, createdAt: ago(30), touchedAt: ago(20) };
    const from = ago(5);
    expect(clockStart(t)).toBe(new Date(t.touchedAt).getTime());
    expect(clockStart(t, from)).toBe(new Date(from).getTime());
    expect(dueForNotNow([t], Date.now())).toHaveLength(1);
    expect(dueForNotNow([t], Date.now(), from)).toHaveLength(0);
    expect(dueForNotNow([{ ...t, notNow: { at: ago(1), by: "owner" as const } }], Date.now())).toHaveLength(0);
    expect(dueForNotNow([{ ...t, status: "approved" as const }], Date.now())).toHaveLength(0);
  });
  it("moves only what is still waiting on the task as stored now, under its lock", async () => {
    const s = scope();
    await saveTask(s, task("old", { createdAt: ago(NOT_NOW_DAYS + 1) }), true);
    await saveTask(s, task("new", { createdAt: ago(2) }), true);
    await saveTask(s, task("raced", { createdAt: ago(NOT_NOW_DAYS + 1) }), true);
    const rows = await listLite(s);
    // Approved between the read of the rows and the move: the approval wins.
    await saveTask(s, { ...task("raced", { createdAt: ago(NOT_NOW_DAYS + 1) }), status: "approved" });
    expect(await moveIdle(s, rows, Date.now())).toEqual(["old"]);
    expect((await getTask(s, "old"))?.notNow?.by).toBe("auto");
    expect((await getTask(s, "old"))?.status).toBe("pending");
    expect((await getTask(s, "raced"))?.notNow).toBeUndefined();
    expect(await waitingIds(s)).toEqual(["new"]);
  });
  it("runDaily stamps the workspace's start on its first run, so an old backlog is not moved on release day", async () => {
    const u = await owner("nnd");
    await saveTask(acct(u), task("backlog", { createdAt: ago(40) }), true);
    expect((await getSchedule(acct(u))).notNowFrom).toBeUndefined();
    await runDaily((await live(u)));
    expect((await getSchedule(acct(u))).notNowFrom).toEqual(expect.any(String));
    expect((await getTask(acct(u), "backlog"))?.notNow).toBeUndefined();
    // Fifteen days after the start, the next run moves it and says so once.
    await saveSchedule(acct(u), { notNowFrom: ago(NOT_NOW_DAYS + 1) });
    const brief = await runDaily((await live(u)));
    expect((await getTask(acct(u), "backlog"))?.notNow?.by).toBe("auto");
    expect(brief?.pending).toBe(0);
    expect(await pendingCount(acct(u))).toBe(0);
    const moved = (await listNotifs(acct(u))).filter((x) => x.title.includes("انتقل إلى «ليس الآن»"));
    expect(moved).toHaveLength(1);
    expect(moved[0].href).toBe(`/ar/app/w/${handleOf(u)}/b/default?view=notnow`);
    await runDaily((await live(u)));
    expect((await listNotifs(acct(u))).filter((x) => x.title.includes("انتقل إلى «ليس الآن»"))).toHaveLength(1);
  });
  it("the schedule route cannot set the start: only runDaily writes notNowFrom", () => {
    expect(readFileSync("src/app/api/schedule/route.ts", "utf8")).not.toMatch(/notNowFrom/);
  });
});

describe("rule 2344: the warning at 75%", () => {
  it("items between day 10.5 and day 14 are announced once, with the days left", async () => {
    expect(soonNotNow([{ status: "pending", createdAt: ago(11) }], Date.now())).toHaveLength(1);
    expect(soonNotNow([{ status: "pending", createdAt: ago(9) }], Date.now())).toHaveLength(0);
    expect(soonNotNow([{ status: "pending", createdAt: ago(15) }], Date.now())).toHaveLength(0);
    const u = await owner("nnw");
    await saveSchedule(acct(u), { notNowFrom: ago(60) });
    await saveTask(acct(u), task("s1", { createdAt: ago(11) }), true);
    const first = (await followUps((await live(u)), acct(u))).filter((x) => x.title.includes("ينتقل إلى «ليس الآن»"));
    expect(first.map((x) => x.title)).toEqual(["1 عنصر ينتقل إلى «ليس الآن» خلال 3 يوم"]);
    expect((await followUps((await live(u)), acct(u))).filter((x) => x.title.includes("ينتقل إلى «ليس الآن»"))).toHaveLength(0);
  });
});

describe("rule 2345: PATCH notNow", () => {
  it("sets aside and brings back a pending item; bringing back restarts the clock", async () => {
    const u = await owner("nnp");
    await saveTask(acct(u), task("p", { createdAt: ago(20) }), true);
    expect((await patch("p", { notNow: true })).status).toBe(200);
    expect((await getTask(acct(u), "p"))?.notNow).toEqual({ at: expect.any(String), by: "owner" });
    expect(await pendingCount(acct(u))).toBe(0);
    expect((await getTask(acct(u), "p"))?.decidedAt).toBeUndefined();
    expect((await patch("p", { notNow: false })).status).toBe(200);
    const back = (await getTask(acct(u), "p"))!;
    expect(back.notNow).toBeUndefined();
    expect(back.touchedAt).toEqual(expect.any(String));
    expect(dueForNotNow([back], Date.now())).toHaveLength(0);
    expect(await pendingCount(acct(u))).toBe(1);
  });
  it("refuses a decided item with 409 not_pending and changes nothing", async () => {
    const u = await owner("nnr");
    await saveTask(acct(u), task("d", { status: "approved" }), true);
    const res = await patch("d", { notNow: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_pending");
    expect((await getTask(acct(u), "d"))?.notNow).toBeUndefined();
  });
  it("a decision takes the item out of Not now; an edit or a date restarts the clock", async () => {
    const u = await owner("nnx");
    await saveTask(acct(u), task("r", { notNow: { at: ago(1), by: "auto" } }), true);
    expect((await patch("r", { status: "rejected", note: "لا" })).status).toBe(200);
    expect((await getTask(acct(u), "r"))?.notNow).toBeUndefined();
    await saveTask(acct(u), task("e", { createdAt: ago(12) }), true);
    expect((await patch("e", { scheduledFor: "2026-12-01" })).status).toBe(200);
    expect(dueForNotNow([(await getTask(acct(u), "e"))!], Date.now() + 5 * DAY)).toHaveLength(0);
  });
});

describe("rules 2346-2347: the inbox chip and the tools", () => {
  it("the inbox has a Not now chip, both buttons, and opens on it from the notice's link", () => {
    const inbox = readFileSync("src/components/app/Inbox.tsx", "utf8");
    expect(inbox).toMatch(/const CHIPS = \["pending", "notnow", "approved", "rejected", "all"\] as const/);
    expect(inbox).toMatch(/patch\(x\.id, \{ notNow: true \}\)/);
    expect(inbox).toMatch(/patch\(x\.id, \{ notNow: false \}\)/);
    expect(readFileSync("src/app/[lang]/app/b/[brand]/page.tsx", "utf8")).toMatch(/initialFilter=\{sp\.view === "notnow" \? "notnow" : undefined\}/);
  });
  it("MCP list_inbox offers not_now and lists only waiting items under pending", () => {
    const mcp = readFileSync("src/app/api/mcp/route.ts", "utf8");
    expect(mcp).toMatch(/enum: \["pending", "not_now", "approved", "rejected", "all"\]/);
    expect(mcp).toMatch(/status === "pending" \? isWaiting\(t\)/);
  });
});
