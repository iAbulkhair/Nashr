import { describe, expect, it } from "vitest";
import { saveTask, pendingCount, type Task } from "@/lib/brand";
import { json, newUser, signIn } from "./helpers/session";
import { acct } from "@/lib/auth";
import { saveBrand } from "@/lib/brand";

/**
 * The contract, independent of how it is implemented: an item the sidebar counts as waiting for the owner must be an
 * item the owner can actually open. The inbox is the only place to approve or reject, it reads the newest 200 task ids
 * (`tasks:{scope}`), and the badge reads the whole `pending:{scope}` set — so past 200 tasks the two disagreed and the
 * backlog became invisible. The inbox also DEFAULTS to the pending filter, so the owner landed on a page showing
 * nothing while the sidebar insisted there was work.
 */
const task = (i: number, status: Task["status"]): Task => ({
  id: `t${String(i).padStart(4, "0")}`,
  type: "social",
  channel: "instagram",
  title: `item ${i}`,
  body: `body ${i}`,
  status,
  createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 20))).toISOString(),
  lang: "ar",
});

const BRAND = { name: "B", website: "", industry: "i", dialect: "saudi" as const, languages: ["ar" as const], tone: "", products: "p", audience: "a", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: new Date().toISOString() };

async function workspaceWithBuriedPending(prefix: string, oldPending: number, newerApproved: number) {
  const u = await newUser(prefix);
  await saveBrand(acct(u), BRAND);
  for (let i = 0; i < oldPending; i++) await saveTask(acct(u), task(i, "pending"), true);
  for (let i = oldPending; i < oldPending + newerApproved; i++) await saveTask(acct(u), task(i, "approved"), true);
  return u;
}

describe("every pending item the badge counts is reachable", () => {
  it("the inbox route returns the buried pending items, not just the newest 200 ids", async () => {
    const u = await workspaceWithBuriedPending("buried", 50, 220);
    await signIn(u.email);
    const route = await import("@/app/api/tasks/route");

    const badge = ((await (await route.GET(json("/api/tasks?count=pending", "GET"))).json()) as { pending: number }).pending;
    const body = (await (await route.GET(json("/api/tasks", "GET"))).json()) as { tasks: Task[] };
    const reachable = body.tasks.filter((t) => t.status === "pending");

    expect(badge, "the workspace really does have 50 items waiting").toBe(50);
    expect(reachable, "the owner must be able to open every one of them").toHaveLength(badge);
    // And they must carry what the card needs to render, not just an id.
    for (const t of reachable) expect(t.body.length).toBeGreaterThan(0);
  });

  it("a workspace under 200 tasks is unchanged", async () => {
    const u = await workspaceWithBuriedPending("small", 5, 20);
    await signIn(u.email);
    const route = await import("@/app/api/tasks/route");
    const body = (await (await route.GET(json("/api/tasks", "GET"))).json()) as { tasks: Task[] };
    expect(body.tasks).toHaveLength(25);
    expect(body.tasks.filter((t) => t.status === "pending")).toHaveLength(5);
    expect(await pendingCount(acct(u))).toBe(5);
  });

  it("a workspace with nothing pending still returns its recent tasks", async () => {
    const u = await workspaceWithBuriedPending("nopending", 0, 30);
    await signIn(u.email);
    const route = await import("@/app/api/tasks/route");
    const body = (await (await route.GET(json("/api/tasks", "GET"))).json()) as { tasks: Task[] };
    expect(body.tasks).toHaveLength(30);
    expect(body.tasks.filter((t) => t.status === "pending")).toHaveLength(0);
    expect(await pendingCount(acct(u))).toBe(0);
  });

  it("a pending id whose task record is gone does not break the inbox or inflate the badge", async () => {
    const u = await workspaceWithBuriedPending("ghost", 3, 210);
    const { db } = await import("@/lib/db");
    await db.del(`task:${acct(u)}:t0001`); // record deleted, id still in pending:{scope}
    // Mark the set as already built. Without this the badge's lazy rebuild repairs the drift before it is read and
    // the test passes without exercising anything — which is how it passed before the fix existed.
    await db.set(`pendingidx:${acct(u)}`, new Date().toISOString());
    expect(await db.smembers(`pending:${acct(u)}`), "the stale id must really be in the set").toContain("t0001");
    await signIn(u.email);
    const route = await import("@/app/api/tasks/route");

    const body = (await (await route.GET(json("/api/tasks", "GET"))).json()) as { ok: boolean; tasks: Task[] };
    expect(body.ok).toBe(true);
    expect(body.tasks.some((t) => t.id === "t0001")).toBe(false);
    const badge = ((await (await route.GET(json("/api/tasks?count=pending", "GET"))).json()) as { pending: number }).pending;
    expect(body.tasks.filter((t) => t.status === "pending"), "the badge must not count a task that no longer exists").toHaveLength(badge);
  });

  it("one workspace's buried pending never leaks into another's inbox", async () => {
    const mine = await workspaceWithBuriedPending("iso-a", 40, 210);
    const theirs = await workspaceWithBuriedPending("iso-b", 7, 5);
    await signIn(mine.email);
    const route = await import("@/app/api/tasks/route");
    const body = (await (await route.GET(json("/api/tasks", "GET"))).json()) as { tasks: Task[] };
    const titles = new Set(body.tasks.map((t) => t.title));
    expect(titles.size).toBeGreaterThan(0);
    expect(await pendingCount(acct(theirs))).toBe(7);
    expect(body.tasks.filter((t) => t.status === "pending")).toHaveLength(40);
  });
});

describe("the inbox never renders one task twice (React key + optimistic overlay)", () => {
  it("a pending task inside the newest 200 appears exactly once", async () => {
    const u = await newUser("dupe");
    await saveBrand(acct(u), BRAND);
    // 201 tasks so the head is full, with the NEWEST one pending: it is in the head AND in the pending set.
    for (let i = 0; i < 200; i++) await saveTask(acct(u), task(i, "approved"), true);
    await saveTask(acct(u), task(200, "pending"), true);

    await signIn(u.email);
    const route = await import("@/app/api/tasks/route");
    const body = (await (await route.GET(json("/api/tasks", "GET"))).json()) as { tasks: Task[] };

    const ids = body.tasks.map((t) => t.id);
    expect(new Set(ids).size, "a duplicate id gives React duplicate keys and doubles the optimistic overlay").toBe(ids.length);
    expect(ids.filter((id) => id === "t0200")).toHaveLength(1);
    expect(body.tasks.filter((t) => t.status === "pending")).toHaveLength(await pendingCount(acct(u)));
  });

  it("buried pending items come back newest-first and in a stable order", async () => {
    const u = await workspaceWithBuriedPending("order", 30, 210);
    await signIn(u.email);
    const route = await import("@/app/api/tasks/route");
    const read = async () => ((await (await route.GET(json("/api/tasks", "GET"))).json()) as { tasks: Task[] }).tasks.filter((t) => t.status === "pending").map((t) => t.id);

    const first = await read();
    expect(first).toHaveLength(30);
    const sorted = [...first].sort().reverse();
    expect(first, "newest first").toEqual(sorted);
    // Two reads in a row must not reshuffle under an owner working through the backlog; smembers order is unspecified.
    expect(await read()).toEqual(first);
  });
});
