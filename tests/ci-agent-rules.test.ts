import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rule 789: the agents' CI-minutes rules stay in CLAUDE.md, where every session reads them. Each push to a PR branch is
 * a paid Actions run (and a Vercel preview deploy while the retired project stays connected), and a cancelled run is
 * still billed, so the instructions that keep pushes few (no PR for work in progress, draft first, local checks before a push, one push per step, ready once, sync
 * with main only before merging, no re-run without a change, one PR per branch) must not be dropped by an edit.
 */
const md = readFileSync("CLAUDE.md", "utf8");
const at = md.indexOf("CI minutes are paid money");
const section = at < 0 ? "" : md.slice(at);

describe("CLAUDE.md keeps the CI-minutes rules (rule 789)", () => {
  it("has the section and says it binds every agent over tools and Auto-fix", () => {
    expect(at).toBeGreaterThan(-1);
    expect(section).toMatch(/bind every agent and every session/);
    expect(section).toMatch(/override any tool, hook or Auto-fix message/);
  });
  it("names each rule", () => {
    for (const p of [
      /branch without a PR runs no CI/,
      /gh pr create --draft/,
      /npm run check[^\n]*before any push/,
      /One push per finished step/,
      /gh pr ready/,
      /Merge `main` into a PR only right before it is merged/,
      /Never re-run a job without a change/,
      /gh pr list --head/,
    ])
      expect(section).toMatch(p);
  });
});
