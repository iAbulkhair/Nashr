import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { coverageRows, coverageFiles } from "./helpers/coverage";

/**
 * Rule 1450: the coverage map and the test directory agree. A test file nobody names pins behaviour no reader can find,
 * and a row that cites a deleted file claims a check that does not exist (the 360 study found five of the first and a
 * few of the second, J-017).
 */
const NAME = /[A-Za-z0-9_-]+\.test\.ts/g;
const RETIRED = /designed, not pinned|retired|removed|deleted/i;

/** Test files (top level of tests/) no text names. */
export function unnamedTests(files: string[], text: string): string[] {
  return files.filter((f) => !text.includes(f));
}

/** Rows citing a test file that is not in `existing`, unless the row says it is retired, removed, deleted or only designed. */
export function missingCitations(rows: { line: string }[], existing: Set<string>): string[] {
  return rows.flatMap((r) => {
    if (RETIRED.test(r.line)) return [];
    return [...new Set(r.line.match(NAME) ?? [])].filter((n) => !existing.has(n)).map((n) => `${n} in: ${r.line.slice(0, 60)}`);
  });
}

const testFiles = readdirSync("tests").filter((f) => f.endsWith(".test.ts"));
const mapText = coverageFiles().map((f) => readFileSync(f, "utf8")).join("\n");

describe("rule 1450: the coverage map names every test file and cites no missing one", () => {
  it("every tests/*.test.ts file is named by a row of the map", () => {
    expect(unnamedTests(testFiles, mapText)).toEqual([]);
  });

  it("a row that cites a test file that does not exist says it is retired, removed, deleted or only designed", () => {
    const existing = new Set(testFiles);
    for (const f of readdirSync("e2e")) existing.add(f);
    expect(missingCitations(coverageRows(), existing)).toEqual([]);
  });

  it("the finders see an unnamed file and a missing citation", () => {
    expect(unnamedTests(["a.test.ts", "b.test.ts"], "| 1 | `a.test.ts` |")).toEqual(["b.test.ts"]);
    const rows = [{ line: "| 9 | rule | test (`gone.test.ts`) | done |" }, { line: "| 10 | rule | Retired: `gone.test.ts` | — |" }, { line: "| 11 | rule | designed, not pinned | `later.test.ts` |" }];
    expect(missingCitations(rows, new Set(["here.test.ts"]))).toEqual(["gone.test.ts in: | 9 | rule | test (`gone.test.ts`) | done |"]);
  });
});
