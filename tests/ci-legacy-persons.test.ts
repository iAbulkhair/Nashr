import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rules 2510-2511: CI runs the unit tests a second time with the person shape every production login has until
 * multi-workspace M2 (`TEST_PERSONS=legacy`, tests/helpers/session.ts), on ready pull requests only, and the job's cap
 * makes room for it. The first pass runs the `p_` shape; the integration check of 2026-10-20 found a refund that only
 * the other shape would have shown.
 */
const yml = readFileSync(".github/workflows/ci.yml", "utf8");
const step = (name: string) => {
  const at = yml.indexOf(`      - name: ${name}\n`);
  expect(at, name).toBeGreaterThan(-1);
  const next = yml.indexOf("\n      - ", at + 1);
  return yml.slice(at, next < 0 ? yml.length : next);
};
/** A step's text without its comment lines (a slice runs into the comments above the next step). */
const code = (t: string) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").trimEnd();
const at = (name: string) => yml.indexOf(`      - name: ${name}\n`);

describe("rule 2510: the unit tests run again in production's person shape before every merge", () => {
  it("a second vitest run with TEST_PERSONS=legacy, ready pull requests only, after the first pass and before the end-to-end suite", () => {
    const s = code(step("Unit tests (production person shape)"));
    expect(s).toMatch(/if: steps\.scope\.outputs\.e2e == 'true'\n/);
    expect(s).toMatch(/env:\n\s+TEST_PERSONS: legacy\n/);
    expect(s).toMatch(/run: npx vitest run\n?$/);
    expect(at("Unit tests")).toBeLessThan(at("Unit tests (production person shape)"));
    expect(at("Unit tests (production person shape)")).toBeLessThan(at("End-to-end tests"));
    // The first pass keeps the default (`p_`) shape: nothing but this step sets TEST_PERSONS (comments aside).
    expect(code(step("Unit tests"))).not.toMatch(/TEST_PERSONS/);
    expect(code(yml).match(/TEST_PERSONS/g)).toHaveLength(1);
  });

  it("the helper reads that exact value", () => {
    expect(readFileSync("tests/helpers/session.ts", "utf8")).toContain('process.env.TEST_PERSONS === "legacy" ? "legacy" : "p"');
  });
});

describe("rule 2511: the job's cap leaves room for the second pass", () => {
  it("one job, capped at 40 minutes", () => {
    expect(yml.match(/timeout-minutes: (\d+)/g)).toEqual(["timeout-minutes: 40"]);
  });
});
