import { describe, expect, it, vi } from "vitest";

describe("probe summary", () => {
  it("counts the longest failure run, the slowest answer and the commit switch", async () => {
    const { summarize } = await import("../scripts/probe.mjs");
    const s = [
      { t: 0, status: 200, ms: 40, commit: "a" }, { t: 1, status: 502, ms: 900, commit: null },
      { t: 2, status: 0, ms: 3000, commit: null }, { t: 3, status: 200, ms: 1200, commit: "b" },
      { t: 4, status: 503, ms: 50, commit: null }, { t: 5, status: 200, ms: 30, commit: "b" },
    ];
    expect(summarize(s)).toEqual({ longestFailRun: 2, slowestMs: 3000, commitChangedAt: 3, throttled: 0 });
    expect(summarize([{ t: 0, status: 200, ms: 5, commit: "a" }]).commitChangedAt).toBeNull();
  });
  it("counts a 429 apart from failures: the limiter answering proves the process is up", async () => {
    const { summarize } = await import("../scripts/probe.mjs");
    const s = [
      { t: 0, status: 200, ms: 10, commit: "a" }, { t: 1, status: 502, ms: 20, commit: null },
      { t: 2, status: 429, ms: 10, commit: null }, { t: 3, status: 502, ms: 20, commit: null },
      { t: 4, status: 429, ms: 10, commit: null }, { t: 5, status: 200, ms: 10, commit: "a" },
    ];
    expect(summarize(s)).toEqual({ longestFailRun: 1, slowestMs: 20, commitChangedAt: null, throttled: 2 });
    expect(summarize([{ t: 0, status: 429, ms: 5, commit: null }]).longestFailRun).toBe(0);
  });
  it("paces under the health route's 60 a minute and leaves room for a smoke run", async () => {
    const { PROBE_INTERVAL_MS, paceDelay } = await import("../scripts/probe.mjs");
    expect(Math.floor(60_000 / PROBE_INTERVAL_MS) + 1).toBeLessThanOrEqual(51);
    expect(paceDelay(0)).toBe(PROBE_INTERVAL_MS);
    expect(paceDelay(PROBE_INTERVAL_MS + 1)).toBe(0);
  });
});

describe("the smoke health check against the route's limiter", () => {
  const res = (status: number, retryAfter?: string) => new Response("{}", { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
  const run = async (answers: Response[]) => {
    const { fetchRetryOnce } = await import("../scripts/smoke.mjs");
    const fetchImpl = vi.fn(async () => answers.shift()!);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const r = await fetchRetryOnce("https://x.example/api/health", {}, { fetchImpl, sleep });
    return { status: r.status, fetches: fetchImpl.mock.calls.length, sleeps: sleep.mock.calls.map((c) => c[0]) };
  };
  it("waits for Retry-After and asks once more", async () => {
    expect(await run([res(429, "2"), res(200)])).toEqual({ status: 200, fetches: 2, sleeps: [2000] });
  });
  it("gives up after one retry", async () => {
    expect(await run([res(429, "60"), res(429, "60"), res(200)])).toEqual({ status: 429, fetches: 2, sleeps: [60_000] });
  });
  it("neither waits nor retries for any other status", async () => {
    expect(await run([res(200)])).toEqual({ status: 200, fetches: 1, sleeps: [] });
    expect(await run([res(502), res(200)])).toEqual({ status: 502, fetches: 1, sleeps: [] });
  });
  it("waits a minute when the header is missing and never more than 65 seconds", async () => {
    expect((await run([res(429), res(200)])).sleeps).toEqual([60_000]);
    expect((await run([res(429, "900"), res(200)])).sleeps).toEqual([65_000]);
  });
});
