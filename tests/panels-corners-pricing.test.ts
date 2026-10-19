// The design review of 2026-10-19, second batch (docs/system/tests/2314-panels-corners-pricing.md): a splash panel in
// the Day strip (rule 2314), one colour band under Rules (rule 2315), one written corner rule (rule 2316), and the pricing
// page without eyebrows, monospace or ruled rows, with one entrance (rules 2317-2319). Source-reading checks and static
// renders; the layouts themselves were looked at in a browser at 1440, 768 and 390.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dict, LANGS } from "@/lib/i18n";
import Pricing from "@/components/Pricing";
import Faq, { QaList } from "@/components/Faq";

const read = (f: string) => readFileSync(f, "utf8");
const CSS = read("src/components/home/home.module.css").replace(/\/\*[\s*][\s\S]*?\*\//g, "");
const GLOBALS = read("src/app/globals.css").replace(/\/\*[\s*][\s\S]*?\*\//g, "");

describe("rule 2314: the owner's word is the Day strip's splash panel", () => {
  it("marks the fourth panel as the splash", () => {
    const day = read("src/components/home/Day.tsx");
    const panels = [...day.matchAll(/<li className=\{(.+)\}>\n\s*<Scribble kind="box" seed="(d\d)"/g)].map((m) => [m[2], m[1]]);
    expect(panels.map(([seed]) => seed)).toEqual(["d1", "d2", "d3", "d4"]);
    expect(panels[3][1]).toMatch(/styles\.splash/);
    expect(panels.slice(0, 3).some(([, c]) => /splash/.test(c))).toBe(false);
  });
  it("from 1040px puts three panels to a row and runs the splash across the whole row, so the grid has no hole", () => {
    const m = CSS.match(/@media \(min-width: 1040px\) \{\s*\.strip \{[^}]*\}[\s\S]*?\n\}/);
    expect(m, "the strip's 1040px block").not.toBeNull();
    expect(m![0]).toMatch(/\.strip \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
    expect(m![0]).toMatch(/\.strip > \.splash \{ grid-column: 1 \/ -1;/);
  });
});

describe("rule 2315: Rules is the page's one colour band", () => {
  it("puts the band on the Rules section only, in Lilac Wash from edge to edge", () => {
    expect(read("src/components/home/Rules.tsx")).toMatch(/className=\{`\$\{styles\.sec\} \$\{styles\.band\}`\} id="rules"/);
    const others = ["Stories", "Day", "Gallery", "Steps", "Plans", "HomeFaq", "Closing", "Cover"].map((c) => read(`src/components/home/${c}.tsx`));
    for (const src of others) expect(src).not.toMatch(/styles\.band\b/);
    expect(CSS).toMatch(/\.band \{[^}]*border-image: linear-gradient\(var\(--color-background-muted\) 0 0\) fill 0 \/ \/ 0 100vmax;/);
  });
  it("draws the law captions on paper, so they do not vanish into the band", () => {
    expect(read("src/components/home/Rules.tsx")).toMatch(/seed=\{`rl\$\{i\}`\} fill="paper"/);
  });
});

describe("rule 2316: one corner rule", () => {
  it("has a single card radius token", () => {
    const tokens = read("src/app/tokens.css");
    expect(tokens).not.toMatch(/--card-radius\s*:/);
    expect(read("assets/design-tokens.json")).not.toMatch(/"card": \{[^\n]*"radius"/);
    expect(tokens).toMatch(/--radius-card: 0\.75rem;/);
    expect(tokens).toMatch(/--button-radius: 0\.5rem;/);
    expect(tokens).toMatch(/--input-radius: 0\.5rem;/);
  });
  it("writes the rule down in the design system", () => {
    const doc = read("docs/Design_System.md");
    expect(doc).toMatch(/### Corners \(rule 2316\)/);
    expect(doc).toMatch(/Drawn frames are drawn, never rounded/);
    expect(doc).toMatch(/Controls are 8px/);
    expect(doc).toMatch(/Surfaces are 12px/);
  });
});

describe("rules 2317-2319: the pricing page", () => {
  for (const lang of LANGS) {
    const t = dict[lang];
    const page = renderToStaticMarkup(h(Pricing, { t, lang, headingLevel: 1 }));
    const faq = renderToStaticMarkup(h(Faq, { t }));
    it(`has no eyebrow label over the pricing or FAQ title (rule 2317, ${lang})`, () => {
      expect(page).not.toMatch(/class="eyebrow/);
      expect(faq).not.toMatch(/class="eyebrow/);
    });
    it(`sets the credit costs in tabular figures and parts rows by space, not lines (rule 2318, ${lang})`, () => {
      expect(page).not.toMatch(/font-mono/);
      expect(page).toMatch(/<td class="[^"]*tabular-nums/);
      for (const html of [page, faq]) expect(html).not.toMatch(/divide-y|border-y/);
    });
    it(`lets the plan cards rise in on /pricing only (rule 2319, ${lang})`, () => {
      expect(page).toMatch(/class="plans-rise/);
      expect(renderToStaticMarkup(h(Pricing, { t, lang }))).not.toMatch(/plans-rise/);
    });
  }
  it("keeps the shared question list free of ruled lines (rule 2318)", () => {
    expect(renderToStaticMarkup(h(QaList, { items: [{ q: "q", a: "a" }] }))).not.toMatch(/divide-y|border-y/);
  });
  it("runs the entrance only when motion is allowed and the pause switch is not off (rule 2319)", () => {
    const m = GLOBALS.match(/@media \(prefers-reduced-motion: no-preference\) \{\s*html:not\(\[data-motion="off"\]\) \.plans-rise[\s\S]*?\n\}/);
    expect(m, "the plans-rise block").not.toBeNull();
    expect(m![0]).toMatch(/animation: plan-rise \d+ms var\(--ease-out\) both;/);
    // Outside that block nothing hides the cards, so they stand when the animation never runs.
    expect(GLOBALS.replace(m![0], "")).not.toMatch(/\.plans-rise/);
    expect(GLOBALS).toMatch(/@keyframes plan-rise \{ from \{ opacity: 0; transform: translateY\(20px\); \} \}/);
  });
});
