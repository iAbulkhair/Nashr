// The design review of 2026-10-19 (docs/system/tests/2310-home-first-screen.md): the cover's form reaches the first
// screen with the team still above it (rules 2310, 2311), one label for signing up (rule 2312), no em-dash in the site's
// copy (rule 2313). Source-reading checks; the screen sizes themselves were measured in a browser, not here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dict, LANGS } from "@/lib/i18n";

const CSS = readFileSync("src/components/home/home.module.css", "utf8").replace(/\/\*[\s*][\s\S]*?\*\//g, "");

describe("rule 2310: from 700px the cast is one row and the cover is tighter", () => {
  it("puts all nine in one row from 700px, with no five-to-a-row step", () => {
    expect(CSS).toMatch(/@media \(min-width: 700px\) \{\s*\.cast > li \{ flex-basis: calc\(100% \/ 9\); \}/);
    expect(CSS).not.toMatch(/calc\(100% \/ 5\)/);
  });
  it("draws the figures at 52-84px in that row", () => {
    expect(CSS).toMatch(/@media \(min-width: 700px\) \{\s*\.fig \{ width: clamp\(52px, 7vw, 84px\); \}/);
  });
  it("tightens the cover: 96px above the row, no padding above the lineup", () => {
    const m = CSS.match(/@media \(min-width: 700px\) \{\s*\.cover \{[^}]*\}[\s\S]*?\n\}/);
    expect(m, "the cover's 700px block").not.toBeNull();
    const block = m![0];
    expect(block).toMatch(/\.cover \{ padding: 32px 40px 28px; gap: 12px; \}/);
    expect(block).toMatch(/\.cover > \.lineup \{ padding-block-start: 0; \}/);
    expect(block).toMatch(/\.cover \.castWrap \{ padding-block-start: 96px; \}/);
  });
});

describe("rule 2311: the AI label has no decorative dot", () => {
  it("draws nothing before the label", () => {
    expect(CSS).not.toMatch(/\.aiLabel::before/);
  });
});

describe("rule 2312: one label for signing up", () => {
  for (const lang of LANGS) {
    it(`the hero, the nav and every self-serve plan card say the same thing (${lang})`, () => {
      const t = dict[lang];
      expect(t.hero.cta).toBe(t.nav.cta);
      // The agency card asks the visitor to get in touch, a different action, so it keeps its own label.
      for (const plan of t.pricing.plans.filter((p) => p.id !== "agency")) expect(plan.cta, plan.id).toBe(t.nav.cta);
    });
  }
});

describe("rule 2313: no em-dash in the site's copy", () => {
  for (const lang of LANGS) {
    it(`the ${lang} dictionary has none`, () => {
      const found = JSON.stringify(dict[lang]).match(/.{0,30}—.{0,30}/g);
      expect(found).toBeNull();
    });
  }
});
