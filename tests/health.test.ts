import { afterEach, describe, expect, it, vi } from "vitest";

describe("the health route (rule 676)", () => {
  const get = async (ip: string) => (await import("@/app/api/health/route")).GET(new Request("https://x.example/api/health", { headers: { "x-real-ip": ip } }));
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("answers without a session with exactly ok, commit, built and no-store", async () => {
    vi.stubEnv("BUILD_COMMIT", "a".repeat(40)); vi.stubEnv("BUILD_TIME", "2026-10-08T00:00:00.000Z");
    const r = await get("10.1.0.1");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ ok: true, commit: "a".repeat(40), built: "2026-10-08T00:00:00.000Z" });
  });
  it("61st call in a minute from one IP is 429", async () => {
    for (let i = 0; i < 60; i++) await get("10.1.0.2");
    const r = await get("10.1.0.2");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(await r.json()).toEqual({ ok: false, error: "slow_down" });
  });
  it("still 200 when the limiter's store throws", async () => {
    const { db } = await import("@/lib/db");
    vi.spyOn(db, "incrby").mockRejectedValue(new Error("down"));
    expect((await get("10.1.0.3")).status).toBe(200);
  });
  it("next.config sets a commit sha or unknown, and a build time", async () => {
    const env = (await import("../next.config")).default.env!;
    expect(env.BUILD_COMMIT).toMatch(/^([0-9a-f]{40}|unknown)$/);
    expect(Number.isNaN(Date.parse(env.BUILD_TIME!))).toBe(false);
  });
});
