// The home page's closing call (docs/system/tests/1600-home-closing-cta.md): a last call to action before the footer
// that reuses the cover's signup form and trial line (rule 1228). Static renders and source-reading checks.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dict, LANGS } from "@/lib/i18n";
import { HOME_END, homeEndStrings } from "@/lib/home-hero";
import Closing from "@/components/home/Closing";

const read = (f: string) => readFileSync(f, "utf8");
const PAGE = read("src/app/[lang]/page.tsx");
const CLOSING = read("src/components/home/Closing.tsx");
const HOME_CSS = read("src/components/home/home.module.css");
const amp = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");

describe("rule 1600: the home page ends with the cover's call to action before the footer", () => {
  it("mounts the closing call after the questions, as the last block of main, with the footer after it", () => {
    const faq = PAGE.indexOf("<HomeFaq ");
    const closing = PAGE.indexOf("<Closing ");
    const mainEnd = PAGE.indexOf("</main>");
    expect(faq).toBeGreaterThan(-1);
    expect(closing).toBeGreaterThan(faq);
    expect(mainEnd).toBeGreaterThan(closing);
    expect(PAGE.slice(closing, mainEnd)).not.toMatch(/<[A-Z]\w* (?!lang=)/);
    expect(PAGE.indexOf("<Footer ")).toBeGreaterThan(mainEnd);
  });

  for (const lang of LANGS) {
    it(`renders the heading, the signup form, the trial line and no price (${lang})`, () => {
      const html = renderToStaticMarkup(h(Closing, { lang, t: dict[lang] }));
      expect(html).toMatch(/<section[^>]*id="start"[^>]*aria-labelledby="t-start"/);
      expect(html).toMatch(new RegExp(`<h2 id="t-start">[\\s\\S]*${amp(HOME_END.h[lang])}[\\s\\S]*</h2>`));
      expect(html).toContain(`action="/${lang}/app/signup"`);
      expect(html).toMatch(/method="get"/);
      expect(html).toMatch(/<input[^>]*name="url"/);
      expect(html).toMatch(/<button[^>]*class="s-btn/);
      expect(html).toContain(dict[lang].hero.cta);
      expect(html).toContain(amp(dict[lang].pricing.trial));
      expect(html).not.toMatch(/\b(299|499|999)\b|SAR|ريال/);
    });
  }

  it("reuses the cover's form and trial line instead of a second signup path", () => {
    expect(CLOSING).toMatch(/import UrlStart from "@\/components\/UrlStart"/);
    expect(CLOSING).toMatch(/<UrlStart t=\{t\} lang=\{lang\} \/>/);
    expect(CLOSING).toMatch(/\{t\.pricing\.trial\}/);
    expect(CLOSING).not.toMatch(/<Link\b|href=/);
  });

  it("keeps its words in src/lib/home-hero.ts, in both languages, naming no model, maker or number", () => {
    expect(CLOSING).toMatch(/from "@\/lib\/home-hero"/);
    expect(read("src/lib/home.ts")).not.toMatch(/home-hero|HOME_END/);
    expect(HOME_END.h.ar).toMatch(/[؀-ۿ]/);
    expect(HOME_END.h.en).not.toMatch(/[؀-ۿ]/);
    for (const s of homeEndStrings()) {
      expect(s.trim().length).toBeGreaterThan(0);
      expect(s).not.toMatch(/claude|anthropic|openai|gpt|gemini|sonnet|opus|llm|كلود|أنثروبيك/i);
      expect(s).not.toMatch(/\d/);
    }
  });

  it("draws on the paper fill and styles with roles only, so it follows the theme (rules 1212, 1213)", () => {
    expect(CLOSING).toMatch(/<Scribble kind="box" seed="closing" fill="paper" \/>/);
    const css = [...HOME_CSS.matchAll(/[^\n}]*\.closing\b[^{]*\{[^}]*\}/g)].map((m) => m[0]).join("\n");
    expect(css).toMatch(/\.closing \{/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|--color-(ink|paper|lemon|lilac|ground|gold)\b/i);
    expect(css).not.toMatch(/\b(left|right)\s*:|margin-(left|right)|padding-(left|right)|text-align:\s*(left|right)/);
  });

  it("keeps the cover's and the closing call's column inside the panel at phone width (the 360px overflow seen in CI)", () => {
    // An auto track took the signup input's default width as its minimum, and that width depends on the font: the column
    // grew past a 360px page on Linux while a Mac hid it. A fixed minmax(0, 1fr) column cannot grow, whatever the font.
    const lead = HOME_CSS.match(/\n\.lead \{[^}]*\}/)?.[0] ?? "";
    expect(lead).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(HOME_CSS).toMatch(/\n\.lead > \* \{ min-width: 0; \}/);
  });
});
