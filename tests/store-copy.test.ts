import { describe, expect, it } from "vitest";
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
