import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("the probe's health answer (final review M6)", () => {
  it("takes the commit only from the health shape { ok: true, commit, built }", async () => {
    const { healthCommit } = await import("../scripts/probe.mjs");
    expect(healthCommit({ ok: true, commit: "abc123", built: "2026-10-08T10:00:00Z" })).toBe("abc123");
    expect(healthCommit({ ok: true, commit: "unknown", built: "unknown" })).toBe("unknown");
    // A holding page, an HTML body, a JSON body of another shape, ok: false: none of them is the app answering.
    for (const body of [null, undefined, "", "<html>", [], {}, { ok: true }, { ok: true, commit: "" , built: "x" }, { ok: true, commit: 7, built: "x" },
      { ok: false, commit: "abc", built: "x" }, { ok: true, commit: "abc" }, { ok: true, commit: "abc", built: 1 }])
      expect(healthCommit(body), JSON.stringify(body)).toBeNull();
  });
  it("counts a 200 that is not the health answer as a failure, not as success with no commit", async () => {
    const { summarize } = await import("../scripts/probe.mjs");
    const s = [
      { t: 0, status: 200, ms: 10, commit: "a" }, { t: 1, status: 200, ms: 10, commit: null },
      { t: 2, status: 200, ms: 10, commit: null }, { t: 3, status: 200, ms: 10, commit: "a" },
    ];
    expect(summarize(s)).toEqual({ longestFailRun: 2, slowestMs: 10, commitChangedAt: null, throttled: 0 });
  });
});

describe("which origins the release scripts talk to (final review I5)", () => {
  it("allows exactly live, staging and a local server, and says which is which", async () => {
    const { classifyOrigin } = await import("../scripts/staging-cookie.mjs");
    expect(classifyOrigin("https://thakeen.com")).toEqual({ origin: "https://thakeen.com", kind: "live" });
    expect(classifyOrigin("https://thakeen.com/")).toEqual({ origin: "https://thakeen.com", kind: "live" });
    expect(classifyOrigin("https://staging.thakeen.com")).toEqual({ origin: "https://staging.thakeen.com", kind: "staging" });
    expect(classifyOrigin("http://localhost:3000")).toEqual({ origin: "http://localhost:3000", kind: "local" });
    expect(classifyOrigin("http://127.0.0.1:3100")).toEqual({ origin: "http://127.0.0.1:3100", kind: "local" });
  });
  it("refuses every other origin: a typo, www, plain http, a look-alike host, a path, a port, a user part", async () => {
    const { classifyOrigin } = await import("../scripts/staging-cookie.mjs");
    for (const o of ["http://thakeen.com", "https://www.thakeen.com", "https://staging.thakeen.com.evil.example", "https://thakeen.co",
      "https://staging.thakeen.co", "https://thakeen.com/ar", "https://staging.thakeen.com/api/health", "https://thakeen.com:444",
      "https://thakeen.com@evil.example", "https://evil.example/https://thakeen.com", "http://staging.thakeen.com", "https://Thakeen.com",
      "http://localhost", "http://localhost:3000/ar", "https://localhost:3000", "http://localhost:99999", "http://localhost:3000@evil.example",
      "http://127.0.0.1", "http://127.0.0.2:3000", "http://localhost.evil.example:3000", "", " https://thakeen.com", "thakeen.com"])
      expect(classifyOrigin(o), o).toBeNull();
    expect(classifyOrigin(undefined)).toBeNull();
  });
  // A name under the reserved .example TLD never resolves, so a script that did not refuse it would fail on DNS, not reach a host.
  const run = (script: string, args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, cwd: process.cwd() });
  it("smoke.mjs refuses a refused origin with exit 2 and a message, before any request", () => {
    const r = run("scripts/smoke.mjs", ["https://staging.thakeen.com.evil.example"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("https://thakeen.com");
    expect(r.stderr).toContain("https://staging.thakeen.com");
    expect(r.stdout).toBe("");
  });
  it("probe.mjs refuses a refused origin with exit 2 and a message, before any request", () => {
    const r = run("scripts/probe.mjs", ["https://staging.thakeen.com.evil.example", "5"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("https://staging.thakeen.com");
    expect(r.stdout).toBe("");
  });
});

describe("the access code and the other values of .smoke.local (final review I2)", () => {
  it("reads KEY=value lines, skipping blanks, comments and lines without a key", async () => {
    const { parseLocal } = await import("../scripts/staging-cookie.mjs");
    expect(parseLocal("# note\n\nSTAGING_ACCESS_CODE = abc=def \r\nSMOKE_EMAIL=a@b.example\nnokey\n=novalue\n  # x=y\n"))
      .toEqual({ STAGING_ACCESS_CODE: "abc=def", SMOKE_EMAIL: "a@b.example" });
  });
  it("a missing file is an empty map; a present one is read", async () => {
    const { readLocal } = await import("../scripts/staging-cookie.mjs");
    const dir = mkdtempSync(join(tmpdir(), "smoke-local-"));
    expect(readLocal(join(dir, "absent"))).toEqual({});
    writeFileSync(join(dir, ".smoke.local"), "STAGING_ACCESS_CODE=from-file\n");
    expect(readLocal(join(dir, ".smoke.local"))).toEqual({ STAGING_ACCESS_CODE: "from-file" });
  });
  it("an environment variable wins over the file, and an empty one does not", async () => {
    const { valueOf } = await import("../scripts/staging-cookie.mjs");
    expect(valueOf("K", { K: "file" }, { K: "env" })).toBe("env");
    expect(valueOf("K", { K: "file" }, { K: "" })).toBe("file");
    expect(valueOf("K", {}, {})).toBeUndefined();
  });

  const start = async (args: string[], env: Record<string, string>, local: Record<string, string>) => {
    const { probeStart } = await import("../scripts/probe.mjs");
    const cookieFn = vi.fn(async (_origin: string, code: string | undefined) => (code === "right" ? "thakeen_staging=tok" : null));
    return { r: await probeStart(args, { env, local, cookieFn }), cookieFn };
  };
  it("on staging with no code from the environment or the file it stops at once, naming both places", async () => {
    const { r, cookieFn } = await start(["https://staging.thakeen.com", "300"], {}, {});
    expect(r.stop?.exit).toBe(2);
    expect(r.stop?.message).toMatch(/STAGING_ACCESS_CODE/);
    expect(r.stop?.message).toMatch(/\.smoke\.local/);
    expect(cookieFn).not.toHaveBeenCalled();
  });
  it("on staging it uses the code from .smoke.local when the environment has none, and the environment's when both do", async () => {
    const fromFile = await start(["https://staging.thakeen.com", "300"], {}, { STAGING_ACCESS_CODE: "right" });
    expect(fromFile.r.stop).toBeNull();
    expect(fromFile.r.headers).toEqual({ Cookie: "thakeen_staging=tok" });
    expect(fromFile.cookieFn).toHaveBeenCalledWith("https://staging.thakeen.com", "right");
    const both = await start(["https://staging.thakeen.com", "300"], { STAGING_ACCESS_CODE: "right" }, { STAGING_ACCESS_CODE: "stale" });
    expect(both.cookieFn).toHaveBeenCalledWith("https://staging.thakeen.com", "right");
  });
  it("a code the route does not accept stops with exit 1", async () => {
    const { r } = await start(["https://staging.thakeen.com", "300"], { STAGING_ACCESS_CODE: "wrong" }, {});
    expect(r.stop?.exit).toBe(1);
    expect(r.stop?.message).toMatch(/gave no cookie/);
  });
  it("on live the code is neither needed nor sent; on a local server it is optional", async () => {
    const live = await start(["https://thakeen.com", "300"], { STAGING_ACCESS_CODE: "right" }, {});
    expect(live.r.stop).toBeNull();
    expect(live.r.headers).toBeUndefined();
    expect(live.cookieFn).not.toHaveBeenCalled();
    const local = await start(["http://localhost:3000", "30"], {}, {});
    expect(local.r.stop).toBeNull();
    expect(local.r.headers).toBeUndefined();
    expect(local.cookieFn).not.toHaveBeenCalled();
  });
  it("a refused origin or a missing duration stops with exit 2 before the code is used", async () => {
    for (const args of [["https://staging.thakeen.co", "300"], ["http://thakeen.com", "300"], ["https://staging.thakeen.com"], ["https://staging.thakeen.com", "0"], []]) {
      const { r, cookieFn } = await start(args, { STAGING_ACCESS_CODE: "right" }, {});
      expect(r.stop?.exit, args.join(" ")).toBe(2);
      expect(cookieFn).not.toHaveBeenCalled();
    }
  });
});
