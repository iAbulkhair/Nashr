import { describe, expect, it } from "vitest";

/**
 * Rule 2290, docs/system/tests/2290-build-workers.md: the build starts at most 4 workers. The shared Hostinger build
 * machine reports 64 CPUs, and one worker per CPU (Next's default) aborted release build 01a152f2 on 2026-10-19.
 */
describe("rule 2290: build workers are capped", () => {
  it("next.config sets experimental.cpus to a small fixed number", async () => {
    const config = (await import("../next.config")).default;
    const cpus = config.experimental?.cpus;
    expect(typeof cpus).toBe("number");
    expect(cpus).toBeGreaterThanOrEqual(1);
    expect(cpus).toBeLessThanOrEqual(4);
  });
});
