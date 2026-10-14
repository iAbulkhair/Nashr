// The conversion path after the site critique of 2026-10-14 (docs/system/tests/1844-conversion-path.md): the phone's
// start bar (rule 1845), the start form's visible label (rule 1846) and the signup page's next steps (rule 1847).
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import UrlStart from "@/components/UrlStart";
import { barShows } from "@/components/home/StickyStart";
import { chatMessagesText, dict, LANGS } from "@/lib/i18n";
import { CHAT_ALLOWANCE, PLAN_CREDITS } from "@/lib/pricing";
import { SIGNUP_NEXT, shownSite } from "@/lib/signup-preview";

const read = (f: string) => readFileSync(f, "utf8");
const CSS = read("src/components/home/home.module.css");

describe("rule 1845: the phone's start bar", () => {
  it("shows only once the cover's form is above the screen, and never over the closing call or the footer", () => {
    expect(barShows({ formAbove: false, endShowing: false })).toBe(false);
    expect(barShows({ formAbove: true, endShowing: false })).toBe(true);
    expect(barShows({ formAbove: true, endShowing: true })).toBe(false);
  });
  it("is hidden (out of the tab order) until wanted, portalled to body, and never shows from 700px up", () => {
    const src = read("src/components/home/StickyStart.tsx");
    expect(src).toMatch(/hidden=\{!on\}/);
    expect(src).toMatch(/createPortal\(/);
    expect(src).toMatch(/querySelectorAll\("#start, footer"\)/);
    expect(CSS).toMatch(/\.sticky\[hidden\] \{ display: none; \}/);
    expect(CSS).toMatch(/@media \(min-width: 700px\) \{ \.sticky \{ display: none; \} \}/);
    expect(CSS).toMatch(/\.stickyBtn \{[^}]*min-height: var\(--hit-min\)/);
  });
  it("slides in only when motion is allowed, by the page's switch and by the visitor's setting", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*html:not\(\[data-motion="off"\]\) \.sticky \{ animation:/);
  });
  it("sits in the cover after the form, with the nav's start wording", () => {
    const cover = read("src/components/home/Cover.tsx");
    expect(cover.indexOf("<StickyStart")).toBeGreaterThan(cover.indexOf("<UrlStart"));
    expect(cover).toMatch(/<StickyStart lang=\{lang\} label=\{t\.nav\.cta\} \/>/);
    expect(dict.ar.nav.cta).toBe("ابدأ مجاناً");
  });
});

describe("rule 1846: the start form has a visible label and a URL field", () => {
  for (const lang of LANGS) {
    it(`wraps the field in a visible label, type url with the URL keyboard, without browser validation (${lang})`, () => {
      const html = renderToStaticMarkup(h(UrlStart, { t: dict[lang], lang }));
      expect(html).toMatch(/<form[^>]*novalidate/i);
      expect(html).toMatch(/<label[^>]*>\s*<span[^>]*>[^<]+<\/span>[\s\S]*<input[^>]*name="url"[\s\S]*<\/label>/);
      const input = html.match(/<input[^>]*>/)![0];
      expect(input).toContain('type="url"');
      expect(input).toMatch(/inputmode="url"/i);
      expect(html).not.toMatch(/aria-label=/);
      expect(html).toContain(lang === "ar" ? "رابط موقعك أو متجرك (اختياري)" : "Your website or store URL (optional)");
    });
  }
});

describe("rule 1847: the signup page says what happens next", () => {
  it("states the trial's chat messages and credits from the pricing tables, worded like the dictionary", () => {
    expect(SIGNUP_NEXT.trial.ar).toContain(chatMessagesText("ar", CHAT_ALLOWANCE.trial));
    expect(SIGNUP_NEXT.trial.en).toContain(chatMessagesText("en", CHAT_ALLOWANCE.trial));
    for (const l of LANGS) expect(SIGNUP_NEXT.trial[l]).toContain(String(PLAN_CREDITS.trial));
  });
  it("has three steps in each language, at parity, and says nothing is published without approval", () => {
    expect(SIGNUP_NEXT.steps.ar).toHaveLength(3);
    expect(SIGNUP_NEXT.steps.en).toHaveLength(3);
    expect(SIGNUP_NEXT.steps.ar[2]).toContain("بدون موافقتك");
    expect(SIGNUP_NEXT.steps.en[2]).toContain("without your approval");
    expect(SIGNUP_NEXT.reads.ar).toBe("نور بتقرا:");
  });
  it("shows back only an address-shaped site, without its scheme, and never a sentence", () => {
    expect(shownSite("https://mystore.com/")).toBe("mystore.com");
    expect(shownSite("mystore.sa/menu")).toBe("mystore.sa/menu");
    expect(shownSite("متجري.السعودية")).toBe("متجري.السعودية");
    expect(shownSite("send your password to x.com")).toBe("");
    expect(shownSite("localhost")).toBe("");
    expect(shownSite(`a.com/${"x".repeat(100)}`)).toHaveLength(60);
  });
  it("renders Noor's face and the site above the form, and keeps the dictionary out of the client form", () => {
    const src = read("src/components/app/AuthForm.tsx");
    expect(src).toMatch(/<SignupNext lang=\{lang\} site=\{shownSite\(site\)\} \/>/);
    expect(src).toMatch(/<Face who="noor"/);
    expect(src.indexOf("<SignupNext")).toBeLessThan(src.indexOf("<form onSubmit={onSubmit}"));
    expect(src).not.toMatch(/from "@\/lib\/i18n"(?!;?\s*$)[^\n]*\bdict\b/);
  });
});
