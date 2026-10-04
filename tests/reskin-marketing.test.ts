import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict, type Lang } from "@/lib/i18n";
import { PUBLIC_TIERS } from "@/lib/pricing";
import Pricing from "@/components/Pricing";
import Faq from "@/components/Faq";
import FinalCta from "@/components/FinalCta";

/**
 * Rule 518. The marketing pages are fully hand-drawn prototype D (re-skin spec §5): section titles carry an underline
 * scribble, cards are `s-card` with a box scribble, calls to action are `s-btn` pills (the highlighted plan's on ink,
 * the rest ghosts on lemon). The scribbles are in the server HTML, so the first paint already shows them.
 */
const LANGS: readonly Lang[] = ["ar", "en"];
const html = <P extends object>(c: FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(c, props));
const count = (h: string, s: string) => h.split(s).length - 1;
const TITLE_SCRIBBLE = (tag: string) => new RegExp(`<${tag}[^>]*>(?:(?!</${tag}>)[\\s\\S])*<svg[^>]*class="scribble`);

describe("the marketing pages are hand-drawn D (rule 518)", () => {
  for (const lang of LANGS) {
    it(`pricing · ${lang}: a scribbled card and a pill per plan, an underlined title`, () => {
      const h = html(Pricing, { t: dict[lang], lang, headingLevel: 1 });
      expect(count(h, 'class="s-card')).toBe(PUBLIC_TIERS.length);
      expect(count(h, 'class="s-btn')).toBe(PUBLIC_TIERS.length);
      expect(count(h, "s-btn--ghost")).toBe(PUBLIC_TIERS.length - dict[lang].pricing.plans.filter((p) => p.highlight).length);
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
    });

    it(`faq and the closing call · ${lang}`, () => {
      const faq = html(Faq, { t: dict[lang] });
      expect(faq).toMatch(TITLE_SCRIBBLE("h2"));
      expect(count(faq, "<details")).toBe(dict[lang].faq.items.length);
      const cta = html(FinalCta, { t: dict[lang], lang });
      expect(cta).toMatch(TITLE_SCRIBBLE("h2"));
      expect(cta).toMatch(new RegExp(`<a[^>]*href="/${lang}/app/signup"[^>]*class="s-btn|<a[^>]*class="s-btn[^"]*"[^>]*href="/${lang}/app/signup"`));
    });
  }
});
