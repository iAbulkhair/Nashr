import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rule numbers in docs/system/tests.md (rule 866). Code comments, commit messages and other docs cite a rule by its
 * number, so a number must name one row only. Branches take blocks of numbers and merges have produced duplicates
 * before; this fails on the merge that brings one back, and on a row left with a placeholder instead of a number.
 */

/**
 * The first cell of a rule row: a number, optionally with a one-letter suffix (`31a`), or a reserved range (`723-729`, a
 * row that holds numbers for later work; a rule row inside it is a duplicate). Header and divider rows are not rules.
 */
const RULE = /^\d+[a-z]?$/;
const RANGE = /^(\d+)-(\d+)$/;
const NOT_A_RULE = new Set(["#", "---"]);

const firstCells = (text: string) =>
  text
    .split("\n")
    .map((l, i) => ({ line: i + 1, cell: /^\|\s*([^|]*?)\s*\|/.exec(l)?.[1] }))
    .filter((r): r is { line: number; cell: string } => r.cell !== undefined && !NOT_A_RULE.has(r.cell));

const numbersOf = (cell: string): string[] => {
  const m = RANGE.exec(cell);
  if (!m) return [cell];
  const [lo, hi] = [Number(m[1]), Number(m[2])];
  return Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
};

/** `bad`: rows whose first cell is not a number or an upward range. `dupes`: numbers that name two rows. */
function ruleNumberProblems(text: string): { rows: number; bad: string[]; dupes: string[] } {
  const all = firstCells(text);
  const bad = all.filter((r) => {
    const m = RANGE.exec(r.cell);
    return m ? Number(m[1]) >= Number(m[2]) : !RULE.test(r.cell);
  });
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  for (const r of all.filter((x) => !bad.includes(x))) {
    for (const n of numbersOf(r.cell)) {
      const first = seen.get(n);
      if (first !== undefined) dupes.push(`${n} (lines ${first} and ${r.line})`);
      else seen.set(n, r.line);
    }
  }
  return { rows: all.length, bad: bad.map((r) => `line ${r.line}: ${r.cell}`), dupes };
}

const TESTS_MD = () => readFileSync("docs/system/tests.md", "utf8");

describe("rule numbers in docs/system/tests.md (rule 866)", () => {
  it("every rule row carries a number, and no number names two rows", () => {
    const p = ruleNumberProblems(TESTS_MD());
    expect(p.rows).toBeGreaterThan(700);
    expect(p.bad).toEqual([]);
    expect(p.dupes).toEqual([]);
  });

  it("the check sees a duplicate, a number inside a reserved range and a placeholder", () => {
    const doc = ["| # | Rule |", "|---|---|", "| 1 | a |", "| 2 | b |", "| 1 | c |", "| 5-7 | reserved |", "| 6 | d |", "| (unassigned) | e |", "| 9-8 | f |"].join("\n");
    const p = ruleNumberProblems(doc);
    expect(p.dupes).toEqual(["1 (lines 3 and 5)", "6 (lines 6 and 7)"]);
    expect(p.bad).toEqual(["line 8: (unassigned)", "line 9: 9-8"]);
  });

  it("the model routing block is numbered 810-866 in order", () => {
    const nums = firstCells(TESTS_MD()).map((r) => r.cell).filter((c) => /^8[1-6]\d$/.test(c)).map(Number);
    expect(nums).toEqual(Array.from({ length: 57 }, (_, i) => 810 + i));
  });
});
