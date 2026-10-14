// Technical fixes on the home page from the site critique of 2026-10-14 (docs/system/tests/1866-home-technical.md).
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Scribble from "@/components/Scribble";
import ScribbleDir from "@/components/ScribbleDir";

const read = (f: string) => readFileSync(f, "utf8");
const CSS = read("src/components/home/home.module.css");
const HOME = ["Day", "Closing", "Gallery", "Rules", "HomeFaq", "Steps", "Stories"].map((f) => `src/components/home/${f}.tsx`);

describe("rule 1867: one outline per figure on the dark page", () => {
  it("draws a single drop-shadow under the dark theme", () => {
    const rule = CSS.match(/:global\(:root\[data-theme="dark"\]\) \.doodle \{ filter: ([^;]+); \}/)![1];
    expect(rule.match(/drop-shadow\(/g)).toHaveLength(1);
  });
});

describe("rule 1868: endless decoration holds still off screen", () => {
  it("marks every moving decoration and pauses what is away", () => {
    expect(read("src/components/home/Decor.tsx").match(/data-loop=""/g)).toHaveLength(4);
    const pause = read("src/components/home/LoopPause.tsx");
    expect(pause).toMatch(/toggleAttribute\("data-away", !e\.isIntersecting\)/);
    expect(pause).toMatch(/querySelectorAll\("\[data-loop\]"\)/);
    expect(CSS).toMatch(/\.home \[data-away\], \.home \[data-away\] \* \{ animation-play-state: paused !important; \}/);
    expect(read("src/components/home/Cover.tsx")).toMatch(/<LoopPause \/>/);
  });
});

describe("rule 1869: client scribbles start in the page's direction", () => {
  it("draws the first paint right to left under an Arabic page, and left to right without one", () => {
    const rtl = renderToStaticMarkup(h(ScribbleDir, { rtl: true }, h(Scribble, { kind: "underline", seed: "t" })));
    const ltr = renderToStaticMarkup(h(Scribble, { kind: "underline", seed: "t" }));
    expect(rtl).not.toBe(ltr);
    expect(read("src/components/Scribble.tsx")).toMatch(/rtl: rtl \?\? page \?\? false/);
  });
  it("is provided by the language layout from the dictionary's direction", () => {
    expect(read("src/app/[lang]/layout.tsx")).toMatch(/<ScribbleDir rtl=\{t\.dir === "rtl"\}>/);
  });
});

describe("rule 1870: touch targets and text sizes on the home page", () => {
  it("makes the slider's dots 44px targets and pads the freshness chip", () => {
    expect(CSS).toMatch(/\.pip \{[^}]*width: var\(--hit-min\); height: var\(--hit-min\)/);
    expect(CSS).toMatch(/\.fresh \{[^}]*min-height: var\(--hit-min\);\s*padding: 6px 16px;/);
  });
  it("sets no public text under 12px in the theme switch", () => {
    expect(read("src/components/ui/ThemeToggle.tsx")).not.toMatch(/text-\[1[01]px\]/);
  });
});

describe("rule 1871: decorative underlines, ticks and dividers on the home page are drawn on the server", () => {
  it("uses ScribbleStatic with the page's direction for every underline, tick and divider", () => {
    for (const f of HOME) {
      const src = read(f);
      expect(src, f).not.toMatch(/<Scribble kind="(underline|tick|divider)"/);
      expect(src, f).toMatch(/<ScribbleStatic kind="(underline|tick|divider)"[^>]*rtl=/);
    }
  });
});
