import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rule 513. Files moved to prototype D speak only D's colour names (ink, muted, paper, ground, lilac, lemon, gold,
 * danger, agent-<id>): no old oasis, saffron, sadu, salt or mist class and no hard-coded hex. Each re-skin task adds the
 * files it moves; the last slice replaces the list with all of `src/` and removes the old aliases.
 */
const CLEAN: string[] = [
  "src/lib/scribble.ts",
  "src/components/Scribble.tsx",
  "src/app/scribble.css",
  "src/components/Nav.tsx",
  "src/components/Footer.tsx",
  "src/components/LangToggle.tsx",
  "src/app/[lang]/app/layout.tsx",
  "src/components/app/Sidebar.tsx",
  "src/components/app/TrialBanner.tsx",
  "src/components/app/LimitModal.tsx",
  // Slice 2, the homepage (rule 516).
  "src/app/[lang]/page.tsx",
  "src/components/home/Cover.tsx",
  "src/components/home/Lineup.tsx",
  "src/components/home/Rules.tsx",
  "src/components/home/Day.tsx",
  "src/components/home/Steps.tsx",
  "src/components/home/Plans.tsx",
  "src/components/home/HomeFaq.tsx",
  "src/components/home/Decor.tsx",
  "src/components/home/Face.tsx",
  "src/components/home/Doodle.tsx",
  "src/components/home/home.module.css",
  // Slice 3, the marketing pages (rule 518).
  "src/app/[lang]/pricing/page.tsx",
  "src/components/Pricing.tsx",
  "src/components/Faq.tsx",
  "src/components/FinalCta.tsx",
];

const OLD = /\b(oasis|saffron|sadu|salt|mist)(-deep|-dim)?\b/;
/** The source without block comments and `//` line comments (a `//` after a colon is a URL, not a comment). */
const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("files moved to D use only D's names (rule 513)", () => {
  for (const file of CLEAN) {
    it(file, () => {
      const src = code(file);
      expect(src.match(OLD)?.[0], file).toBeUndefined();
      expect(src.match(/#[0-9a-f]{6}\b/i)?.[0], file).toBeUndefined();
    });
  }

  it("the wordmark carries no dot", () => {
    expect(code("src/components/Nav.tsx")).not.toMatch(/<Wordmark[\s\S]{0,200}rounded-full bg-/);
    expect(code("src/app/[lang]/app/layout.tsx")).not.toMatch(/appName\}[\s\S]{0,200}rounded-full bg-/);
  });
});
