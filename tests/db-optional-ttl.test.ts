import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";

/**
 * Pre-flight ruling 2 of customer passkeys (docs/specs/2026-10-20-passkeys.md, rules 2404 and 2422): `setNx` and
 * `setXx` take an optional TTL. Without one the key gets no expiry (the passkey reverse index and the set, written with
 * SET NX and SET XX, live until a remove or a wipe), in both stores. A TTL of 0 used to be an Upstash error or an instant
 * expiry in the memory store.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@upstash/redis");
  vi.unstubAllEnvs();
  vi.resetModules();
});

let n = 0;
const key = () => `test:optttl:${++n}:${Date.now()}`;

describe("memory store", () => {
  it("setNx without a TTL writes a key with no expiry; with one, the expiry is set", async () => {
    const a = key();
    expect(await db.setNx(a, "v")).toBe(true);
    expect(await db.ttl(a)).toBe(-1);
    expect(await db.setNx(a, "w")).toBe(false);
    expect(await db.get(a)).toBe("v");
    const b = key();
    expect(await db.setNx(b, "v", 100)).toBe(true);
    expect(await db.ttl(b)).toBeGreaterThan(90);
  });

  it("setXx without a TTL overwrites and clears the expiry (as SET XX without EX does); a missing key stays missing", async () => {
    const a = key();
    expect(await db.setXx(a, "v")).toBe(false);
    expect(await db.get(a)).toBeNull();
    await db.set(a, "v", 100);
    expect(await db.setXx(a, "w")).toBe(true);
    expect(await db.get(a)).toBe("w");
    expect(await db.ttl(a)).toBe(-1);
    expect(await db.setXx(a, "x", 50)).toBe(true);
    expect(await db.ttl(a)).toBeGreaterThan(40);
  });
});

describe("Upstash store", () => {
  it("sends SET NX / SET XX without EX when no TTL is given, and with EX when one is", async () => {
    const calls: unknown[][] = [];
    vi.doMock("@upstash/redis", () => ({ Redis: class { set(...a: unknown[]) { calls.push(a); return Promise.resolve("OK"); } } }));
    vi.stubEnv("KV_REST_API_URL", "https://upstash.test.example");
    vi.stubEnv("KV_REST_API_TOKEN", "test-token");
    vi.resetModules();
    const fresh = await import("@/lib/db");
    expect(fresh.usingPersistentStore).toBe(true);
    expect(await fresh.db.setNx("pkcred:x", "p_1")).toBe(true);
    expect(await fresh.db.setNx("k", "v", 60)).toBe(true);
    expect(await fresh.db.setXx("passkeys:p_1", { v: 1 })).toBe(true);
    expect(await fresh.db.setXx("k", "v", 60)).toBe(true);
    expect(calls).toStrictEqual([
      ["pkcred:x", "p_1", { nx: true }],
      ["k", "v", { nx: true, ex: 60 }],
      ["passkeys:p_1", { v: 1 }, { xx: true }],
      ["k", "v", { xx: true, ex: 60 }],
    ]);
  });
});
