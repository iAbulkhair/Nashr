import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { allow } from "@/lib/rate";

/**
 * allow() is a fixed window: INCR, and an expiry that must exist whatever happens. It used to set the expiry with a SET
 * on the first hit only, so a lost first-hit call left a counter with no expiry that refused every later caller for good
 * (rate:kie:create is shared by every tenant, rate:mfail:{model} trips the breaker), and the SET reset hits that landed
 * in between.
 */
const mem = () => (globalThis as unknown as { __nashrMem: { exp: Map<string, number> } }).__nashrMem;
let n = 0;
const bucket = () => `test:window:${++n}:${Date.now()}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@upstash/redis");
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("allow(): every window ends", () => {
  it("a counter left without an expiry gets one at the next hit instead of refusing for ever", async () => {
    const b = bucket();
    await db.incrby(`rate:${b}`, 18); // counted, but the call that set its expiry never landed
    expect(mem().exp.has(`rate:${b}`)).toBe(false);
    expect(await allow(b, 18, 10)).toBe(false);
    const at = mem().exp.get(`rate:${b}`)!;
    expect(at).toBeGreaterThan(Date.now());
    expect(at).toBeLessThanOrEqual(Date.now() + 10_000);
    // Once that expiry passes the bucket admits again.
    mem().exp.set(`rate:${b}`, Date.now() - 1);
    expect(await allow(b, 18, 10)).toBe(true);
    expect(await db.get(`rate:${b}`)).toBe(1);
  });

  it("concurrent first hits are all counted: setting the expiry never touches the count", async () => {
    const b = bucket();
    const answers = await Promise.all(Array.from({ length: 5 }, () => allow(b, 3, 10)));
    expect(await db.get(`rate:${b}`)).toBe(5);
    expect(answers.filter(Boolean)).toHaveLength(3);
  });

  it("later hits never move the window: the expiry is the first hit's", async () => {
    const b = bucket();
    await allow(b, 5, 10);
    const first = mem().exp.get(`rate:${b}`);
    await new Promise((r) => setTimeout(r, 5));
    await allow(b, 5, 10);
    expect(mem().exp.get(`rate:${b}`)).toBe(first);
  });

  it("an expiry call that fails does not fail the request, and the next hit repairs it", async () => {
    const b = bucket();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await allow(b, 18, 10)).toBe(true);
    mem().exp.delete(`rate:${b}`); // the first hit's expiry was lost
    vi.spyOn(db, "expireNx").mockRejectedValueOnce(new Error("redis_down"));
    expect(await allow(b, 18, 10)).toBe(true);
    expect(mem().exp.has(`rate:${b}`)).toBe(false);
    expect(await allow(b, 18, 10)).toBe(true);
    expect(mem().exp.has(`rate:${b}`)).toBe(true);
    expect(await db.get(`rate:${b}`)).toBe(3);
  });

  it("a store that refuses EXPIRE NX still gives every window an expiry, through the first hit's SET", async () => {
    const b = bucket();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "expireNx").mockRejectedValue(new Error("ERR syntax error"));
    expect(await allow(b, 18, 10)).toBe(true);
    expect(mem().exp.has(`rate:${b}`)).toBe(true);
    expect(await allow(b, 18, 10)).toBe(true);
    expect(await db.get(`rate:${b}`)).toBe(2);
  });
});

describe("db.expireNx", () => {
  it("memory store: sets an expiry only on a live key that has none", async () => {
    await db.expireNx("test:expire:absent", 10);
    expect(mem().exp.has("test:expire:absent")).toBe(false);
    await db.set("test:expire:kept", 1, 100);
    const kept = mem().exp.get("test:expire:kept");
    await db.expireNx("test:expire:kept", 10);
    expect(mem().exp.get("test:expire:kept")).toBe(kept);
    await db.incrby("test:expire:bare", 3);
    await db.expireNx("test:expire:bare", 10);
    expect(mem().exp.get("test:expire:bare")).toBeGreaterThan(Date.now());
    expect(await db.get("test:expire:bare")).toBe(3);
  });

  it("Upstash store: sends EXPIRE with the NX option", async () => {
    const calls: unknown[][] = [];
    vi.doMock("@upstash/redis", () => ({ Redis: class { expire(...a: unknown[]) { calls.push(a); return Promise.resolve(1); } } }));
    vi.stubEnv("KV_REST_API_URL", "https://upstash.test.example");
    vi.stubEnv("KV_REST_API_TOKEN", "test-token");
    vi.resetModules();
    const fresh = await import("@/lib/db");
    expect(fresh.usingPersistentStore).toBe(true);
    await fresh.db.expireNx("rate:x", 10);
    expect(calls).toEqual([["rate:x", 10, "NX"]]);
  });
});
