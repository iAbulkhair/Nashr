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
import ComparePage from "@/app/[lang]/compare/page";
import AgentDefinitionPage from "@/app/[lang]/ai-marketing-agent/page";
import CustomersPage from "@/app/[lang]/customers/page";
import EnterprisePage from "@/app/[lang]/enterprise/page";
import ContactForm from "@/components/ContactForm";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { COMPARE_PAGE } from "@/lib/pages-compare";
import { SITE } from "@/lib/site";
import { readFileSync } from "node:fs";
import { TOOLS } from "@/lib/tools";
import { listPosts } from "@/lib/blog";
import ToolsPage from "@/app/[lang]/tools/page";
import ToolPage from "@/app/[lang]/tools/[tool]/page";
import ToolForm from "@/components/ToolForm";
import BlogPage from "@/app/[lang]/blog/page";
import PostPage from "@/app/[lang]/blog/[slug]/page";
import HelpCenter from "@/components/HelpCenter";
import ResourcesPage from "@/app/[lang]/resources/page";
import WishSuggest from "@/components/WishSuggest";
import WishVote from "@/components/WishVote";
import UpdatesPage from "@/app/[lang]/updates/page";
import AffiliatesPage from "@/app/[lang]/affiliates/page";
import PartnerTermsPage from "@/app/[lang]/affiliates/terms/page";
import AffiliateForm from "@/components/AffiliateForm";
import PrivacyPage from "@/app/[lang]/privacy/page";
import TermsPage from "@/app/[lang]/terms/page";
import NotFound from "@/app/[lang]/not-found";
import RouteError from "@/app/[lang]/error";

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

    it(`the comparison page · ${lang}: the disclosure and both choices of every kind in scribbled cards`, async () => {
      const h = renderToStaticMarkup(await ComparePage({ params: Promise.resolve({ lang }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-card')).toBe(1 + 2 * COMPARE_PAGE[lang].groups.length);
    });

    it(`the definition page · ${lang}: the definition in a scribbled card, the ask-an-AI links as pills`, async () => {
      const h = renderToStaticMarkup(await AgentDefinitionPage({ params: Promise.resolve({ lang }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-card')).toBe(1);
      expect(count(h, 'class="s-chip')).toBe(2);
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

  for (const lang of LANGS) {
    it(`tools · ${lang}: a scribbled card per tool; a tool's form in scribbled boxes`, async () => {
      const h = renderToStaticMarkup(await ToolsPage({ params: Promise.resolve({ lang }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-card')).toBe(TOOLS.length);
      const x = TOOLS[0];
      const page = renderToStaticMarkup(await ToolPage({ params: Promise.resolve({ lang, tool: x.slug }) }));
      expect(page).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(page, 'class="s-chip')).toBe(TOOLS.length - 1);
      for (const t of TOOLS) {
        const f = html(ToolForm, { tool: t, lang, trial: dict[lang].pricing.trial });
        expect(count(f, 'class="s-input'), t.slug).toBe(t.fields.length);
        expect(f).toMatch(/<button[^>]*class="s-btn/);
        expect(f).not.toMatch(/class="input/);
      }
    });

    it(`blog · ${lang}: a scribbled card per post, an underlined post title`, async () => {
      const posts = listPosts(lang);
      const h = renderToStaticMarkup(await BlogPage({ params: Promise.resolve({ lang }), searchParams: Promise.resolve({}) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-card')).toBe(posts.length);
      const post = renderToStaticMarkup(await PostPage({ params: Promise.resolve({ lang, slug: posts[0].slug }) }));
      expect(post).toMatch(TITLE_SCRIBBLE("h1"));
      expect(post).toContain('class="prose-nashr');
    });

    it(`help · ${lang}: scribbled search, topic pills that say which is on, a scribbled support form`, () => {
      const h = html(HelpCenter, { lang, wa: "https://wa.me/1", origin: "https://example.test" });
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-input')).toBe(4);
      expect(h).toMatch(/<button[^>]*aria-pressed="true"[^>]*class="s-chip|<button[^>]*class="s-chip[^"]*"[^>]*aria-pressed="true"/);
      expect(h).toMatch(/<button[^>]*class="s-btn/);
      expect(h).not.toMatch(/class="input/);
    });

    it(`resources · ${lang}: a scribbled card per resource and post, comparisons as pills`, async () => {
      const h = renderToStaticMarkup(await ResourcesPage({ params: Promise.resolve({ lang }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-card')).toBe(SITE[lang].resources.cards.length + Math.min(3, listPosts(lang).length));
      expect(count(h, 'class="s-chip')).toBe(1);
    });
  }

  for (const lang of LANGS) {
    it(`partners · ${lang}: a scribbled card per number, the application in scribbled boxes`, async () => {
      const h = renderToStaticMarkup(await AffiliatesPage({ params: Promise.resolve({ lang }) }));
      expect(h).toMatch(TITLE_SCRIBBLE("h1"));
      expect(count(h, 'class="s-card')).toBe(5);
      const f = html(AffiliateForm, { lang });
      expect(count(f, 'class="s-input')).toBe(6); // name, email, phone, country (rule 1470), channel, audience
      expect(f).toContain("data-terms-consent");
      expect(f).toMatch(/<button[^>]*class="s-btn/);
      expect(f).not.toMatch(/class="input/);
    });

    it(`the legal pages · ${lang}: underlined titles`, async () => {
      for (const P of [PrivacyPage, TermsPage, PartnerTermsPage]) {
        expect(renderToStaticMarkup(await P({ params: Promise.resolve({ lang }) }))).toMatch(TITLE_SCRIBBLE("h1"));
      }
    });
  }

  it("the 404 and the error screen: a 404 stamp, ink and ghost pills home", () => {
    const nf = renderToStaticMarkup(createElement(NotFound));
    expect(nf).toMatch(/class="s-stamp[^"]*"[\s\S]*?404/);
    expect(count(nf, 'class="s-btn')).toBe(2);
    expect(count(nf, "s-btn--ghost")).toBe(1);
    const er = renderToStaticMarkup(createElement(RouteError, { error: Object.assign(new Error("x"), { digest: "d1" }), reset: () => {} }));
    expect(er).toMatch(/<button[^>]*class="s-btn/);
    expect(er).toMatch(/<a[^>]*class="s-btn s-btn--ghost/);
  });

  it("the last-resort error screen uses D's paper, ink and muted values (it cannot load the app's styles)", () => {
    const src = readFileSync("src/app/global-error.tsx", "utf8");
    for (const old of ["#f6f4ee", "#101418", "#0f3d3a", "#e9f0ec", "#555"]) expect(src, old).not.toContain(old);
    for (const d of ["#f7f3f9", "#2b193d", "#5d4a70"]) expect(src, d).toContain(d);
  });

  it("updates: an underlined title, the two section tabs as pills, the sign-in call as an ink pill", async () => {
    const h = renderToStaticMarkup(await UpdatesPage({ params: Promise.resolve({ lang: "en" }) }));
    expect(h).toMatch(TITLE_SCRIBBLE("h1"));
    expect(count(h, 'class="s-chip')).toBe(2);
    expect(h).toMatch(/<a[^>]*class="s-btn[^"]*"[^>]*href="\/en\/app\/login/);
  });

  it("the wishlist: a scribbled suggestion box and a vote pill that says when it is on", () => {
    const labels = { title: "T", sub: "S", placeholder: "P", send: "Send", sent: "ok", note: "N", tooShort: "s", tooLong: "l", failed: "f", slowDown: "w", vote: "Vote", voted: "Voted", votesLabel: "votes" };
    const s = html(WishSuggest, { lang: "en", labels });
    expect(s).toMatch(/class="s-card/);
    expect(s).toMatch(/class="s-input[^"]*"[\s\S]*?<textarea[^>]*id="wish-suggest"/);
    expect(s).toMatch(/<button[^>]*class="s-btn/);
    const v = html(WishVote, { id: "w", votes: 3, voted: true, title: "X", labels, loginHref: "/en/app/login" });
    expect(v).toMatch(/<button[^>]*class="s-chip[^"]*"[^>]*aria-pressed="true"|<button[^>]*aria-pressed="true"[^>]*class="s-chip/);
  });

  it("long-form prose speaks D: ink headings and links, a drawn rule under table heads", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const prose = css.split("\n").filter((l) => l.startsWith(".prose-nashr")).join("\n");
    // Ink through the foreground and border-strong roles since rule 1202, so the dark theme reaches prose too.
    expect(prose).not.toMatch(/--color-(primary|accent|ink)\b/);
    expect(prose).toMatch(/\.prose-nashr th \{[^}]*border-bottom: 1\.5px solid var\(--color-border-strong\)/);
  });

  it("the old dark homepage hero is gone (no page imports it)", () => {
    expect(existsSync("src/components/Hero.tsx")).toBe(false);
  });
});
