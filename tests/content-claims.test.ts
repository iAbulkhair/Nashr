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

/**
 * The same rule, applied to every place the site and the product speak: the landing page, pricing, plan cards, the
 * in-app strings, industry and comparison pages, help, legal pages and lifecycle emails. Each pattern below is a claim
 * that was published and was not true: an invented result, an invented audience, a channel that is not built, a
 * billing behaviour the code does not have. The list is deliberately narrow, so a hit is a real regression, not noise.
 */
describe("no site or product copy asserts an invented result or an unbuilt feature as live", () => {
  const ROOTS = ["src/app", "src/components", "src/lib", "content/blog"];
  const COPY = /\.(tsx?|md)$/;

  function copyFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return copyFiles(p);
      return COPY.test(e.name) ? [p] : [];
    });
  }

  const CLAIMS = [
    // Invented results and audiences from the old homepage log and highlights.
    { re: /18,420/, why: "an invented revenue figure" },
    { re: /214 (عميل|customers)/, why: "an invented audience count" },
    { re: /(expected|متوقع) ?\d+\s*[–-]\s*\d+\s*% ?(conversion|تحويل)/i, why: "an expected-conversion promise" },
    { re: /\(\+\d+%\)/, why: "an invented growth figure" },
    { re: /(Acceptance reaches|نسبة القبول تصل) \d+%/, why: "an invented acceptance rate" },
    { re: /(About|عادةً) 20 (edits|تعديلاً)/, why: "an invented learning curve" },
    { re: /(90%\+|\+90%)/, why: "an unsourced market statistic" },
    { re: /(40k\+|ألف متجر على سلة وزد)/, why: "an unsourced market statistic" },
    { re: /(25 hours every week|استرجع 25 ساعة)/, why: "a time-saved promise" },
    { re: /(SAR 8,000\+|8,000\+ ريال)/, why: "an unsourced agency price" },
    // Always-on and overnight work: generation runs when asked, plus a weekly plan and a daily brief.
    { re: /(while you sleep|works overnight|sleeps\. Noor doesn't|وأنت نايم|ينام\. نور لا|(?<![\d/])24\/7(?![\d/]))/i, why: "an always-on promise" },
    // Channels and behaviours that are not built.
    { re: /(brief on WhatsApp|ملخص الصباح على واتساب|ملخصك على واتساب)/i, why: "a WhatsApp brief that is not built" },
    { re: /(email you within 48 hours|سنراسلك خلال 48 ساعة)/i, why: "a response-time promise nothing implements" },
    { re: /\d+ concurrent tasks/i, why: "a concurrency limit that does not exist" },
    { re: /rolls over/i, why: "credits reset monthly; they do not roll over" },
    { re: /(?<!لا )يترحّل/, why: "credits reset monthly; they do not roll over (Arabic)" },
    { re: /Data hosted inside Saudi Arabia(?! \(coming soon\))/, why: "Saudi hosting is not built" },
    { re: /استضافة البيانات داخل السعودية(?! \(قريباً\))/, why: "Saudi hosting is not built (Arabic)" },
    { re: /White-label client reports(?! \(coming soon\))/, why: "white-label reports are not built" },
    { re: /Auto ad optimization within your guardrails(?! \(coming soon\))/, why: "ad optimization is not built" },
  ];

  const files = ROOTS.flatMap(copyFiles);

  it("walks the copy tree, so the sweep cannot be empty", () => {
    expect(files).toContain("src/lib/i18n.ts");
    expect(files).toContain("src/lib/app-i18n.ts");
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds none of the claims that were removed", () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const { re, why } of CLAIMS) if (re.test(line)) hits.push(`${file}:${i + 1}: ${why}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
