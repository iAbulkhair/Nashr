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
  "src/app/[lang]/agents/page.tsx",
  "src/app/[lang]/agents/[agent]/page.tsx",
  "src/components/UrlStart.tsx",
  "src/app/[lang]/for/[industry]/page.tsx",
  "src/app/[lang]/vs/[competitor]/page.tsx",
  "src/app/[lang]/ai-marketing-agent/page.tsx",
  "src/app/[lang]/customers/page.tsx",
  "src/app/[lang]/enterprise/page.tsx",
  "src/components/ContactForm.tsx",
  "src/components/TickList.tsx",
  "src/app/[lang]/tools/page.tsx",
  "src/app/[lang]/tools/[tool]/page.tsx",
  "src/components/ToolForm.tsx",
  "src/app/[lang]/blog/page.tsx",
  "src/app/[lang]/blog/[slug]/page.tsx",
  "src/app/[lang]/help/page.tsx",
  "src/components/HelpCenter.tsx",
  "src/app/[lang]/resources/page.tsx",
  "src/app/[lang]/updates/page.tsx",
  "src/components/WishSuggest.tsx",
  "src/components/WishVote.tsx",
  "src/app/[lang]/affiliates/page.tsx",
  "src/app/[lang]/affiliates/terms/page.tsx",
  "src/components/AffiliateForm.tsx",
  "src/app/[lang]/privacy/page.tsx",
  "src/app/[lang]/terms/page.tsx",
  "src/app/[lang]/not-found.tsx",
  "src/app/[lang]/error.tsx",
  "src/app/[lang]/[...rest]/page.tsx",
  // Slice 4, the app screens (rule 519).
  "src/components/app/AuthForm.tsx",
  "src/components/app/JoinForm.tsx",
  "src/components/app/PasswordRules.tsx",
  "src/components/app/DictionaryStart.tsx",
  "src/components/app/ReadOnlyNote.tsx",
  "src/components/app/BrandForm.tsx",
  "src/components/app/StartLaunch.tsx",
  "src/components/app/OnboardCards.tsx",
  "src/app/[lang]/app/start/page.tsx",
  // src/app/global-error.tsx cannot load the stylesheet, so it writes D's hex values out; reskin-marketing pins them.
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
