import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Rules 989-990 (2026-10-10): the site left Vercel for Hostinger on 2026-10-08, so nothing in the repository may still
 * steer a Vercel project. The cron schedule is `crons.json`, a list no host reads (hPanel's cron jobs are entered by hand
 * to match it); `vercel.json` is gone, so a still-connected Vercel project has no crons to run against its own Upstash.
 * Rule 987 (the fallback origin) is pinned in tests/origin.test.ts, rule 988 (CI on pull requests only) in
 * tests/ci-workflow.test.ts.
 */
type Cron = { path: string; schedule: string };
const crons = (JSON.parse(readFileSync("crons.json", "utf8")) as { crons: Cron[] }).crons;
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs|json|md)$/.test(n) ? [p] : [];
});

describe("rule 989: the cron schedule is crons.json, and no vercel.json", () => {
  it("there is no vercel.json, and nothing under src/ points at one", () => {
    expect(existsSync("vercel.json")).toBe(false);
    const hits = files("src").filter((p) => /vercel\.json/.test(readFileSync(p, "utf8")));
    expect(hits, `vercel.json named in: ${hits.join(", ")}`).toEqual([]);
  });

  it("lists every GET cron route and only those; Reem's POST tick is not in it", () => {
    const routes = readdirSync(join("src", "app", "api", "cron")).filter((d) => d !== "secretary").map((d) => `/api/cron/${d}`).sort();
    expect([...new Set(crons.map((c) => c.path))].sort()).toEqual(routes);
    for (const c of crons) {
      const src = readFileSync(join("src", "app", c.path.slice(1), "route.ts"), "utf8");
      expect(src, c.path).toMatch(/export async function GET\(/);
    }
    expect(crons.map((c) => c.path)).not.toContain("/api/cron/secretary");
  });

  it("every entry is a five-field schedule with fixed minute and hour, and no entry repeats", () => {
    for (const c of crons) {
      const f = c.schedule.split(" ");
      expect(f, c.path).toHaveLength(5);
      expect(f[0], c.path).toMatch(/^\d+$/);
      expect(f[1], c.path).toMatch(/^\d+$/);
    }
    expect(new Set(crons.map((c) => `${c.path} ${c.schedule}`)).size).toBe(crons.length);
  });
});

describe("rule 990: live moves from VERCEL_ENV to APP_ENV", () => {
  it("variables.md tells the founder to set APP_ENV=production on live and drop the VERCEL_ENV stopgap", () => {
    const row = readFileSync("docs/system/variables.md", "utf8").split("\n").find((l) => l.startsWith("| `VERCEL_ENV` |")) ?? "";
    expect(row).toMatch(/APP_ENV=production/);
    expect(row).toMatch(/hPanel/);
  });

  it("deploy-env.ts still reads VERCEL_ENV=production until that switch (expand, then contract)", () => {
    const src = readFileSync("src/lib/deploy-env.ts", "utf8");
    expect(src).toMatch(/vercel === "production" \|\| app === "production"/);
  });
});
