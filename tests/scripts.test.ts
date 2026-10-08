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

describe("the smoke checks that follow from how the test account was made", () => {
  const redirect = (to: string) => new Response(null, { status: 307, headers: { Location: to } });
  const home = async (answers: Record<string, Response>) => {
    const { appHomeProblem } = await import("../scripts/smoke.mjs");
    const asked: string[] = [];
    const problem = await appHomeProblem(async (path: string) => { asked.push(path); return answers[path] ?? new Response("", { status: 404 }); });
    return { problem, asked };
  };
  it("passes /ar/app at once when the account has a brand", async () => {
    expect(await home({ "/ar/app": new Response("", { status: 200 }) })).toEqual({ problem: undefined, asked: ["/ar/app"] });
  });
  it("follows the one redirect a fresh account gets (no brand yet) and wants 200 from /ar/app/start", async () => {
    const fresh = { "/ar/app": redirect("/ar/app/start"), "/ar/app/start": new Response("", { status: 200 }) };
    expect(await home(fresh)).toEqual({ problem: undefined, asked: ["/ar/app", "/ar/app/start"] });
    // The redirect may carry the full origin, as an absolute Location does.
    expect((await home({ ...fresh, "/ar/app": redirect("https://staging.example/ar/app/start") })).problem).toBeUndefined();
    expect((await home({ "/ar/app": redirect("/ar/app/start"), "/ar/app/start": new Response("", { status: 500 }) })).problem).toBe("got 307 to /ar/app/start, then 500 there");
  });
  it("fails a redirect to the login page (the session was not accepted) and any other status", async () => {
    expect(await home({ "/ar/app": redirect("/ar/app/login") })).toEqual({ problem: "got 307 to /ar/app/login", asked: ["/ar/app"] });
    expect((await home({ "/ar/app": new Response("", { status: 404 }) })).problem).toBe("got 404");
  });

  it("passes a chat that answered ok: true and nothing else", async () => {
    const { chatProblem } = await import("../scripts/smoke.mjs");
    expect(chatProblem(200, { ok: true })).toBeUndefined();
    expect(chatProblem(200, { ok: false })).toBe("got 200");
    expect(chatProblem(502, { ok: false, error: "chat_failed" })).toBe("got 502 chat_failed");
    expect(chatProblem(502, null)).toBe("got 502");
  });
  it("says why an ended trial or a used-up allowance fails, so it is not read as an outage", async () => {
    const { chatProblem } = await import("../scripts/smoke.mjs");
    expect(chatProblem(402, { ok: false, error: "trial_over" })).toMatch(/^got 402 trial_over: .*trial has ended.*paid plan.*variables\.md section 7/);
    expect(chatProblem(402, { ok: false, error: "chat_allowance" })).toMatch(/^got 402 chat_allowance: .*no chat messages left/);
    // An error name is never looked up as a property of the table itself.
    expect(chatProblem(400, { ok: false, error: "constructor" })).toBe("got 400 constructor");
  });
});
