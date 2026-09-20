import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The published comparison page names six real competitors and stakes its credibility on the rubric being checkable:
 * "we publish the full rubric… email us to correct any number". Four of its eight totals did not match the weights it
 * publishes three lines above, and the rank column contradicted its own scores in seven of eight rows — with the
 * vendor's own row being one of the arithmetically correct ones. This recomputes it.
 */
const RUBRIC = "content/blog/best-ai-marketing-agents-gulf-2026.md";
/** Exec, Arabic, Channels, Compliance, Control, Price — the weights the article itself publishes. */
const WEIGHTS = [0.25, 0.2, 0.2, 0.1, 0.15, 0.1];

type Row = { rank: string; tool: string; scores: number[]; total: number };

function rubricRows(): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(RUBRIC, "utf8").split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 9) continue;
    const scores = cells.slice(2, 8).map(Number);
    const total = Number(cells[8].replace(/\*/g, ""));
    if (scores.some((n) => !Number.isFinite(n)) || !Number.isFinite(total)) continue;
    rows.push({ rank: cells[0], tool: cells[1], scores, total });
  }
  return rows;
}

describe("the published competitor rubric is arithmetically true", () => {
  it("finds both language tables, so an empty result cannot pass by accident", () => {
    expect(rubricRows().length).toBe(16);
  });

  it("every published total equals weight x score", () => {
    const wrong = rubricRows()
      .map((r) => ({ tool: r.tool, published: r.total, computed: Math.round(r.scores.reduce((s, v, i) => s + v * WEIGHTS[i], 0) * 100) / 100 }))
      .filter((r) => Math.abs(r.published - r.computed) > 0.005);
    expect(wrong, `rows whose total does not match the published weights: ${JSON.stringify(wrong)}`).toEqual([]);
  });

  it("the rank column does not contradict the scores", () => {
    // Rows carrying a number are the ranked products; the agency row is a reference and is marked with a dash.
    for (const table of [rubricRows().slice(0, 8), rubricRows().slice(8)]) {
      const ranked = table.filter((r) => /^\d+$/.test(r.rank));
      expect(ranked.length).toBeGreaterThan(0);
      const byRank = [...ranked].sort((a, b) => Number(a.rank) - Number(b.rank)).map((r) => r.total);
      const byScore = [...ranked].map((r) => r.total).sort((a, b) => b - a);
      expect(byRank, "the # column must be ordered by the published score").toEqual(byScore);
    }
  });
});

describe("no blog post asserts an invented number or promises a result", () => {
  const BANNED = [
    { re: /Savings\s*[≈~]\s*SAR/i, why: "a quantified savings promise" },
    { re: /الوفر:\s*~?\s*[\d,]+\s*ريال/, why: "a quantified savings promise (Arabic)" },
    { re: /Agencies charge SAR [\d,]+[–-][\d,]+/i, why: "an unsourced competitor price range" },
    { re: /better than a (new )?agency writer/i, why: "a comparative performance guarantee" },
    { re: /أفضل من كاتب جديد في الوكالة/, why: "a comparative performance guarantee (Arabic)" },
  ];

  it("checks every post, so the sweep cannot be empty", () => {
    const posts = readdirSync("content/blog").filter((f) => f.endsWith(".md"));
    expect(posts.length).toBeGreaterThan(10);
  });

  it("finds none of the claims CLAUDE.md forbids", () => {
    // CLAUDE.md: "No invented customers, logos, testimonials, numbers or results promises anywhere in the product or
    // the site." The product enforces this against its own model output (the reviewer pass and the judge's honesty
    // dimension); the marketing has to hold to it too.
    const hits: string[] = [];
    for (const file of readdirSync("content/blog").filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join("content/blog", file), "utf8");
      for (const { re, why } of BANNED) if (re.test(text)) hits.push(`${file}: ${why}`);
    }
    expect(hits).toEqual([]);
  });
});
