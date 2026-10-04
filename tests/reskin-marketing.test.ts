import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dict, type Lang } from "@/lib/i18n";
import { PUBLIC_TIERS } from "@/lib/pricing";
import Pricing from "@/components/Pricing";
import Faq from "@/components/Faq";
import FinalCta from "@/components/FinalCta";
import UrlStart from "@/components/UrlStart";
import AgentsPage from "@/app/[lang]/agents/page";
import AgentPage from "@/app/[lang]/agents/[agent]/page";
import { AGENTS } from "@/lib/agents";
import { existsSync } from "node:fs";
import IndustryPage from "@/app/[lang]/for/[industry]/page";
import VsPage from "@/app/[lang]/vs/[competitor]/page";
import AgentDefinitionPage from "@/app/[lang]/ai-marketing-agent/page";
import CustomersPage from "@/app/[lang]/customers/page";
import EnterprisePage from "@/app/[lang]/enterprise/page";
import ContactForm from "@/components/ContactForm";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { VS_PAGES } from "@/lib/pages-vs";
import { SITE } from "@/lib/site";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en",
  useSearchParams: () => new URLSearchParams(),
}));

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

    it(`agents · ${lang}: every agent in a scribbled card with its own figure`, async () => {
      const h = renderToStaticMarkup(await AgentsPage({ params: Promise.resolve({ lang }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      for (const a of AGENTS) expect(h, a.id).toMatch(new RegExp(`class="s-card[^"]*"[^>]*href="/${lang}/agents/${a.id}"[\\s\\S]*?data-cast="${a.id}"|href="/${lang}/agents/${a.id}"[^>]*class="s-card[\\s\\S]*?data-cast="${a.id}"`));
    });

    it(`an agent's page · ${lang}: the agent standing on its colour, a scribbled start box`, async () => {
      const h = renderToStaticMarkup(await AgentPage({ params: Promise.resolve({ lang, agent: "faris" }) }));
      expect(h).toMatch(/<h1[^>]*>/);
      expect(h).toMatch(/data-cast="faris"/);
      expect(h).toContain("var(--color-agent-faris)");
      expect(count(h, 'class="s-card')).toBeGreaterThanOrEqual(3);
    });

    it(`the URL start box · ${lang}`, () => {
      const h = html(UrlStart, { t: dict[lang], lang });
      expect(h).toMatch(/class="s-input[^"]*"[\s\S]*?<input[^>]*name="url"/);
      expect(h).toMatch(/<button[^>]*class="s-btn/);
    });

    it(`a sector page · ${lang}: an underlined title, a scribbled card per workflow, a pill to sign up`, async () => {
      const p = INDUSTRY_PAGES[lang][0];
      const h = renderToStaticMarkup(await IndustryPage({ params: Promise.resolve({ lang, industry: p.slug }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-card')).toBe(p.workflows.length + PUBLIC_TIERS.length);
      expect(h).toMatch(new RegExp(`<a[^>]*class="s-btn[^"]*"[^>]*href="/${lang}/app/signup"|<a[^>]*href="/${lang}/app/signup"[^>]*class="s-btn`));
    });

    it(`a comparison page · ${lang}: the short answer and both choices in scribbled cards`, async () => {
      const p = VS_PAGES[lang][0];
      const h = renderToStaticMarkup(await VsPage({ params: Promise.resolve({ lang, competitor: p.slug }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-card')).toBe(3);
    });

    it(`the definition page · ${lang}: the definition in a scribbled card, the ask-an-AI links as pills`, async () => {
      const h = renderToStaticMarkup(await AgentDefinitionPage({ params: Promise.resolve({ lang }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-card')).toBe(1);
      expect(count(h, 'class="s-chip')).toBe(3);
    });

    it(`customers · ${lang}: a scribbled card per sector and the scribbled form`, async () => {
      const h = renderToStaticMarkup(await CustomersPage({ params: Promise.resolve({ lang }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      for (const p of INDUSTRY_PAGES[lang]) expect(h, p.slug).toMatch(new RegExp(`href="/${lang}/for/${p.slug}"[^>]*class="s-card|class="s-card[^"]*"[^>]*href="/${lang}/for/${p.slug}"`));
      expect(h).toContain('class="s-input');
    });

    it(`enterprise · ${lang}: a scribbled card per feature and a pill to the form`, async () => {
      const h = renderToStaticMarkup(await EnterprisePage({ params: Promise.resolve({ lang }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-card')).toBe(SITE[lang].enterprise.features.length + 1);
      expect(h).toMatch(/<a[^>]*href="#contact"[^>]*class="s-btn|<a[^>]*class="s-btn[^"]*"[^>]*href="#contact"/);
    });

    it(`the contact form · ${lang}: every field in a scribbled box, a pill to send`, () => {
      const h = html(ContactForm, { lang, kind: "enterprise", page: "/enterprise" });
      expect(count(h, 'class="s-input')).toBe(4);
      expect(h).toMatch(/<button[^>]*class="s-btn/);
      expect(h).not.toContain('class="input');
    });
  }

  it("the old dark homepage hero is gone (no page imports it)", () => {
    expect(existsSync("src/components/Hero.tsx")).toBe(false);
  });
});
