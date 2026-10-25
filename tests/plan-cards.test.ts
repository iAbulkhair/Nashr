// The plan cards after the site critique of 2026-10-14 (docs/system/tests/1849-plan-cards.md): one shared card on the home
// page and /pricing (rule 1849), the seats, social posts and chat on every card (1850), a credits-to-output line from the
// code tables (1851), aligned prices and real buttons (1852), the pricing section's semantics (1853), and Razan's credit
// calculator on /pricing (1885-1887). Static renders in both languages, source reads and the pure helpers.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chatMessagesText, creditCost, dict, mostOf, reachText, seatsText, LANGS, type Lang } from "@/lib/i18n";
import { AGENT_CAST } from "@/lib/home";
import { AGENCY_MIN, PLAN_CREDITS, PLAN_PRICE_SAR, PLAN_SEATS, PUBLIC_TIERS, SELF_SERVE_PLANS, CHAT_ALLOWANCE, smallestPlanFor } from "@/lib/pricing";
import { TASK_COST, TASK_COUNT, isTaskType } from "@/lib/tasks";
import Plans from "@/components/home/Plans";
import Pricing from "@/components/Pricing";
import { HOME_FEATURES, planHref } from "@/components/PlanCard";
import CreditCalculator, { CALC_COPY, CALC_TYPES } from "@/components/CreditCalculator";
import CreditCalculatorForm, { CALC_MAX, calcResult, clampCount, creditsFor, type CalcPlan, type CalcRow } from "@/components/CreditCalculatorForm";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  usePathname: () => "/ar",
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
}));

const read = (f: string) => readFileSync(f, "utf8");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const CSS = read("src/components/home/home.module.css").replace(/\/\*[\s\S]*?\*\//g, "");
/** React escapes these in text; compare against what the markup really contains. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const noSvg = (s: string) => s.replace(/<svg[\s\S]*?<\/svg>/g, "");
/** The markup of each card, keyed by tier, without its drawings. */
const cards = (html: string): Record<string, string> =>
  Object.fromEntries(noSvg(html).split('<li data-tier="').slice(1).map((c) => [c.slice(0, c.indexOf('"')), c]));
const homeHtml = (lang: Lang) => renderToStaticMarkup(h(Plans, { t: dict[lang], lang }));
/** The markup without the hidden yearly panel: since yearly billing (rule 4035) it draws the plan cards a second time; tests/yearly-pricing-on.test.ts covers it. */
const monthlyOnly = (h: string) => h.replace(/<div id="[^"]*" hidden="" data-interval-panel="year">[\s\S]*?<\/ul><\/div><\/div>/, "");
const pricingHtml = (lang: Lang, headingLevel?: 1 | 2) => monthlyOnly(renderToStaticMarkup(h(Pricing, { t: dict[lang], lang, headingLevel })));
const plan = (lang: Lang, id: string) => dict[lang].pricing.plans.find((p) => p.id === id)!;
/** The text a file shows: its string and template literals, minus import paths, class lists, seeds and drawing kinds. */
const copyOf = (f: string): string[] =>
  [...code(f).matchAll(/(className|from|seed|kind|fill|tail|dir|id|htmlFor|type|inputMode|role|data-tail|aria-live)?(=|\s)?(["`])((?:(?!\3)[\s\S])*)\3/g)]
    .filter((m) => !m[1])
    .map((m) => m[4].replace(/\$\{[^}]*\}/g, ""))
    .filter((s) => !/^(h[1-6]|ltr|use client|react|button|number|numeric|polite|list|start|paper|surface|lilac|ink|lemon)$/.test(s));
const featureItems =(card: string) => (card.match(/<ul class="_feat_[^"]*" role="list">([\s\S]*?)<\/ul>/)?.[1].match(/<li>/g) ?? []).length;

describe("rule 1849: one plan card on the home page and /pricing", () => {
  it("both sections render the shared PlanList, and neither draws its own card", () => {
    for (const f of ["src/components/home/Plans.tsx", "src/components/Pricing.tsx"]) {
      const src = code(f);
      expect(src, f).toMatch(/import \{[^}]*\bPlanList\b[^}]*\} from "@\/components\/PlanCard"/);
      expect(src, f).toMatch(/<PlanList /);
      expect(src, f).not.toMatch(/data-tier|kind="tick"|plan\.features/);
    }
    expect(read("src/components/PlanCard.tsx")).not.toMatch(/^\s*["']use client["']/);
  });

  for (const lang of LANGS) {
    it(`the same card, in the public order, with the home card listing the first ${HOME_FEATURES} features (${lang})`, () => {
      const home = cards(homeHtml(lang));
      const full = cards(pricingHtml(lang));
      expect(Object.keys(home)).toEqual([...PUBLIC_TIERS]);
      expect(Object.keys(full)).toEqual([...PUBLIC_TIERS]);
      for (const id of PUBLIC_TIERS) {
        const p = plan(lang, id);
        // The card's opening, up to its features, is the same markup on both pages (the heading level aside).
        const head = (c: string) => c.slice(0, c.indexOf("<ul")).replace(/<(\/?)h[23]/g, "<$1h");
        expect(head(home[id]), `${lang} ${id}`).toBe(head(full[id]));
        expect(featureItems(home[id]), `${lang} ${id}`).toBe(Math.min(HOME_FEATURES, p.features.length));
        expect(featureItems(full[id]), `${lang} ${id}`).toBe(p.features.length);
        for (const f of p.features.slice(0, HOME_FEATURES)) expect(home[id], `${lang} ${id}`).toContain(esc(f));
        for (const s of [p.name, p.tagline, p.price, p.period, p.credits, p.output, p.cta]) expect(home[id], `${lang} ${id}: ${s}`).toContain(esc(s));
      }
    });
  }
});

describe("rule 1850: seats, social posts and chat open every card", () => {
  const SOCIAL: Record<Lang, string> = { ar: "منشورات سوشال", en: "Social posts" };
  for (const lang of LANGS) {
    it(`every plan lists its seats, then social posts, then chat, so the home card shows them (${lang})`, () => {
      for (const id of PUBLIC_TIERS) {
        const f = plan(lang, id).features;
        expect(f[0], `${lang} ${id}`).toMatch(lang === "en" ? /\bseats?\b/i : /مقعد|مقاعد/);
        expect(f[1], `${lang} ${id}`).toBe(SOCIAL[lang]);
        expect(f[2], `${lang} ${id}`).toMatch(lang === "en" ? /chat messages/ : /رسائل محادثة|رسالة محادثة/);
        expect(f.filter((x) => x === SOCIAL[lang]), `${lang} ${id}: once`).toHaveLength(1);
      }
      for (const k of SELF_SERVE_PLANS) {
        expect(plan(lang, k).features[0], `${lang} ${k}`).toContain(seatsText(lang, PLAN_SEATS[k]));
        expect(plan(lang, k).features[2], `${lang} ${k}`).toContain(chatMessagesText(lang, CHAT_ALLOWANCE[k]));
      }
      const home = cards(homeHtml(lang));
      expect(home.pro, lang).toContain(seatsText(lang, PLAN_SEATS.pro));
      expect(home.business, lang).toContain(seatsText(lang, PLAN_SEATS.business));
      expect(seatsText(lang, PLAN_SEATS.pro)).toBe(lang === "en" ? "3 seats" : "3 مقاعد");
      expect(seatsText(lang, PLAN_SEATS.business)).toBe(lang === "en" ? "7 seats" : "7 مقاعد");
      for (const id of PUBLIC_TIERS) expect(home[id], `${lang} ${id}`).toContain(SOCIAL[lang]);
    });
  }

  it("the billing page's first four features keep the seats and the chat messages", () => {
    expect(read("src/app/[lang]/app/settings/billing/page.tsx")).toContain("features={plan.features.slice(0, 4)}");
    for (const lang of LANGS) for (const k of SELF_SERVE_PLANS) {
      const four = plan(lang, k).features.slice(0, 4).join(" · ");
      expect(four, `${lang} ${k}`).toContain(seatsText(lang, PLAN_SEATS[k]));
      expect(four, `${lang} ${k}`).toContain(chatMessagesText(lang, CHAT_ALLOWANCE[k]));
    }
  });
});

describe("rule 1851: one credits-to-output line per plan, computed from the code tables", () => {
  it("counts whole batches of TASK_COST, TASK_COUNT items each", () => {
    for (const credits of [0, 1, 9, 10, 299, PLAN_CREDITS.starter, PLAN_CREDITS.business]) {
      expect(mostOf("social", credits)).toBe(Math.floor(credits / TASK_COST.social) * TASK_COUNT.social);
      expect(mostOf("article", credits)).toBe(Math.floor(credits / TASK_COST.article) * TASK_COUNT.article);
    }
  });

  for (const lang of LANGS) {
    it(`every card's line is reachText of its plan's credits, says "up to" and "or" (${lang})`, () => {
      for (const k of SELF_SERVE_PLANS) expect(plan(lang, k).output, `${lang} ${k}`).toBe(reachText(lang, PLAN_CREDITS[k]));
      expect(plan(lang, "agency").output, lang).toBe(reachText(lang, AGENCY_MIN.credits, true));
      for (const id of PUBLIC_TIERS) {
        const line = plan(lang, id).output;
        expect(line, `${lang} ${id}`).toMatch(lang === "en" ? /\bup to\b[\s\S]*\bor\b/ : /حتى[\s\S]* أو /);
        expect(line, `${lang} ${id}`).not.toMatch(lang === "en" ? /\band\b|guarantee/i : / و\d|نضمن|مضمون/);
      }
      const pro = plan(lang, "pro").output;
      const fc = (n: number) => n.toLocaleString("en-US");
      expect(pro).toContain(fc(mostOf("social", PLAN_CREDITS.pro)));
      expect(pro).toContain(fc(mostOf("article", PLAN_CREDITS.pro)));
    });
  }

  it("the Arabic noun follows the count, and no output number is typed into the copy", () => {
    expect(reachText("ar", 300)).toBe("تكفي حتى 300 منشور سوشال أو 150 مقال SEO شهرياً");
    expect(reachText("ar", 10)).toBe("تكفي حتى 10 منشورات سوشال أو 5 مقالات SEO شهرياً");
    expect(reachText("en", 2)).toBe("Enough for up to 0 social posts or 1 SEO article a month");
    const i18n = code("src/lib/i18n.ts");
    expect(i18n.match(/output: reachText\(/g)).toHaveLength(2 * PUBLIC_TIERS.length);
    for (const s of copyOf("src/components/PlanCard.tsx")) expect(s).not.toMatch(/\d/);
  });
});

describe("rule 1852: aligned prices and a real button on every card", () => {
  it("the cards share their rows through a subgrid, and the button is at least the hit size", () => {
    expect(CSS).toMatch(/@supports \(grid-template-rows: subgrid\) \{\s*\.plan \{[^}]*grid-row: span 5;[^}]*grid-template-rows: subgrid;/);
    expect(CSS).toMatch(/\.planCta \{[^}]*min-block-size: var\(--hit-min\)/);
    expect(CSS).toMatch(/\.plansBox \{[^}]*container-type: inline-size/);
    // The plan rules use logical sides only.
    const planRules = CSS.match(/\.(plansBox|plans|plan|planHead|planName|planTag|planTape|price|priceN|planCredits|planCr|planOut|feat|mk|planCta)(?![\w-])[^{]*\{[^}]*\}/g) ?? [];
    expect(planRules.length).toBeGreaterThan(8);
    for (const r of planRules) expect(r).not.toMatch(/\b(margin|padding|border)-(left|right|top|bottom)\b|[\s;{](left|right|top|bottom|width|height):|box-shadow|#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(code("src/components/PlanCard.tsx")).not.toMatch(/\bshadow\b/);
  });

  for (const lang of LANGS) {
    it(`each card is five rows (head, price, credits, features, button), the button an s-btn pill to its page (${lang})`, () => {
      for (const html of [homeHtml(lang), pricingHtml(lang), pricingHtml(lang, 1)]) {
        const c = cards(html);
        for (const id of PUBLIC_TIERS) {
          const p = plan(lang, id);
          const row = new RegExp(
            `^${id}" class="s-card _plan_[\\w-]+"><div class="_planHead_[\\w-]+">[\\s\\S]*?</div><p class="_price_[\\w-]+">[\\s\\S]*?</p><div class="_planCredits_[\\w-]+">[\\s\\S]*?</div><ul class="_feat_[\\w-]+" role="list">[\\s\\S]*?</ul><a class="([^"]*)" href="([^"]*)">([^<]*)</a></li>`,
          );
          const m = c[id].match(row);
          expect(m, `${lang} ${id}`).not.toBeNull();
          const [, cls, href, label] = m!;
          expect(cls.split(" "), `${lang} ${id}`).toContain("s-btn");
          expect(cls.includes("s-btn--ghost"), `${lang} ${id}: ghost unless highlighted`).toBe(!p.highlight);
          expect(href).toBe(planHref(lang, id));
          expect(href).toBe(id === "agency" ? `/${lang}/enterprise#contact` : `/${lang}/app/signup`);
          expect(label).toBe(esc(p.cta));
        }
        for (const k of SELF_SERVE_PLANS) expect(c[k]).toContain(`dir="ltr">${PLAN_PRICE_SAR[k]}</span>`);
      }
      expect(PUBLIC_TIERS.filter((id) => plan(lang, id).highlight)).toEqual(["pro"]);
    });
  }
});

describe("rule 1853: the pricing section's headings, table and drawings", () => {
  for (const lang of LANGS) {
    it(`cards and the credits title sit one level under the section heading; the table's action cells are row headers (${lang})`, () => {
      const page = pricingHtml(lang, 1);
      const section = pricingHtml(lang);
      expect(page.match(/<h1\b/g)).toHaveLength(1);
      expect(page.match(/<h2 class="_planName_/g)).toHaveLength(PUBLIC_TIERS.length);
      expect(page).not.toMatch(/<h3\b/);
      expect(page).toMatch(/<h2 id="pricing-credits-h"/);
      expect(section).not.toMatch(/<h1\b/);
      expect(section.match(/<h3 class="_planName_/g)).toHaveLength(PUBLIC_TIERS.length);
      expect(section).toMatch(/<h3 id="pricing-credits-h"/);
      expect(page.match(/<th scope="row"/g)).toHaveLength(dict[lang].pricing.credits.length);
      expect(page).toMatch(/<table[^>]*aria-labelledby="pricing-credits-h"/);
      expect(homeHtml(lang).match(/<h3 class="_planName_/g)).toHaveLength(PUBLIC_TIERS.length);
    });
  }

  it("underlines and ticks are drawn on the server in the page's direction; shapes that measure their box stay client", () => {
    for (const f of ["src/components/PlanCard.tsx", "src/components/Pricing.tsx", "src/components/home/Plans.tsx", "src/components/CreditCalculator.tsx", "src/components/CreditCalculatorForm.tsx"]) {
      const src = code(f);
      expect(src, f).not.toMatch(/<Scribble kind="(underline|tick|divider)"/);
      for (const tag of src.match(/<ScribbleStatic [^>]*\/>/g) ?? []) expect(tag, `${f}: ${tag}`).toMatch(/\brtl=\{/);
    }
    expect(code("src/components/PlanCard.tsx")).toMatch(/<ScribbleStatic kind="tick"/);
    expect(code("src/components/Pricing.tsx")).toMatch(/<ScribbleStatic kind="underline"/);
    // Arabic draws the tick mirrored, so the direction really reaches the markup.
    const tick = (lang: Lang) => cards(monthlyOnly(renderToStaticMarkup(h(Pricing, { t: dict[lang], lang }))).replace(/<i class="_mk_[^"]*" aria-hidden="true">/g, "§")).starter;
    expect(renderToStaticMarkup(h(Pricing, { t: dict.ar, lang: "ar" }))).toContain('class="_mk_');
    expect(tick("ar")).toContain("§");
  });
});

describe("rules 1885-1887: Razan's credit calculator on /pricing", () => {
  const rowsFor = (): CalcRow[] => CALC_TYPES.map((r) => ({ type: r.type, label: r.label.en, cost: creditCost(r.type, r.perItem), start: r.start }));
  const plansFor = (lang: Lang): CalcPlan[] =>
    PUBLIC_TIERS.map((id) => ({ id, name: plan(lang, id).name, credits: id === "agency" ? AGENCY_MIN.credits : PLAN_CREDITS[id], price: plan(lang, id).price, period: plan(lang, id).period }));

  it("1885: asks about real task types, priced by creditCost, and picks the cheapest plan that covers the total", () => {
    for (const r of CALC_TYPES) {
      expect(isTaskType(r.type), r.type).toBe(true);
      expect(r.label.ar && r.label.en, r.type).toBeTruthy();
    }
    expect(CALC_TYPES.map((r) => r.type)).toContain("social");
    const rows = rowsFor();
    expect(rows.find((r) => r.type === "social")!.cost).toBe(TASK_COST.social / TASK_COUNT.social);
    expect(rows.find((r) => r.type === "article")!.cost).toBe(TASK_COST.article);
    expect(creditsFor(rows, rows.map(() => 0))).toBe(0);
    expect(creditsFor(rows, rows.map((_, i) => i + 1))).toBe(Math.ceil(rows.reduce((s, r, i) => s + (i + 1) * r.cost, 0)));
    expect(creditsFor(rows, rows.map(() => CALC_MAX + 50))).toBe(Math.ceil(rows.reduce((s, r) => s + CALC_MAX * r.cost, 0)));

    expect([0, -5, Number.NaN].map(smallestPlanFor)).toEqual(["starter", "starter", "starter"]);
    expect(smallestPlanFor(PLAN_CREDITS.starter)).toBe("starter");
    expect(smallestPlanFor(PLAN_CREDITS.starter + 1)).toBe("pro");
    expect(smallestPlanFor(PLAN_CREDITS.pro)).toBe("pro");
    expect(smallestPlanFor(PLAN_CREDITS.pro + 1)).toBe("business");
    expect(smallestPlanFor(PLAN_CREDITS.business)).toBe("business");
    expect(smallestPlanFor(PLAN_CREDITS.business + 1)).toBe("agency");

    for (const lang of LANGS) {
      const plans = plansFor(lang);
      const pro = calcResult(lang, PLAN_CREDITS.starter + 1, plans);
      expect(pro, lang).toContain(plan(lang, "pro").name);
      expect(pro, lang).toContain(plan(lang, "pro").price);
      expect(pro, lang).toContain(PLAN_CREDITS.pro.toString());
      const agency = calcResult(lang, PLAN_CREDITS.business + 1, plans);
      expect(agency, lang).toContain(plan(lang, "agency").name);
      expect(agency, lang).toMatch(lang === "en" ? /contact us/ : /كلّمنا/);
      for (const s of [pro, agency, calcResult(lang, 0, plans)]) expect(s, lang).not.toMatch(/sav(e|ing)|cheaper|%|توفير|وفّر|أرخص/i);
    }
  });

  it("the calculator's copy holds no number: counts and costs come from the tables", () => {
    for (const f of ["src/components/CreditCalculator.tsx", "src/components/CreditCalculatorForm.tsx"]) {
      for (const s of copyOf(f)) expect(s, f).not.toMatch(/\d/);
    }
    expect(copyOf("src/components/CreditCalculator.tsx")).toContain(CALC_COPY.intro.en);
    expect(copyOf("src/components/CreditCalculatorForm.tsx").join(" ")).toContain("a month. The smallest plan that covers it: ");
  });

  for (const lang of LANGS) {
    it(`1886: labelled number fields, 44px steppers and a polite live result (${lang})`, () => {
      const html = renderToStaticMarkup(h(CreditCalculatorForm, { lang, rows: rowsFor(), plans: plansFor(lang) }));
      const inputs = [...html.matchAll(/<input id="([^"]+)" type="number"[^>]*>/g)];
      expect(inputs).toHaveLength(CALC_TYPES.length);
      for (const [tag, id] of inputs) {
        expect(html, id).toContain(`<label for="${id}"`);
        expect(tag).toMatch(/min="0"/);
        expect(tag).toMatch(new RegExp(`max="${CALC_MAX}"`));
        expect(tag).toMatch(/inputMode="numeric"/);
      }
      const buttons = html.match(/<button [^>]*>/g) ?? [];
      expect(buttons).toHaveLength(2 * CALC_TYPES.length);
      for (const b of buttons) {
        expect(b).toMatch(/type="button"/);
        expect(b).toMatch(/\bsize-11\b/);
        expect(b).toMatch(/aria-label="[^"]+"/);
      }
      expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
      expect(html).toMatch(/aria-live="polite"[^>]*>[^<]+</);
      const src = code("src/components/CreditCalculatorForm.tsx");
      expect(src).not.toMatch(/\b(ml|mr|pl|pr)-\d|\btext-(left|right)\b|\b(left|right)-\d/);
    });
  }

  it("clamps a typed count to a whole number from 0 to the maximum", () => {
    expect(["", "abc", "-3", "2.9", "12", String(CALC_MAX + 1)].map(clampCount)).toEqual([0, 0, 0, 2, 12, CALC_MAX]);
    expect(clampCount(Number.POSITIVE_INFINITY)).toBe(0);
  });

  for (const lang of LANGS) {
    it(`1887: Razan introduces it in one line, in both languages, on /pricing only (${lang})`, () => {
      const html = renderToStaticMarkup(h(CreditCalculator, { t: dict[lang], lang }));
      const razan = AGENT_CAST.find((a) => a.id === "razan")!;
      expect(html).toContain(esc(razan.name[lang]));
      expect(html).toContain(esc(CALC_COPY.intro[lang]));
      expect(html).toMatch(/<h2 id="calc-h"/);
      expect(html).toContain('data-cast="razan"');
      for (const k of Object.keys(CALC_COPY) as (keyof typeof CALC_COPY)[]) {
        expect(CALC_COPY[k].ar.length > 0 && CALC_COPY[k].en.length > 0, k).toBe(true);
      }
      expect(CALC_COPY.intro[lang]).not.toMatch(/\d|sav(e|ing)|توفير|نضمن|guarantee/i);
      expect(CALC_COPY.intro[lang].split(/[.!?؟]\s/).length, "one line").toBe(1);
    });
  }

  it("the pricing page carries the calculator; the home page and the industry pages do not", () => {
    expect(code("src/app/[lang]/pricing/page.tsx")).toMatch(/<CreditCalculator t=\{t\} lang=\{lang\}/);
    expect(read("src/app/[lang]/page.tsx")).not.toContain("CreditCalculator");
    expect(read("src/app/[lang]/for/[industry]/page.tsx")).not.toContain("CreditCalculator");
    expect(code("src/components/Pricing.tsx")).not.toContain("CreditCalculator");
  });

  it("the client form reads only import-free modules by value", () => {
    const src = read("src/components/CreditCalculatorForm.tsx");
    expect(src).toMatch(/^"use client";/);
    const values = [...src.matchAll(/import\s+(?!type\s)\{[^}]*\}\s+from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(values).toEqual(["react", "@/lib/pricing"]);
  });
});
