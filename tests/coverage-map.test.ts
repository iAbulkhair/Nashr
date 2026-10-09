import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { COVERAGE_DIR, COVERAGE_MAP, coverageFiles, coverageRow, coverageRows } from "./helpers/coverage";

/**
 * Rule 788: the coverage map is split so pull requests stop conflicting on it. Every PR used to add its rows at the
 * same end of one table in docs/system/tests.md (and its notes at the same top of the notes), so each merge to main
 * conflicted with every open PR and forced a resync and a full CI run. tests.md keeps rules 1-786; each later change
 * adds its own file in docs/system/tests/, named after the first rule it adds.
 */
const LAST_IN_MAP = 786;
const dirFiles = readdirSync(COVERAGE_DIR).filter((f) => f.endsWith(".md")).sort();

describe("rule 788: one coverage file per change, one row per rule number", () => {
  it("each file in docs/system/tests/ is NNNN-slug.md and starts with the map's four-column table", () => {
    expect(dirFiles.length).toBeGreaterThan(0);
    for (const f of dirFiles) {
      expect(f).toMatch(/^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
      const text = readFileSync(`${COVERAGE_DIR}/${f}`, "utf8");
      expect(text, f).toMatch(/\n\| # \| Rule \| Verified today \| First test to write \|\n\|---\|---\|---\|---\|\n/);
    }
  });

  it("a file's first row is the rule its name carries, and every row in the directory is a rule after tests.md's", () => {
    for (const f of dirFiles) {
      const rows = coverageRows().filter((r) => basename(r.file) === f);
      expect(rows.length, f).toBeGreaterThan(0);
      expect(Math.min(...rows.map((r) => r.first)), f).toBe(Number(f.slice(0, 4)));
      for (const r of rows) expect(r.first, r.line.slice(0, 80)).toBeGreaterThan(LAST_IN_MAP);
    }
  });

  it("no rule number is used twice across tests.md and the directory, a reserved range included", () => {
    const seen = new Map<number, string>();
    for (const r of coverageRows()) {
      for (let n = r.first; n <= r.last; n++) {
        expect(seen.get(n), `rule ${n} in ${r.file} is also in ${seen.get(n)}`).toBeUndefined();
        seen.set(n, r.file);
      }
    }
  });

  it("tests.md says where the later rows are, and the helper finds a row in either place", () => {
    expect(readFileSync(COVERAGE_MAP, "utf8")).toContain("Rules after 786 are not added here");
    expect(coverageFiles()[0]).toBe(COVERAGE_MAP);
    expect(coverageRow(270)).toMatch(/^\| 270 \|/);
    expect(coverageRow(788)).toMatch(/^\| 788 \| The coverage map is split/);
    expect(coverageRow(723), "a range row is not a rule's row").toBe("");
  });
});
