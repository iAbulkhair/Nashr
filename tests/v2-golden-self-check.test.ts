import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rules 4830-4834 (docs/system/tests/4820-v2-staging-switch.md): the golden set's self-check mode. No model is called: the
 * agent, the judge and self-check are stubbed, so these tests pin how a run is built, labelled, compared and carried. The
 * flags are the real ones (all off), so SELF_CHECK comes on only through the staging list (rule 4820).
 */
const judge = vi.hoisted(() => ({ score: 80 }));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" }));
vi.mock("@/lib/noor", async (orig) => ({
  ...(await orig<typeof import("@/lib/noor")>()),
  generate: vi.fn(async () => [{ channel: "doc", title: "T", body: "draft ".repeat(30) }]),
}));
vi.mock("@/lib/judge", async (orig) => ({
  ...(await orig<typeof import("@/lib/judge")>()),
  scoreItems: vi.fn(async (_e: string, _b: unknown, _t: unknown, items: unknown[]) =>
    items.map(() => ({
      score: judge.score,
      dims: { completeness: 80, brand: 80, honesty: 80, language: 80, format: 80 },
      notes: "",
    })),
  ),
}));
vi.mock("@/lib/self-check", async (orig) => ({
  ...(await orig<typeof import("@/lib/self-check")>()),
  selfCheck: vi.fn(async (tasks: { body: string }[]) =>
    tasks.map((t, i) => ({
      ...t,
      body: t.body + " fixed",
      selfCheck: i === 0 ? { first: 60, rewritten: true } : { rewritten: false, skipped: "time" },
    })),
  ),
}));

import { GOLDEN_CASES, GOLDEN_EMAIL, runGolden } from "@/lib/golden";
import { selfCheck } from "@/lib/self-check";
import { generate } from "@/lib/noor";

const RAZAN = GOLDEN_CASES.filter(
  (c) => ["pricing_review", "unit_economics"].includes(c.type) || c.id.startsWith("razan-"),
);
const staging = () => {
  vi.stubEnv("APP_ENV", "staging");
  vi.stubEnv("V2_STAGING_FLAGS", "SELF_CHECK");
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(selfCheck).mockClear();
  judge.score = 80;
});

describe("rule 4830: a self-check run needs SELF_CHECK on for this host", () => {
  it("a plain run never calls self-check and carries no mark", async () => {
    const run = (await runGolden("manual", { agent: "razan" }))!;
    expect(selfCheck).not.toHaveBeenCalled();
    expect(run.selfCheck).toBeUndefined();
    expect(run.results.every((r) => r.selfCheck === undefined)).toBe(true);
  });

  it("asked for off staging (live), the run is a plain one", async () => {
    vi.stubEnv("V2_STAGING_FLAGS", "SELF_CHECK");
    const run = (await runGolden("manual", { agent: "razan", selfCheck: true }))!;
    expect(selfCheck).not.toHaveBeenCalled();
    expect(run.selfCheck).toBeUndefined();
  });
});

describe("rules 4831-4832: the items pass self-check before the judge, and the run is kept apart", () => {
  it("each case's items go through self-check with the golden meter and a deadline, and the judge reads the result", async () => {
    staging();
    judge.score = 50;
    const run = (await runGolden("manual", { agent: "razan", selfCheck: true }))!;
    expect(run.selfCheck).toBe(true);
    const mine = run.results.filter((r) => !r.carried);
    expect(mine.length).toBe(RAZAN.length);
    expect(selfCheck).toHaveBeenCalledTimes(RAZAN.length);
    const [tasks, ctx] = vi.mocked(selfCheck).mock.calls[0];
    expect(ctx.email).toBe(GOLDEN_EMAIL);
    expect(typeof ctx.deadline).toBe("number");
    expect(ctx.prefs).toEqual([]);
    expect(tasks.every((t) => t.status === "pending" && t.id.startsWith("golden-"))).toBe(true);
    for (const r of mine) {
      expect(r.items.every((i) => i.body.endsWith(" fixed"))).toBe(true);
      expect(r.selfCheck).toEqual({ first: 60, rewritten: 1, skipped: r.items.length - 1 });
    }
  });

  it("a self-check run carries no plain rows and has no deltas against plain runs", async () => {
    staging();
    const run = (await runGolden("manual", { agent: "razan", selfCheck: true }))!;
    // The previous self-check run (score 50) is its baseline, not the plain runs (80).
    expect(run.results.every((r) => r.agent === "razan" || r.carried)).toBe(true);
    expect(run.results.filter((r) => r.carried)).toEqual([]);
    expect(run.results.every((r) => r.delta === 30)).toBe(true);
  });

  it("the next plain run compares with the last plain run, not with a self-check run", async () => {
    judge.score = 80;
    const run = (await runGolden("manual", { agent: "razan" }))!;
    expect(run.selfCheck).toBeUndefined();
    expect(run.results.filter((r) => !r.carried).every((r) => r.delta === 0)).toBe(true);
    expect(generate).toHaveBeenCalled();
  });
});

describe("rule 4833: the console offers it only where SELF_CHECK is on", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  it("the route reports the switch, passes only a literal true and logs the mode", () => {
    const route = src("src/app/api/admin/golden/route.ts");
    expect(route).toMatch(/selfCheck: v2On\("SELF_CHECK"\)/);
    expect(route).toMatch(/selfCheck: b\.selfCheck === true/);
    expect(route).toMatch(/run\.selfCheck \? ":self-check" : ""/);
  });
  it("the panel shows the button only when the server says so, and resumes in the latest run's mode", () => {
    const panel = src("src/components/admin/GoldenPanel.tsx");
    expect(panel).toMatch(/\{data\?\.selfCheck && <button/);
    expect(panel).toMatch(/run\(true, !!latest\.selfCheck\)/);
  });
  it("the weekly cron stays a plain run", () => {
    expect(src("src/app/api/cron/golden/route.ts")).toMatch(/runGolden\("cron"\)/);
  });
});
