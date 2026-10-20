import { describe, expect, it } from "vitest";
import { json, newUser, params, signIn } from "./helpers/session";
import { sc, type User } from "@/lib/auth";
import { getTask, saveTask, type Task } from "@/lib/brand";
import { readFile, writeFile, writeFileChecked } from "@/lib/files";
import { db } from "@/lib/db";
import { scopeParam, wsKey } from "@/lib/keys";
import { taskVersion } from "@/lib/task-version";
import * as filesRoute from "@/app/api/files/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";

/**
 * Rules 2440-2441: a person's edit made from an older view never silently replaces newer text (OpenDots'
 * `expectedRevision`, docs/OpenDots_Adoption.md). The inbox's text edit carries the card's version; the Files page's save
 * carries the time of the file it opened, or null for a new file. Without them both routes behave as before.
 */
type Body = Record<string, unknown> & { ok?: boolean; error?: string; file?: { name: string; content: string; updatedAt: string } | null };
const put = async (body: unknown) => {
  const res = await filesRoute.PUT(json("/api/files", "PUT", body));
  return { status: res.status, body: (await res.json()) as Body };
};
const patch = async (id: string, body: unknown) => {
  const res = await taskRoute.PATCH(json(`/api/tasks/${id}`, "PATCH", body), params({ id }));
  return { status: res.status, body: (await res.json()) as Body & { task?: Task } };
};
async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await signIn(u.email);
  return u;
}

describe("rule 2440: an inbox text edit sent with the card's version is saved only while that is still the item's version", () => {
  it("a stale version is 409 changed with the item as it is now; the current version saves; no version saves as before", async () => {
    const u = await owner("sw-task");
    const t: Task = { id: "b1b2c3d4e5f60718", type: "social", channel: "instagram", title: "قهوة", body: "النص الأول", status: "pending", createdAt: new Date().toISOString(), lang: "ar" };
    await saveTask(sc(u), t);
    const seen = taskVersion(t);
    // Someone else edits after the card was shown.
    expect((await patch(t.id, { editedBody: "نص الزميل", version: seen })).status).toBe(200);
    const late = await patch(t.id, { editedBody: "نصّي القديم", version: seen });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("changed");
    expect(late.body.task?.editedBody).toBe("نص الزميل");
    expect((await getTask(sc(u), t.id))?.editedBody).toBe("نص الزميل");
    const now = (await getTask(sc(u), t.id))!;
    expect((await patch(t.id, { editedBody: "نصّي الجديد", version: taskVersion(now) })).status).toBe(200);
    expect((await patch(t.id, { editedBody: "بلا نسخة" })).status, "expand: an older page sends no version").toBe(200);
    expect((await getTask(sc(u), t.id))?.editedBody).toBe("بلا نسخة");
  });
});

describe("rule 2441: a Files save sent with a base is written only while the file is still that one", () => {
  it("stale when it changed since, exists when a new name is taken, and the current base saves", async () => {
    const u = await owner("sw-file");
    const first = await put({ name: "notes.md", content: "v1", baseAt: null });
    expect(first.status).toBe(200);
    const opened = first.body.file!.updatedAt;
    // A teammate saves in between (an agent's write over a person's file goes to a sibling name, `writeFile`).
    await new Promise((r) => setTimeout(r, 5));
    await writeFile(sc(u), "notes.md", "teammate text", "user");
    const late = await put({ name: "notes.md", content: "mine", baseAt: opened });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("stale");
    expect(late.body.file?.content).toBe("teammate text");
    expect((await readFile(sc(u), "notes.md"))?.content).toBe("teammate text");
    const again = await put({ name: "notes.md", content: "mine", baseAt: late.body.file!.updatedAt });
    expect(again.status).toBe(200);
    expect((await readFile(sc(u), "notes.md"))?.content).toBe("mine");
    const taken = await put({ name: "Notes.md", content: "new", baseAt: null });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("exists");
    expect((await readFile(sc(u), "notes.md"))?.content).toBe("mine");
  });

  it("a file deleted since is stale with no file; no base keeps the old last-write-wins save", async () => {
    await owner("sw-gone");
    const r = await put({ name: "gone.md", content: "x", baseAt: "2026-01-01T00:00:00.000Z" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "stale", file: null });
    expect((await put({ name: "gone.md", content: "a" })).status).toBe(200);
    expect((await put({ name: "gone.md", content: "b" })).body.file?.content).toBe("b");
  });
});

describe("rules 2520-2522: every writer of a file takes its lock, so nothing lands between a checked save's check and its write", () => {
  const lockOf = (scope: string, name: string) => wsKey.fileLock(scopeParam(scope), name);
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("rule 2520: an agent's write waits while a person's save holds the file", async () => {
    const s = sc(await newUser("sw-wait"));
    await writeFile(s, "products.md", "agent v1", "noor");
    const lock = lockOf(s, "products.md");
    expect(await db.lock(lock, 10)).toBe(true);
    let done = false;
    const w = writeFile(s, "products.md", "agent v2", "noor").then((f) => ((done = true), f));
    await later(200);
    expect(done, "still waiting for the lock").toBe(false);
    expect((await readFile(s, "products.md"))?.content).toBe("agent v1");
    await db.unlock(lock);
    expect((await w).content).toBe("agent v2");
  });

  it("rule 2520: a person's save from the version they opened and an agent's write at the same moment never lose the agent's text silently", async () => {
    for (let i = 0; i < 12; i++) {
      const s = sc(await newUser(`sw-race${i}`));
      const opened = await writeFile(s, "products.md", "agent v1", "noor");
      const [mine] = await Promise.all([writeFileChecked(s, "products.md", "mine", "user", opened.updatedAt), writeFile(s, "products.md", "agent v2", "noor")]);
      const [main, sibling] = await Promise.all([readFile(s, "products.md"), readFile(s, "products-imported.md")]);
      if (mine.ok) {
        // The person's save went first: the agent's write found a person's file and went to the sibling.
        expect(main?.content, `run ${i}`).toBe("mine");
        expect(sibling?.content, `run ${i}: the agent's text is kept`).toBe("agent v2");
      } else {
        // The agent's write went first: the person is told, with the file as it is now.
        expect(mine.error, `run ${i}`).toBe("stale");
        expect(main?.content, `run ${i}`).toBe("agent v2");
      }
    }
  });

  it("rule 2521: a lock nobody releases delays a writer about 2 s, never fails it", async () => {
    const s = sc(await newUser("sw-stuck"));
    expect(await db.lock(lockOf(s, "notes.md"), 10)).toBe(true);
    const t0 = Date.now();
    expect((await writeFile(s, "notes.md", "synced", "noor")).content).toBe("synced");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 10_000);

  it("rule 2522: an agent's write sent to the sibling of a person's file takes the sibling's lock too", async () => {
    const s = sc(await newUser("sw-sib"));
    await writeFile(s, "products.md", "curated by hand", "user");
    const lock = lockOf(s, "products-imported.md");
    expect(await db.lock(lock, 10)).toBe(true);
    let done = false;
    const w = writeFile(s, "products.md", "scraped", "noor").then((f) => ((done = true), f));
    await later(200);
    expect(done, "waits for the sibling, not only for products.md").toBe(false);
    await db.unlock(lock);
    expect((await w).name).toBe("products-imported.md");
    expect((await readFile(s, "products.md"))?.content).toBe("curated by hand");
  });
});
