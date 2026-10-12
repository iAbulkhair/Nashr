import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { db } from "@/lib/db";
import { CRON_JOBS, CRON_MAX_AGE_SEC, cronStatuses, recordCronRun } from "@/lib/cron-heartbeat";

/**
 * Rules 1011-1019: the health route can say the store answers, the cron heartbeats say when a scheduled job stopped,
 * and CI builds the way thakeen.com builds. docs/system/tests/1011-monitoring-ci-parity.md lists the rules.
 */
const SECRET = "cron-secret-abcdef-0123";
const health = async (query = "", headers: Record<string, string> = {}, ip = "10.9.0.1") =>
  (await import("@/app/api/health/route")).GET(new Request(`https://x.example/api/health${query}`, { headers: { "x-forwarded-for": ip, ...headers } }));
const bearer = { authorization: `Bearer ${SECRET}` };
let n = 0;
const freshIp = () => `10.9.${Math.floor(++n / 200)}.${(n % 200) + 1}`;

beforeEach(() => { vi.stubEnv("CRON_SECRET", SECRET); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("rule 1011: /api/health stays as it was, and ?store=1 adds the store's answer", () => {
  it("without a query it is exactly ok, commit, built and never touches the heartbeat or the ping", async () => {
    vi.stubEnv("BUILD_COMMIT", "b".repeat(40)); vi.stubEnv("BUILD_TIME", "2026-10-11T00:00:00.000Z");
    const get = vi.spyOn(db, "get");
    const r = await health("", {}, freshIp());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, commit: "b".repeat(40), built: "2026-10-11T00:00:00.000Z" });
    expect(get).not.toHaveBeenCalled();
  });
  it("?store=1 is public, reads one key, and adds only { ok, ms } for the store", async () => {
    const get = vi.spyOn(db, "get");
    const r = await health("?store=1", {}, freshIp());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(Object.keys(body).sort()).toEqual(["built", "commit", "ok", "store"]);
    expect(body.ok).toBe(true);
    expect(Object.keys(body.store).sort()).toEqual(["ms", "ok"]);
    expect(body.store.ok).toBe(true);
    expect(typeof body.store.ms).toBe("number");
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("is 503 with ok:false when the read fails, and names neither the key, the host nor the error", async () => {
    vi.spyOn(db, "get").mockRejectedValue(new Error("https://secret-host.upstash.io key=health:ping token=abc"));
    const r = await health("?store=1", {}, freshIp());
    expect(r.status).toBe(503);
    const text = JSON.stringify(await r.json());
    expect(JSON.parse(text).ok).toBe(false);
    expect(JSON.parse(text).store.ok).toBe(false);
    expect(text).not.toMatch(/upstash|health:ping|token|secret-host/);
  });
  it("is 503 when the read hangs past two seconds", async () => {
    vi.spyOn(db, "get").mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const res = health("?store=1", {}, freshIp());
      await vi.advanceTimersByTimeAsync(2100);
      const r = await res;
      expect(r.status).toBe(503);
      expect((await r.json()).store.ok).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("shares the route's per-IP limiter: the 61st call in a minute is 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < 60; i++) await health("?store=1", {}, ip);
    expect((await health("?store=1", {}, ip)).status).toBe(429);
  });
});

describe("rule 1012: ?crons=1 needs the cron bearer", () => {
  it("is 401 with no bearer, a wrong bearer, and the same text without the word Bearer", async () => {
    for (const h of [{} as Record<string, string>, { authorization: "Bearer wrong-secret-abcdef-0123" }, { authorization: SECRET + "x" }]) {
      const r = await health("?crons=1", h, freshIp());
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ ok: false });
    }
  });
  it("fails closed when CRON_SECRET is unset, even for an empty bearer", async () => {
    vi.stubEnv("CRON_SECRET", "");
    for (const h of [{} as Record<string, string>, { authorization: "Bearer " }, { authorization: "Bearer undefined" }]) expect((await health("?crons=1", h, freshIp())).status).toBe(401);
  });
  it("counts against the per-IP limiter before the secret is compared", async () => {
    const ip = freshIp();
    for (let i = 0; i < 60; i++) await health("?crons=1", {}, ip);
    expect((await health("?crons=1", bearer, ip)).status).toBe(429);
  });
  it("the heartbeat detail is never in the public answer", async () => {
    await recordCronRun("daily");
    const body = await (await health("?store=1", {}, freshIp())).json();
    expect(body.crons).toBeUndefined();
  });
});

describe("rule 1013: ?crons=1 answers 503 when the store is down or a cron is late", () => {
  it("lists never-run jobs as waiting, not stale, and answers 200", async () => {
    await Promise.all(CRON_JOBS.map((j) => db.del(`cronbeat:${j}`)));
    const r = await health("?crons=1", bearer, freshIp());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.crons.stale).toEqual([]);
    expect(body.crons.waiting.sort()).toEqual([...CRON_JOBS].sort());
  });
  it("is 503 and names the late job once a heartbeat is older than its limit", async () => {
    await Promise.all(CRON_JOBS.map((j) => recordCronRun(j)));
    await recordCronRun("daily", Date.now() - (CRON_MAX_AGE_SEC.daily + 60) * 1000);
    const r = await health("?crons=1", bearer, freshIp());
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.crons.stale).toEqual(["daily"]);
    expect(body.crons.jobs.find((j: { job: string }) => j.job === "daily").status).toBe("stale");
  });
  it("is 200 when every heartbeat is inside its limit", async () => {
    await Promise.all(CRON_JOBS.map((j) => recordCronRun(j)));
    const r = await health("?crons=1", bearer, freshIp());
    expect(r.status).toBe(200);
    expect((await r.json()).crons.stale).toEqual([]);
  });
  it("is 503 with an empty job list when the store is down", async () => {
    vi.spyOn(db, "get").mockRejectedValue(new Error("down"));
    const r = await health("?crons=1", bearer, freshIp());
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.store.ok).toBe(false);
    expect(body.crons.jobs).toEqual([]);
  });
  it("a job exactly at its limit is still on time, one second past is late", async () => {
    const now = Date.now();
    await recordCronRun("stores", now - CRON_MAX_AGE_SEC.stores * 1000);
    expect((await cronStatuses(now)).find((s) => s.job === "stores")?.status).toBe("ok");
    await recordCronRun("stores", now - (CRON_MAX_AGE_SEC.stores + 1) * 1000);
    expect((await cronStatuses(now)).find((s) => s.job === "stores")?.status).toBe("stale");
  });
});

describe("rule 1014: a cron that finishes records its heartbeat, and only then", () => {
  const call = (r: { GET: (req: Request) => Promise<Response> }, auth?: string, path = "x") => r.GET(new Request(`https://nashr.test/api/cron/${path}`, { headers: auth ? { authorization: auth } : {} }));
  const beat = async (job: string) => db.get<number>(`cronbeat:${job}`);

  it("stores, weekly, daily and evening record after a 200, with a fresh time", async () => {
    const routes: [string, { GET: (req: Request) => Promise<Response> }][] = [
      ["stores", await import("@/app/api/cron/stores/route")],
      ["weekly", await import("@/app/api/cron/weekly/route")],
      ["daily", await import("@/app/api/cron/daily/route")],
      ["evening", await import("@/app/api/cron/evening/route")],
    ];
    for (const [job, route] of routes) {
      await db.del(`cronbeat:${job}`);
      const before = Date.now();
      const r = await call(route, `Bearer ${SECRET}`, job);
      expect(r.status, job).toBe(200);
      expect(Number(await beat(job)), job).toBeGreaterThanOrEqual(before);
    }
  });
  it("a refused call (401) records nothing", async () => {
    const stores = await import("@/app/api/cron/stores/route");
    await db.del("cronbeat:stores");
    expect((await call(stores, "Bearer wrong-secret-abcdef-0123", "stores")).status).toBe(401);
    expect(await beat("stores")).toBeNull();
  });
  it("a golden run that did not start (409) records nothing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const golden = await import("@/app/api/cron/golden/route");
    await db.del("cronbeat:golden");
    const r = await call(golden, `Bearer ${SECRET}`, "golden");
    if (r.status === 409) expect(await beat("golden")).toBeNull();
    else expect(r.status).toBe(200);
  });
  it("a store that fails the write does not fail the recorder", async () => {
    vi.spyOn(db, "set").mockRejectedValue(new Error("down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordCronRun("media")).resolves.toBeUndefined();
  });
  it("every cron route imports and calls the recorder with its own job name, and the job list matches the routes", () => {
    const dirs = readdirSync("src/app/api/cron", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(dirs).toEqual([...CRON_JOBS].sort());
    for (const job of dirs) {
      const src = readFileSync(`src/app/api/cron/${job}/route.ts`, "utf8");
      expect(src, job).toMatch(/from "@\/lib\/cron-heartbeat"/);
      expect(src, job).toContain(`recordCronRun("${job}")`);
    }
  });
  it("the crons.json schedules and the heartbeat limits cover the same jobs, and each limit exceeds the schedule's gap", () => {
    const paths = new Set((JSON.parse(readFileSync("crons.json", "utf8")).crons as { path: string }[]).map((c) => c.path.replace("/api/cron/", "")));
    for (const p of paths) expect(CRON_JOBS, p).toContain(p);
    // The daily jobs run every 24 hours, weekly ones every 7 days, stores every 12 hours, the tick every 15 minutes.
    expect(CRON_MAX_AGE_SEC.daily).toBeGreaterThan(86400);
    expect(CRON_MAX_AGE_SEC.weekly).toBeGreaterThan(7 * 86400);
    expect(CRON_MAX_AGE_SEC.stores).toBeGreaterThan(12 * 3600);
    expect(CRON_MAX_AGE_SEC.secretary).toBeGreaterThan(15 * 60);
  });
});

describe("rule 1015: the founder's Usage page shows the heartbeats", () => {
  it("the overview carries one entry per job, and no new route was added for it", async () => {
    await Promise.all(CRON_JOBS.map((j) => recordCronRun(j)));
    const { overview } = await import("@/lib/admin-stats");
    const ov = await overview();
    expect(ov.crons.map((c) => c.job).sort()).toEqual([...CRON_JOBS].sort());
    expect(ov.crons.every((c) => c.status === "ok")).toBe(true);
    expect(readdirSync("src/app/api/admin").sort()).not.toContain("crons");
    const usage = readFileSync("src/components/admin/Usage.tsx", "utf8");
    expect(usage).toContain("ov.crons");
    expect(usage).toContain("O.cronStale");
  });
  it("a store that cannot be read leaves the overview with an empty list, not an error", async () => {
    const real = db.mget.bind(db);
    vi.spyOn(db, "mget").mockImplementation((keys: string[]) => (keys[0]?.startsWith("cronbeat:") ? Promise.reject(new Error("down")) : real(keys)));
    const { overview } = await import("@/lib/admin-stats");
    expect((await overview()).crons).toEqual([]);
  });
});

describe("rule 1016: the founder's uptime monitor is documented by name, with no account in code", () => {
  const flows = readFileSync("docs/system/flows.md", "utf8");
  const section = flows.slice(flows.indexOf("## 62. Monitoring"));
  it("names the URL, the keyword, the interval and the alert address", () => {
    expect(section).toContain("/api/health?store=1");
    expect(section).toContain('"ok":true');
    expect(section).toContain("every 5 minutes");
    expect(section).toContain("hello@thakeen.com");
    expect(section).toContain("/api/health?crons=1");
  });
  it("the code holds no monitoring vendor, key or address", () => {
    const src = readFileSync("src/app/api/health/route.ts", "utf8") + readFileSync("src/lib/cron-heartbeat.ts", "utf8");
    expect(src).not.toMatch(/uptimerobot|betterstack|better stack|pingdom|statuscake|hello@thakeen/i);
  });
});

describe("rule 1017: CI builds the way Hostinger builds", () => {
  const yml = readFileSync(".github/workflows/ci.yml", "utf8");
  const step = (name: string) => {
    const at = yml.indexOf(`      - name: ${name}\n`);
    const next = yml.indexOf("\n      - ", at + 1);
    return yml.slice(at, next < 0 ? yml.length : next);
  };
  it("sets up Node 22, the version thakeen.com builds on", () => {
    expect(yml).toMatch(/uses: actions\/setup-node@v4\n\s+with:\n\s+node-version: 22\n/);
    expect(yml).not.toMatch(/node-version: 24/);
  });
  it("the Build step runs the package script thakeen.com runs, which is next build --webpack", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["build:hostinger"]).toBe("next build --webpack");
    expect(step("Build")).toMatch(/run: npm run build:hostinger\n?$/);
    expect(step("Build")).toMatch(/if: steps\.scope\.outputs\.build == 'true'/);
  });
  it("the end-to-end server is built the same way (rule 1207: in CI it starts the Build step's build)", () => {
    expect(readFileSync("playwright.config.ts", "utf8")).toMatch(/command: webServerCommand\(PORT, \{ ci: isCI, prebuilt: hasBuild\(\) \}\)/);
    expect(readFileSync("e2e/web-server.ts", "utf8")).toMatch(/`npm run build:hostinger && \$\{start\}`/);
  });
  it("adds no job and no matrix: one job, and the steps are the ones that were there", () => {
    const jobs = yml.slice(yml.indexOf("\njobs:\n"));
    expect(jobs.match(/^ {2}[a-z][\w-]*:\s*$/gm)).toEqual(["  check:"]);
    expect(yml).not.toMatch(/\bmatrix:/);
    expect(yml.match(/^\s+run: .*\bbuild\b.*$/gm)).toEqual(["        run: npm run build:hostinger"]);
  });
});

describe("rule 1018: no store command in a loop", () => {
  it("the heartbeats are read with one mget and written with one set per job", () => {
    const src = readFileSync("src/lib/cron-heartbeat.ts", "utf8");
    expect(src.match(/await db\./g)?.length).toBe(2);
    expect(src).toMatch(/db\.mget<[^>]+>\(CRON_JOBS\.map\(key\)\)/);
    const route = readFileSync("src/app/api/health/route.ts", "utf8");
    expect(route).not.toMatch(/for \(|\.map\(async|forEach/);
  });
});

describe("rule 1019: the docs name the change", () => {
  const read = (f: string) => readFileSync(`docs/system/${f}`, "utf8");
  it("permissions row 153 names both query forms and the bearer", () => {
    const row = read("permissions.md").split("\n").find((l) => l.startsWith("| 153 |")) ?? "";
    expect(row).toContain("?store=1");
    expect(row).toContain("?crons=1");
    expect(row).toContain("sameSecret");
  });
  it("architecture names the heartbeat file, and variables lists the new use of CRON_SECRET and no new variable", () => {
    expect(read("architecture.md")).toContain("src/lib/cron-heartbeat.ts");
    expect(read("variables.md")).toContain("/api/health?crons=1");
    const src = readFileSync("src/lib/cron-heartbeat.ts", "utf8") + readFileSync("src/app/api/health/route.ts", "utf8");
    expect([...new Set(src.match(/process\.env\.[A-Z_]+/g))].sort()).toEqual(["process.env.BUILD_COMMIT", "process.env.BUILD_TIME", "process.env.CRON_SECRET"]);
  });
  it("the coverage file exists and lists rules 1011 to 1019", () => {
    const f = readFileSync("docs/system/tests/1011-monitoring-ci-parity.md", "utf8");
    for (let r = 1011; r <= 1019; r++) expect(f).toContain(`| ${r} |`);
  });
});
