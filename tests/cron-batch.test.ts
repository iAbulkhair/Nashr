import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastSundayUtc, runCronBatch } from "@/lib/cron-batch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req = (chain = 0) => new Request(`https://nashr.example/api/cron/weekly${chain ? `?chain=${chain}` : ""}`, { headers: { authorization: "Bearer test" } });
const items = Array.from({ length: 10 }, (_, i) => `user${i}`);
let period = 0;
let calls: string[] = [];

beforeEach(() => {
  period++;
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string) => { calls.push(String(u)); return new Response("{}"); }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("runCronBatch", () => {
  it("respects the concurrency limit and serves everyone when the budget allows", async () => {
    let active = 0, peak = 0;
    const r = await runCronBatch({ job: "t", period: `p${period}`, items, id: (x) => x, run: async () => { active++; peak = Math.max(peak, active); await sleep(20); active--; return "ok"; }, concurrency: 3, startBudgetMs: 5000, markerTtlSeconds: 60, req: req() });
    expect(peak).toBe(3);
    expect(r).toMatchObject({ total: 10, processed: 10, failed: 0, remaining: 0, chained: false });
    expect(calls).toHaveLength(0);
  });
  it("hands the leftovers to a new invocation when the start budget runs out, then skips whoever is done", async () => {
    const run = async () => { await sleep(60); return "ok"; };
    const first = await runCronBatch({ job: "t", period: `p${period}`, items, id: (x) => x, run, concurrency: 2, startBudgetMs: 100, markerTtlSeconds: 60, req: req() });
    expect(first.processed).toBeLessThan(10);
    expect(first.chained).toBe(true);
    await sleep(10);
    expect(calls[0]).toBe("https://nashr.example/api/cron/weekly?chain=1");
    const second = await runCronBatch({ job: "t", period: `p${period}`, items, id: (x) => x, run, concurrency: 5, startBudgetMs: 5000, markerTtlSeconds: 60, req: req(1) });
    expect(second.alreadyDone).toBe(first.processed);
    expect(second.processed).toBe(10 - first.processed);
    expect(second.remaining).toBe(0);
  });
  it("isolates a failing user, retries it once more, then stops retrying", async () => {
    const seen: string[] = [];
    const run = async (id: string) => { seen.push(id); if (id === "user3") throw new Error("boom"); return "ok"; };
    const o = { job: "t", period: `p${period}`, items, id: (x: string) => x, run, concurrency: 4, startBudgetMs: 5000, markerTtlSeconds: 60 };
    const a = await runCronBatch({ ...o, req: req() });
    expect(a).toMatchObject({ processed: 9, failed: 1, chained: true });
    const b = await runCronBatch({ ...o, req: req(1) });
    expect(b).toMatchObject({ alreadyDone: 9, processed: 0, failed: 1 });
    const c = await runCronBatch({ ...o, req: req(2) });
    expect(c).toMatchObject({ processed: 0, failed: 0, remaining: 0, chained: false });
    expect(seen.filter((x) => x === "user3")).toHaveLength(2);
  });
  it("does not spin the chain for users that only answer retry, and stops at the chain cap", async () => {
    const o = { job: "t", period: `p${period}`, items: ["a", "b"], id: (x: string) => x, concurrency: 2, startBudgetMs: 5000, markerTtlSeconds: 60 };
    const locked = await runCronBatch({ ...o, run: async () => "retry:locked", req: req() });
    expect(locked).toMatchObject({ processed: 0, remaining: 2, chained: false });
    const capped = await runCronBatch({ ...o, period: `cap${period}`, run: async () => { throw new Error("x"); }, req: req(30) });
    expect(capped.chained).toBe(false);
  });
});

describe("lastSundayUtc", () => {
  it("keeps one period key from Sunday through the Tuesday catch-up", () => {
    expect(lastSundayUtc(new Date("2026-09-20T03:00:00Z"))).toBe("2026-09-20");
    expect(lastSundayUtc(new Date("2026-09-22T05:00:00Z"))).toBe("2026-09-20");
    expect(lastSundayUtc(new Date("2026-09-19T23:59:00Z"))).toBe("2026-09-13");
  });
});

/**
 * A chain hop continues from work the previous hop scheduled, which is no longer inside a request. `after()` throws
 * there, and the code falls back to firing the request itself. The test mock used to accept `after()` anywhere, so
 * this branch had never once been executed by a test even though it is the one that runs in production for hops
 * two and beyond.
 */
describe("continuing the chain outside a request scope", () => {
  it("fires the next hop directly when after() refuses", async () => {
    const { outsideRequestScope, settle } = await import("./helpers/session");
    const run = async () => { await sleep(60); return "ok"; };
    const r = await outsideRequestScope(() =>
      runCronBatch({ job: "t", period: `p${period}`, items, id: (x) => x, run, concurrency: 2, startBudgetMs: 100, markerTtlSeconds: 60, req: req() }),
    );
    // Without the fallback the throw from after() would escape and runCronBatch would reject, losing the report and
    // every remaining user with it. It resolves, and the hop went out.
    expect(r.chained, "there must be leftovers, or the fallback is never reached").toBe(true);
    await settle();
    expect(calls, "the fallback must fire the hop itself").toHaveLength(1);
    expect(calls[0]).toContain("chain=1");
  });
});
