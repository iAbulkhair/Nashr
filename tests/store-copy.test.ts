import { describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";

/**
 * The in-memory store must behave like Upstash, which serialises on write and parses on read. When it handed out the
 * stored object itself, `const u = await db.get(k); u.credits -= 10;` updated the store even with no save — so a
 * missing write passed every test and was a silent no-op in production. That divergence hid a real defect in
 * `charge`, whose NaN repair was never persisted on the insufficient-credits path.
 */
describe("the store hands out copies, as Upstash does", () => {
  it("a value mutated after reading does not change what is stored", async () => {
    await db.set("copy:read", { credits: 50, nested: { seen: false } });
    const read = (await db.get<{ credits: number; nested: { seen: boolean } }>("copy:read"))!;
    read.credits = 999;
    read.nested.seen = true;
    const again = (await db.get<{ credits: number; nested: { seen: boolean } }>("copy:read"))!;
    expect(again.credits, "forgetting to save must lose the change, exactly as over HTTP").toBe(50);
    expect(again.nested.seen, "the copy has to be deep, or a nested edit still leaks").toBe(false);
  });

  it("a value mutated after writing does not change what is stored", async () => {
    const written = { credits: 50 };
    await db.set("copy:write", written);
    written.credits = 999;
    expect((await db.get<{ credits: number }>("copy:write"))!.credits).toBe(50);
  });

  it("hgetall returns a copy too", async () => {
    await db.hset("copy:hash", "f", { n: 1 });
    const all = await db.hgetall<{ n: number }>("copy:hash");
    all.f.n = 99;
    expect((await db.hgetall<{ n: number }>("copy:hash")).f.n).toBe(1);
  });

  it("primitives and missing keys still round-trip", async () => {
    await db.set("copy:str", "hello");
    expect(await db.get<string>("copy:str")).toBe("hello");
    expect(await db.get("copy:absent")).toBeNull();
  });
});

/**
 * The chat turn shows the agent a list of file names. It used to get them from `listFiles`, which pulls every file's
 * full body over HTTP — the entire workspace fetched and discarded on every message, including the five core files
 * `memoryBlock` was already fetching in the same Promise.all.
 */
describe("listing file names", () => {
  it("reads the index only, never the file bodies", async () => {
    const { writeFile, listFileNames, listFiles } = await import("@/lib/files");
    const who = "names@test.example";
    await writeFile(who, "b-strategy.md", "b".repeat(5000));
    await writeFile(who, "a-brand.md", "a".repeat(5000));

    const spy = vi.spyOn(db, "get");
    const names = await listFileNames(who);
    const bodyReads = spy.mock.calls.filter((c) => String(c[0]).startsWith(`file:${who}:`)).length;
    spy.mockRestore();

    expect(names, "sorted, so the system prompt text is stable for the prompt cache").toEqual(["a-brand.md", "b-strategy.md"]);
    expect(bodyReads, "the names live in the index; nothing needs the contents").toBe(0);

    // The contrast proves the assertion above is not vacuous: the full read really does fetch each body.
    const spy2 = vi.spyOn(db, "get");
    await listFiles(who);
    const fullReads = spy2.mock.calls.filter((c) => String(c[0]).startsWith(`file:${who}:`)).length;
    spy2.mockRestore();
    expect(fullReads).toBe(2);
  });
});
