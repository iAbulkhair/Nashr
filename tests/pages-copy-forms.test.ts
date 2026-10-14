import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { dict, type Lang } from "@/lib/i18n";
import { AGENTS, agentById } from "@/lib/agents";
import { isTaskType } from "@/lib/tasks";
import { INTEGRATIONS } from "@/lib/integrations";
import { INDUSTRY_PAGES, INDUSTRY_SLUGS } from "@/lib/pages-industry";
import { AGENTS_VOICE, FOR_VOICE } from "@/lib/pages-voice";
import { SITE } from "@/lib/site";
import { TOOLS } from "@/lib/tools";
import FinalCta, { FINAL_CTA_TITLE } from "@/components/FinalCta";
import ToolForm from "@/components/ToolForm";
import ContactForm from "@/components/ContactForm";
import HelpCenter from "@/components/HelpCenter";
import IndustryPage from "@/app/[lang]/for/[industry]/page";
import AgentsPage from "@/app/[lang]/agents/page";
import AgentPage from "@/app/[lang]/agents/[agent]/page";
import ComparePage from "@/app/[lang]/compare/page";
import AgentDefinitionPage from "@/app/[lang]/ai-marketing-agent/page";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en",
  useSearchParams: () => new URLSearchParams(),
}));

/** Rules 1860-1864 and 1877-1879 (docs/system/tests/1860-pages-copy-forms.md). */
const LANGS: readonly Lang[] = ["ar", "en"];
const html = <P extends object>(c: FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(c, props));
const read = (f: string) => readFileSync(f, "utf8");
const DIGITS = /[0-9٠-٩]/;
/** An <a> to `href` whose class holds the 44px minimum height, in either attribute order (rule 1879). */
const HIT = String.raw`class="[^"]*min-h-\[var\(--hit-min\)\][^"]*"`;
const hitLink = (href: string) => new RegExp(`<a ${HIT} href="${href}"|<a href="${href}" ${HIT}`);

describe("rule 1860: /for/ecommerce says only what works today", () => {
  it("the store connections it names are not live in the catalog", () => {
    for (const id of ["salla", "zid", "shopify"]) expect(INTEGRATIONS.find((x) => x.id === id)?.status, id).not.toBe("live");
  });

  for (const lang of LANGS) {
    const p = INDUSTRY_PAGES[lang].find((x) => x.slug === "ecommerce")!;
    it(`${lang}: no store connection is promised as live; products come from the store's URL`, () => {
      const claims = [p.headline, p.sub, ...p.pains, ...p.workflows.flatMap((w) => [w.t, w.d])].join(" ");
      // Whole words only: «السلة المتروكة» (an abandoned cart) is not «سلة» (the Salla platform).
      expect(claims).not.toMatch(/(^|[\s،(])(سلة|زد|شوبيفاي)(?=[\s،.)]|$)|\b(Salla|Zid|Shopify|WooCommerce)\b/i);
      expect(claims).toMatch(lang === "ar" ? /رابط متجرك/ : /store's URL/);
      const store = p.faq.find((f) => (lang === "ar" ? /سلة/ : /Salla/).test(f.a));
      expect(store, "the FAQ says when the connection comes").toBeTruthy();
      expect(store!.a).toMatch(lang === "ar" ? /ما هو شغّال اليوم/ : /not live today/);
    });
  }
});

describe("rule 1861: the closing call has its own title", () => {
  for (const lang of LANGS) {
    it(`${lang}: FinalCta names the team and no longer repeats the hero line`, () => {
      const h = html(FinalCta, { t: dict[lang], lang });
      expect(h).toContain(FINAL_CTA_TITLE[lang]);
      expect(h).not.toContain(dict[lang].hero.title2);
      expect(h).toContain(dict[lang].pricing.trial);
    });
  }
  it("the title lives outside the pricing block of i18n.ts", () => {
    expect(read("src/lib/i18n.ts")).not.toContain(FINAL_CTA_TITLE.ar);
  });
});

describe("rule 1862: /for/* and /agents speak in the home page's voice, with the figures", () => {
  it("every sector page's team line is tied to a task its agent owns, with no numbers, in both languages", () => {
    for (const slug of INDUSTRY_SLUGS) {
      const ar = INDUSTRY_PAGES.ar.find((x) => x.slug === slug)!, en = INDUSTRY_PAGES.en.find((x) => x.slug === slug)!;
      expect(ar.team.length, slug).toBeGreaterThan(0);
      expect(ar.team.map((m) => `${m.who}/${m.task}`), slug).toEqual(en.team.map((m) => `${m.who}/${m.task}`));
      for (const m of [...ar.team, ...en.team]) {
        expect(isTaskType(m.task), `${slug} ${m.task}`).toBe(true);
        expect(agentById(m.who).tasks, `${slug} ${m.who}`).toContain(m.task);
        expect(m.line, `${slug} ${m.who}`).not.toMatch(DIGITS);
      }
    }
  });

  for (const lang of LANGS) {
    it(`${lang}: a sector page shows the lead's figure and each member's face, bubble and link`, async () => {
      const p = INDUSTRY_PAGES[lang].find((x) => x.slug === "ecommerce")!;
      const h = renderToStaticMarkup(await IndustryPage({ params: Promise.resolve({ lang, industry: p.slug }) }));
      expect(h).toContain(`data-for-lead="${p.team[0].who}"`);
      expect(h).toContain(FOR_VOICE[lang].team);
      for (const m of p.team) {
        expect(h).toContain(`data-who="${m.who}"`);
        // Rule 1879: the member link is a 44px target.
        expect(h).toMatch(hitLink(`/${lang}/agents/${m.who}`));
        expect(h).toContain(m.line.replaceAll("'", "&#x27;"));
      }
      expect(h).toMatch(/class="s-bubble"/);
    });

    it(`${lang}: /agents opens with the team in one chat and each agent's own question`, async () => {
      const h = renderToStaticMarkup(await AgentsPage({ params: Promise.resolve({ lang }) }));
      expect(h).toContain(AGENTS_VOICE[lang].title);
      expect((h.match(/data-on-mind/g) ?? []).length).toBe(AGENTS.length);
    });

    it(`${lang}: an agent's page carries its thought cloud and the voice headings`, async () => {
      const h = renderToStaticMarkup(await AgentPage({ params: Promise.resolve({ lang, agent: "razan" }) }));
      expect(h).toMatch(/class="s-cloud[^"]*"[^>]*data-on-mind/);
      for (const k of ["does", "works", "asks", "others"] as const) expect(h, k).toContain(AGENTS_VOICE[lang][k]);
      expect(h).not.toContain(SITE[lang].agents.startWith);
      expect(h).toMatch(hitLink(`/${lang}/agents/noor`));
    });
  }

  it("the /agents count matches the team", () => {
    expect(AGENTS.length).toBe(8);
    expect(AGENTS_VOICE.ar.title).toContain("ثمانية");
    expect(AGENTS_VOICE.en.title).toMatch(/^Eight /);
  });
});

/** The public pages this change owns; the home page has its own check in tests/global-nav.test.ts. */
const PAGES = ["pricing", "staging-access", "agents", "agents/[agent]", "for/[industry]", "compare", "ai-marketing-agent", "blog", "blog/[slug]", "customers", "enterprise", "help", "privacy", "terms", "resources", "tools", "tools/[tool]", "updates", "affiliates", "affiliates/terms"].map((p) => `src/app/[lang]/${p}/page.tsx`);

describe("rule 1863: one <main id=\"main\"> holds the closing call; fixed-size scribbles are drawn on the server", () => {
  it("every owned public page has a focusable main#main, and FinalCta sits inside it", () => {
    for (const f of PAGES) {
      const s = read(f);
      expect(s, f).toMatch(/<main id="main" tabIndex=\{-1\}/);
      expect((s.match(/<main\b/g) ?? []).length, f).toBe(1);
      const cta = s.indexOf("<FinalCta"), end = s.indexOf("</main>");
      if (cta >= 0) expect(cta, f).toBeLessThan(end);
    }
  });

  it("the language's error and not-found pages are #main too, so the skip link always lands", () => {
    for (const f of ["src/app/[lang]/error.tsx", "src/app/[lang]/not-found.tsx"]) expect(read(f), f).toMatch(/<main id="main" tabIndex=\{-1\}/);
  });

  for (const lang of LANGS) {
    it(`${lang}: the rendered closing call is inside main on the moved pages`, async () => {
      for (const h of [
        renderToStaticMarkup(await ComparePage({ params: Promise.resolve({ lang }) })),
        renderToStaticMarkup(await AgentDefinitionPage({ params: Promise.resolve({ lang }) })),
      ]) {
        const main = h.slice(h.indexOf('<main id="main"'), h.indexOf("</main>"));
        expect(main).toContain('id="start"');
      }
    });
  }

  it("underlines and ticks are ScribbleStatic with an explicit rtl in the owned files", () => {
    const files = [...PAGES, "src/components/TickList.tsx", "src/components/HelpCenter.tsx", "src/components/FinalCta.tsx", "src/components/Faq.tsx"];
    for (const f of files) {
      const s = read(f);
      expect(s, f).not.toMatch(/<Scribble kind="(underline|tick)"/);
      for (const m of s.matchAll(/<ScribbleStatic [^>]*\/>/g)) expect(m[0], f).toMatch(/rtl=\{/);
    }
  });

  it("the /compare and definition tables mark their row headers", async () => {
    for (const lang of LANGS) {
      const h = renderToStaticMarkup(await ComparePage({ params: Promise.resolve({ lang }) }));
      expect(h).toMatch(/<th scope="row"/);
      expect(h).not.toMatch(/<th[^>]*><\/th>/);
      const d = renderToStaticMarkup(await AgentDefinitionPage({ params: Promise.resolve({ lang }) }));
      expect(d).toMatch(/<th scope="row"/);
      expect(d).not.toMatch(/<th[^>]*><\/th>/);
    }
  });
});

describe("rule 1864: the free tool form recovers from failure and says what happened", () => {
  const src = read("src/components/ToolForm.tsx");
  it("the request is wrapped so the button always comes back, and copying is confirmed in words", () => {
    expect(src).toMatch(/try \{[\s\S]*await fetch[\s\S]*\} catch \{[\s\S]*\} finally \{[\s\S]*setBusy\(false\)/);
    expect(src).toContain("تم النسخ");
    expect(src).toContain('"Copied"');
    expect(src).toContain("COPIED_MS");
    expect(src).not.toMatch(/3 أيام|3 days/);
  });

  for (const lang of LANGS) {
    it(`${lang}: the result area is a polite live region and the trial words come from the plan`, () => {
      for (const t of TOOLS) {
        const h = html(ToolForm, { tool: t, lang, trial: dict[lang].pricing.trial });
        expect(h, t.slug).toMatch(/<div aria-live="polite"/);
        expect(h, t.slug).toContain(dict[lang].pricing.trial);
      }
    });
  }

  it("the tool page passes the plan's trial words", () => {
    expect(read("src/app/[lang]/tools/[tool]/page.tsx")).toMatch(/<ToolForm [^>]*trial=\{t\.pricing\.trial\}/);
  });
});

describe("rules 1877-1879: forms have visible labels that work in both directions", () => {
  for (const lang of LANGS) {
    it(`${lang}: every contact field has a visible label around its box`, () => {
      const f = SITE[lang].form;
      const h = html(ContactForm, { lang, kind: "enterprise", page: "/enterprise" });
      expect((h.match(/<label /g) ?? []).length).toBe(4);
      for (const w of [f.name, f.email, f.company, f.message]) expect(h, w).toMatch(new RegExp(`<label[^>]*text-start[^>]*><span>${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`));
      expect(h).not.toContain("aria-label=");
      expect(h).toMatch(/type="email"[^>]*inputMode="email"|inputMode="email"[^>]*type="email"/);
    });

    it(`${lang}: the help search and the support form have visible labels`, () => {
      const h = html(HelpCenter, { lang, wa: null, origin: "https://example.test" });
      expect(h).toMatch(/<div role="search"[^>]*><label[^>]*><span>[^<]+<\/span>[\s\S]*?<input type="search"/);
      expect((h.match(/<label /g) ?? []).length).toBe(4);
      expect((h.match(/class="s-input/g) ?? []).length).toBe(4);
      expect(h).not.toMatch(/aria-label="(Email|Type|Message|بريدك الإلكتروني|النوع|الرسالة)"/);
    });
  }

  it("the support request shows its error when the connection drops", () => {
    expect(read("src/components/HelpCenter.tsx")).toMatch(/fetch\("\/api\/support"[\s\S]*?\.catch\(\(\) => null\)/);
    expect(read("src/components/ContactForm.tsx")).toMatch(/fetch\("\/api\/support"[\s\S]*?\.catch\(\(\) => null\)/);
  });
});
