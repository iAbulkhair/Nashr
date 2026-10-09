import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The test coverage map (rule 788): `docs/system/tests.md` holds rules 1-786 and the files in `docs/system/tests/`
 * hold each later change's rows, one file per change, named `NNNN-slug.md` after the first rule it adds. Tests that
 * read a rule's row read it through here, so a row can live in either place.
 */
export const COVERAGE_MAP = "docs/system/tests.md";
export const COVERAGE_DIR = "docs/system/tests";

/** The map's files: tests.md first, then the directory's files in name order. */
export function coverageFiles(): string[] {
  const dir = existsSync(COVERAGE_DIR) ? readdirSync(COVERAGE_DIR).filter((f) => f.endsWith(".md")).sort() : [];
  return [COVERAGE_MAP, ...dir.map((f) => join(COVERAGE_DIR, f))];
}

/** Every table row whose first cell is a rule number or a range (`| 723-729 |`), with the file it is in. */
export function coverageRows(): { file: string; first: number; last: number; line: string }[] {
  return coverageFiles().flatMap((file) =>
    readFileSync(file, "utf8").split("\n").flatMap((line) => {
      const m = /^\| *(\d+)(?:-(\d+))? *\|/.exec(line);
      return m ? [{ file, first: Number(m[1]), last: Number(m[2] ?? m[1]), line }] : [];
    }),
  );
}

/** The row of rule `n` (`| n | ...`), wherever it lives, or "" when there is none. */
export function coverageRow(n: number): string {
  return coverageRows().find((r) => r.first === n && r.last === n)?.line ?? "";
}
