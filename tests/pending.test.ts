import { describe, expect, it } from "vitest";
import { pendingCount, rebuildPending, saveTask, type Task } from "@/lib/brand";
import { db } from "@/lib/db";

let n = 0;
const scope = () => `pending${++n}@test.example`;
const task = (id: string, status: Task["status"]): Task => ({ id, type: "social", channel: "instagram", title: id, body: "body", status, createdAt: new Date().toISOString(), lang: "ar" });

describe("pending approvals set", () => {
  it("follows every status change that goes through saveTask", async () => {
    const s = scope();
    await saveTask(s, task("a", "pending"), true);
    await saveTask(s, task("b", "pending"), true);
    await saveTask(s, task("c", "approved"), true); // auto-approved at creation
    expect(await pendingCount(s)).toBe(2);
    await saveTask(s, task("a", "approved"));
    expect(await pendingCount(s)).toBe(1);
    await saveTask(s, task("b", "rejected"));
    expect(await pendingCount(s)).toBe(0);
    await saveTask(s, task("a", "pending")); // owner undid the approval
    expect(await pendingCount(s)).toBe(1);
  });
  it("is idempotent: saving the same pending task twice counts once", async () => {
    const s = scope();
    await saveTask(s, task("a", "pending"), true);
    await saveTask(s, task("a", "pending"));
    expect(await pendingCount(s)).toBe(1);
  });
  it("indexes a workspace that existed before the set did, exactly once", async () => {
    const s = scope();
    // Tasks written the old way: no set, no index marker.
    for (const [id, st] of [["x", "pending"], ["y", "pending"], ["z", "approved"]] as const) { await db.set(`task:${s}:${id}`, task(id, st)); await db.lpush(`tasks:${s}`, id); }
    expect(await db.get(`pendingidx:${s}`)).toBeNull();
    expect(await pendingCount(s)).toBe(2);
    expect(await db.get(`pendingidx:${s}`)).not.toBeNull();
  });
  it("reconciles drift: stale ids are dropped and missing ones added", async () => {
    const s = scope();
    await saveTask(s, task("a", "pending"), true);
    await db.sadd(`pending:${s}`, "ghost"); // an id that no longer exists in the task window
    await db.srem(`pending:${s}`, "a"); // a real pending task missing from the set
    expect(await rebuildPending(s)).toBe(1);
    expect(await db.smembers(`pending:${s}`)).toEqual(["a"]);
  });
});
