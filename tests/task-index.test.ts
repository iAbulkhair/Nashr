import { describe, expect, it } from "vitest";
import { listLite, listTasks, liteOf, rebuildIndex, saveTask, type Task } from "@/lib/brand";
import { CAPS, db, pushCapped } from "@/lib/db";
import { kpis, kpiSince } from "@/lib/stats";
import { typeMetrics } from "@/lib/evals";
import { wipeAccount } from "@/lib/account";

let n = 0;
const scope = () => `tidx${++n}@test.example`;
const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, type: "social", channel: "instagram", title: `title ${id}`, body: "a long body that must never reach the index ".repeat(20), status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...over });

describe("light task index", () => {
  it("keeps a row without the body and follows every save", async () => {
    const s = scope();
    await saveTask(s, task("a"), true);
    let rows = await listLite(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("body");
    expect(rows[0].preview.length).toBeLessThanOrEqual(200);
    await saveTask(s, { ...task("a"), status: "approved", editedBody: "the owner rewrote all of it", imageUrl: "https://img.example/x.png", published: [{ provider: "telegram", url: "u", status: "published", at: daysAgo(0) }], quality: { score: 64, dims: { completeness: 1, brand: 1, honesty: 1, language: 1, format: 1 }, notes: "weak hook", model: "m", at: daysAgo(0) } });
    rows = await listLite(s);
    expect(rows).toHaveLength(1); // same id, same row
    expect(rows[0]).toMatchObject({ status: "approved", edited: true, image: true, published: 1, score: 64, notes: "weak hook", preview: "the owner rewrote all of it" });
    expect(rows[0].editPct).toBeGreaterThan(50);
  });

  it("does not lose tasks under parallel saves (a batch is saved at once)", async () => {
    const s = scope();
    await Promise.all(Array.from({ length: 25 }, (_, i) => saveTask(s, task(`p${i}`), true)));
    expect(await listLite(s)).toHaveLength(25);
  });

  it("sees past the 200 newest tasks, which the full list cannot", async () => {
    const s = scope();
    await Promise.all(Array.from({ length: 230 }, (_, i) => saveTask(s, task(`t${i}`, { createdAt: daysAgo(i % 80) }), true)));
    expect(await listTasks(s)).toHaveLength(200);
    expect(await listLite(s)).toHaveLength(230);
  });

  it("reads only the months a window needs and filters inside the first month", async () => {
    const s = scope();
    await saveTask(s, task("new", { createdAt: daysAgo(1) }), true);
    await saveTask(s, task("mid", { createdAt: daysAgo(40) }), true);
    await saveTask(s, task("old", { createdAt: daysAgo(400) }), true);
    expect((await listLite(s)).map((r) => r.id)).toEqual(["new", "mid", "old"]); // newest first
    expect((await listLite(s, new Date(Date.now() - 60 * 864e5))).map((r) => r.id)).toEqual(["new", "mid"]);
    expect((await listLite(s, new Date(Date.now() - 7 * 864e5))).map((r) => r.id)).toEqual(["new"]);
  });

  it("indexes a workspace written before the index existed, exactly once", async () => {
    const s = scope();
    for (const id of ["x", "y", "z"]) { await db.set(`task:${s}:${id}`, task(id, { createdAt: daysAgo(3) })); await db.lpush(`tasks:${s}`, id); }
    expect(await db.get(`tidxv:${s}`)).toBeNull();
    expect(await listLite(s)).toHaveLength(3);
    expect(await db.get(`tidxv:${s}`)).not.toBeNull();
  });

  it("rebuild repairs a row that drifted from its task", async () => {
    const s = scope();
    await saveTask(s, task("a", { status: "approved" }), true);
    await listLite(s);
    await db.hset(`tidx:${s}:${new Date().toISOString().slice(0, 7)}`, "a", { ...liteOf(task("a")), status: "rejected" });
    expect((await listLite(s))[0].status).toBe("rejected");
    await rebuildIndex(s);
    expect((await listLite(s))[0].status).toBe("approved");
  });

  it("never mixes two workspaces", async () => {
    const a = scope(), b = scope();
    await saveTask(a, task("mine"), true);
    await saveTask(b, task("theirs"), true);
    expect((await listLite(a)).map((r) => r.id)).toEqual(["mine"]);
    expect((await listLite(b)).map((r) => r.id)).toEqual(["theirs"]);
  });
});

describe("numbers computed from the light index", () => {
  it("kpis match the tasks, including ones older than the 200 newest", async () => {
    const s = scope();
    await Promise.all(Array.from({ length: 210 }, (_, i) => saveTask(s, task(`k${i}`, { createdAt: daysAgo(2), status: i < 150 ? "approved" : i < 180 ? "rejected" : "pending", imageUrl: i < 10 ? "u" : undefined }), true)));
    const k = await kpis(s, 7);
    expect(k.created).toBe(210);
    expect(k.approved).toBe(150);
    expect(k.rejected).toBe(30);
    expect(k.pending).toBe(30);
    expect(k.images).toBe(10);
    expect(k.approvalRate).toBe(83);
  });
  it("kpiSince always covers the comparison window and the 8-week chart", () => {
    expect(Date.now() - kpiSince().getTime()).toBeGreaterThanOrEqual(89 * 864e5);
    const prevFrom = new Date(Date.now() - 700 * 864e5);
    expect(kpiSince({ prevFrom }).getTime()).toBe(prevFrom.getTime());
  });
  it("edit rate and magnitude come from the row, not from the bodies", () => {
    const rows = [liteOf(task("a", { status: "approved", editedBody: "completely different words here now" })), liteOf(task("b", { status: "approved" }))];
    const [m] = typeMetrics(rows);
    expect(m.edited).toBe(1);
    expect(m.editRate).toBe(50);
    expect(m.editMagnitude).toBeGreaterThan(50);
  });
});

describe("bounded lists and account wipe", () => {
  it("pushCapped keeps only the newest entries", async () => {
    const key = `cap-test-${++n}`;
    for (let i = 0; i < 30; i++) await pushCapped(key, String(i), 10);
    const rows = await db.lrange(key, 0, -1);
    expect(rows.length).toBeLessThanOrEqual(11);
    expect(rows[0]).toBe("29");
    expect(CAPS.chat).toBeGreaterThanOrEqual(200); // conversation search reads 200 messages
  });
  it("wipeAccount removes every task and the whole index, not only the newest 200", async () => {
    const e = scope();
    await Promise.all(Array.from({ length: 205 }, (_, i) => saveTask(e, task(`w${i}`), true)));
    await wipeAccount(e);
    expect(await db.get(`task:${e}:w0`)).toBeNull();
    expect(await db.get(`task:${e}:w204`)).toBeNull();
    expect(await db.lrange(`tasks:${e}`, 0, -1)).toHaveLength(0);
    expect(await db.smembers(`tidxm:${e}`)).toHaveLength(0);
    expect(await db.smembers(`pending:${e}`)).toHaveLength(0);
    expect(await listLite(e)).toHaveLength(0);
  });
});
