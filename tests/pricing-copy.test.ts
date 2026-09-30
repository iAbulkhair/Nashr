import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CREDIT_TABLE_TYPES, creditCost, dict, seatsText, type Lang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { HELP } from "@/lib/help";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { VS_PAGES } from "@/lib/pages-vs";
import { SITE } from "@/lib/site";
import { CHANGELOG } from "@/lib/changelog";
import { MEDIA_MODELS } from "@/lib/media-catalog";
import { AGENCY_MIN, ONBOARD_EXTRA_BRAND_COST, PLANS, PLAN_CREDITS, PLAN_PRICE_SAR, PLAN_SEATS, PUBLIC_TIERS, SELF_SERVE_PLANS, formatCount } from "@/lib/pricing";
import { TASK_COST, TASK_COUNT } from "@/lib/tasks";
import Pricing from "@/components/Pricing";
import BrandsPanel from "@/components/app/BrandsPanel";
import StartWizard from "@/components/app/StartWizard";
import TasksPanel from "@/components/app/TasksPanel";
import AiAgentPage from "@/app/[lang]/ai-marketing-agent/page";

/**
 * Rule 228: every price, credit amount, seat count and task cost the site and the app state is read from
 * src/lib/pricing.ts and TASK_COST (src/lib/tasks.ts), never typed into the copy, and the VAT sentence stays word for word
 * until the accountant answers. These render the copy and compare it with the tables, so a price change in pricing.ts
 * reaches every page, and a page that kept its own number fails here. The retired numbers (149 / 399 / 799, 200 and
 * 2,000 credits, brand limits) are banned in tests/content-claims.test.ts.
 */

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en",
  useSearchParams: () => new URLSearchParams(),
}));

const LANGS: readonly Lang[] = ["ar", "en"];
const P = PLAN_PRICE_SAR;
/** React escapes apostrophes and ampersands in text; compare against what the markup really contains. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fill = (s: string, n: number, credits: number) => s.replace("{n}", String(n)).replace("{credits}", String(credits));
/** The markup of each element carrying `data-tier`, keyed by tier. */
const tiers = (html: string) => Object.fromEntries(html.split('data-tier="').slice(1).map((c) => [c.slice(0, c.indexOf('"')), c]));
const help = (en: string) => {
  const item = HELP.flatMap((t) => t.items).find((i) => i.q.en === en);
  if (!item) throw new Error(`no help answer for "${en}"`);
  return item.a;
};

describe("the pricing cards render the plan table (rule 228)", () => {
  it("shows Starter, Pro, Business and Agency, in that order, in both languages", () => {
    for (const lang of LANGS) expect(dict[lang].pricing.plans.map((p) => p.id), lang).toEqual([...PUBLIC_TIERS]);
    expect(dict.ar.pricing.plans.map((p) => p.name)).toEqual(["البداية", "الاحتراف", "الأعمال", "الوكالات"]);
    expect(dict.en.pricing.plans.map((p) => p.name)).toEqual(["Starter", "Pro", "Business", "Agency"]);
  });

  it("each self-serve card's price, monthly credits and seats are the table's", () => {
    for (const lang of LANGS) {
      for (const k of SELF_SERVE_PLANS) {
        const card = dict[lang].pricing.plans.find((p) => p.id === k)!;
        expect(card.price, `${lang} ${k}`).toBe(String(P[k]));
        expect(card.credits, `${lang} ${k}`).toContain(`${formatCount(PLAN_CREDITS[k])} ${lang === "ar" ? "كريدت" : "credits"}`);
        expect(card.features.join(" · "), `${lang} ${k}`).toContain(seatsText(lang, PLAN_SEATS[k]));
      }
    }
    // The helper itself: what the teams tests match on.
    expect([seatsText("en", 1), seatsText("en", 7), seatsText("ar", 1), seatsText("ar", 3), seatsText("ar", 7), seatsText("ar", 12)]).toEqual(["1 seat", "7 seats", "مقعد واحد", "3 مقاعد", "7 مقاعد", "12 مقعداً"]);
  });

  it("the Agency card has no list price, states the credit floor, and its button goes to the contact form", () => {
    for (const lang of LANGS) {
      const agency = dict[lang].pricing.plans.find((p) => p.id === "agency")!;
      expect(agency.price, lang).not.toMatch(/\d/);
      expect(agency.credits, lang).toContain(formatCount(AGENCY_MIN.credits));
      const cards = tiers(renderToStaticMarkup(createElement(Pricing, { t: dict[lang], lang })));
      expect(Object.keys(cards)).toEqual([...PUBLIC_TIERS]);
      expect(cards.agency).toContain(`href="/${lang}/enterprise#contact"`);
      expect(cards.agency).not.toContain("/app/signup");
      for (const k of SELF_SERVE_PLANS) {
        expect(cards[k], `${lang} ${k}`).toContain(`href="/${lang}/app/signup"`);
        expect(cards[k], `${lang} ${k}`).toContain(`>${P[k]}</span>`);
      }
    }
  });

  it("the VAT sentence is unchanged, word for word, until the accountant answers", () => {
    expect(dict.en.pricing.sub).toBe("Prices in Saudi riyals, excluding VAT. Cancel anytime.");
    expect(dict.ar.pricing.sub).toBe("الأسعار بالريال السعودي غير شاملة الضريبة. ألغِ في أي وقت.");
  });

  it("every card says brands are unlimited and none states a brand limit or a paid extra brand", () => {
    for (const lang of LANGS) {
      const plans = dict[lang].pricing.plans;
      expect(plans.find((p) => p.id === "starter")!.features[0], lang).toMatch(lang === "en" ? /^Unlimited brands, / : /^علامات بلا حد، /);
      const all = plans.flatMap((p) => [p.credits, ...p.features]).join(" · ");
      expect(all, lang).not.toMatch(lang === "en" ? /\d+ brands?\b|included\)|Extra brand|Multi-brand|brands \(coming soon\)/i : /علامة واحدة|مشمولة|علامة إضافية|علامات متعددة|بلا حد \(قريباً\)/);
    }
  });
});

describe("the credits table prices every task from TASK_COST (rule 228)", () => {
  const rows = (lang: Lang) => dict[lang].pricing.credits;
  const rowOf = (lang: Lang, label: string) => rows(lang).filter((r) => r.action.toLowerCase().split(" / ").includes(label.toLowerCase()));

  it("names each listed type in exactly one row, priced at TASK_COST (per item where the row says so)", () => {
    for (const lang of LANGS) {
      for (const t of CREDIT_TABLE_TYPES) {
        const hit = rowOf(lang, t.label[lang]);
        expect(hit.length, `${lang}: ${t.type} appears once`).toBe(1);
        expect(hit[0].cost, `${lang}: ${t.type}`).toBe(String(creditCost(t.type, t.perItem)));
      }
    }
  });

  it("puts the weekly plan, the weekly report and the follow-up cadence at their phase-1 prices", () => {
    expect(rowOf("en", "weekly plan")[0].cost).toBe(String(TASK_COST.weekly_plan));
    expect(rowOf("en", "weekly report")[0].cost).toBe(String(TASK_COST.weekly_report));
    expect(rowOf("en", "follow-up cadence")[0].cost).toBe(String(TASK_COST.followup_seq));
    expect(rowOf("ar", "خطة الأسبوع")[0].cost).toBe(String(TASK_COST.weekly_plan));
    expect(rowOf("ar", "تقرير أسبوعي")[0].cost).toBe(String(TASK_COST.weekly_report));
    expect(rowOf("ar", "سلسلة متابعة")[0].cost).toBe(String(TASK_COST.followup_seq));
  });

  it("the task rows run cheapest first, the image row carries the catalogue's range, then the first brand free and each added brand at its setup cost", () => {
    const image = MEDIA_MODELS.filter((m) => m.kind === "image").map((m) => m.credits);
    for (const lang of LANGS) {
      const r = rows(lang);
      const numeric = r.map((x) => Number.parseFloat(x.cost)).filter((n) => Number.isFinite(n));
      const tasks = numeric.slice(0, -1); // the last numeric row is the added-brand setup
      expect(tasks, lang).toEqual([...tasks].sort((a, b) => a - b));
      const imageRow = r.find((x) => x.action === (lang === "ar" ? "صورة" : "Image"))!;
      expect(imageRow.cost, lang).toBe(`${Math.min(...image)}–${Math.max(...image)}`);
      const [free, added] = r.slice(-2);
      expect(free.cost, lang).toBe(lang === "ar" ? "مجاناً" : "Free");
      expect(free.action, lang).toMatch(lang === "ar" ? /علامتك الأولى/ : /your first brand/);
      expect(added.cost, lang).toBe(String(ONBOARD_EXTRA_BRAND_COST));
      // Only the build from a URL is charged (POST /api/onboard); the manual brand form (PUT /api/brand) is free.
      expect(added.action, lang).toMatch(lang === "ar" ? /كل علامة إضافية من رابطها[\s\S]*النموذج اليدوي مجاني/ : /each added brand from its URL[\s\S]*the manual form is free/);
      // The refund promise is only what the code keeps: a build that could not save the brand file.
      expect(added.action, lang).toMatch(lang === "ar" ? /تعذّر بناء ملف العلامة/ : /the brand file cannot be built/);
    }
  });
});

describe("the other pages read the same tables (rule 228)", () => {
  it("the pricing FAQ and the landing page quote the table's prices, Agency by contract and the setup cost", () => {
    const faq = (lang: Lang) => dict[lang].faq.items.find((i) => i.q === (lang === "ar" ? "كم تكلّف؟" : "How much does it cost?"))!.a;
    expect(faq("en")).toContain(`Starter ${P.starter}, Pro ${P.pro}, Business ${P.business} SAR, and Agency by contract`);
    expect(faq("ar")).toContain(`البداية ${P.starter}، الاحتراف ${P.pro}، الأعمال ${P.business} ريال، والوكالات بعقد`);
    expect(faq("en")).toContain(`A post is ${TASK_COST.social / TASK_COUNT.social} credit, an article ${TASK_COST.article}, a board deck ${TASK_COST.board_deck}`);
    expect(faq("en")).toContain(`setting up each added brand from its URL is ${ONBOARD_EXTRA_BRAND_COST} credits`);
    expect(faq("ar")).toContain(`وإعداد كل علامة إضافية من رابطها ${ONBOARD_EXTRA_BRAND_COST} كريدت`);
    expect(dict.en.land.oldway.new.items[0]).toBe(`A full team from SAR ${P.starter}/month`);
    expect(dict.ar.land.oldway.new.items[0]).toBe(`فريق كامل من ${P.starter} ريالاً شهرياً`);
    for (const lang of LANGS) expect(dict[lang].industries.items.find((i) => i.name === (lang === "ar" ? "وكالات التسويق" : "Marketing agencies"))!.body, lang).toMatch(lang === "ar" ? /على أي خطة/ : /on any plan/);
  });

  it("the help answers the chat model repeats carry TASK_COST, the plan prices and the setup cost", () => {
    const cost = help("What does each task cost?");
    expect(cost.en).toContain(`Weekly plan ${TASK_COST.weekly_plan} · ${TASK_COUNT.social} posts ${TASK_COST.social} · article ${TASK_COST.article} · ${TASK_COUNT.whatsapp} WhatsApp ${TASK_COST.whatsapp} · ${TASK_COUNT.ads} ads ${TASK_COST.ads} · ${TASK_COUNT.gbp} Google posts ${TASK_COST.gbp}`);
    expect(cost.ar).toContain(`خطة الأسبوع ${TASK_COST.weekly_plan} · ${TASK_COUNT.social} منشورات ${TASK_COST.social}`);
    expect(cost.en).toContain(`each added brand's setup from its URL ${ONBOARD_EXTRA_BRAND_COST}`);
    expect(cost.ar).toContain(`وإعداد كل علامة إضافية من رابطها ${ONBOARD_EXTRA_BRAND_COST}`);
    const trial = help("The free trial?");
    expect(trial.en).toContain(`${PLAN_CREDITS.trial} credits, no card. Then pick a plan: Starter ${P.starter}, Pro ${P.pro}, Business ${P.business} SAR/month, or Agency by contract.`);
    expect(trial.ar).toContain(`البداية ${P.starter}، الاحتراف ${P.pro}، الأعمال ${P.business} ريال شهرياً، أو الوكالات بعقد`);
    const own = help("What does Noor do on her own?");
    expect(own.en).toContain(`(${TASK_COST.weekly_plan} credits)`);
    expect(own.ar).toContain(`(${TASK_COST.weekly_plan} كريدت)`);
    expect(own.en).toMatch(/on by default for your first brand; added brands run it once you switch it on/);
    expect(help("How do I download the board deck?").en).toContain(`(${TASK_COST.board_deck} credits)`);
  });

  it("the in-app strings: plan labels for every plan, the weekly plan's cost placeholder and the setup notes", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      expect(Object.keys(t.nav.plans).sort(), lang).toEqual([...PLANS].sort());
      expect(Object.keys(t.billing.plans).sort(), lang).toEqual([...PLANS].sort());
      expect(t.tasks.weeklyDesc, lang).toContain("{n}");
      expect(t.tasks.weeklyOff, lang).not.toBe("");
      for (const k of ["setupCost", "noCredits", "refunded"] as const) for (const ph of ["{n}", "{credits}"]) expect(t.start[k], `${lang} ${k}`).toContain(ph);
      expect(t.start.setupPaid, lang).toContain("{n}");
      expect(t.start.notCharged, lang).not.toBe("");
      expect(t.start.partial, lang).not.toBe("");
      // The start page says the manual form is free, since only the build from a URL is charged.
      expect(t.start.setupCost, lang).toMatch(lang === "ar" ? /من رابطها[\s\S]*تعبئة النموذج يدوياً مجانية/ : /from its URL[\s\S]*Filling the form by hand is free/);
      // Governance: Noor's cap covers an added brand's setup, which the ledger charges to her (src/app/api/onboard/route.ts).
      expect(t.governance.agentCapsSub, lang).toMatch(lang === "ar" ? /إعداد العلامة المضافة/ : /an added brand's setup/);
      expect(t.start.setupFree, lang).not.toBe("");
      expect(t.signup.sub, lang).toContain(`${PLAN_CREDITS.trial} ${lang === "ar" ? "كريدت" : "credits"}`);
    }
    expect(appDict.ar.nav.plans.agency).toBe("الوكالات");
    expect(appDict.ar.billing.plans.agency).toBe("الوكالات");
    expect(appDict.ar.nav.plans.business).toBe("الأعمال");
    expect(appDict.en.nav.plans.business).toBe("Business");
    expect(Object.keys(appDict.ar.start).sort()).toEqual(Object.keys(appDict.en.start).sort());
    expect(Object.keys(appDict.ar.tasks).sort()).toEqual(Object.keys(appDict.en.tasks).sort());
  });

  it("the scheduled tasks page fills the weekly plan's cost from TASK_COST", () => {
    for (const lang of LANGS) {
      const html = renderToStaticMarkup(createElement(TasksPanel, { t: appDict[lang], initial: { weeklyPlan: false, dailyBrief: true, followUps: true }, routines: [] }));
      expect(html, lang).toContain(esc(`(${TASK_COST.weekly_plan} ${lang === "ar" ? "كريدت" : "credits"})`));
      expect(html, lang).not.toContain("{n}");
    }
  });

  it("industry pages: price tiles are the table's prices, and the agencies page states unlimited brands, Business and the setup cost", () => {
    const prices = SELF_SERVE_PLANS.map((k) => String(P[k]));
    for (const lang of LANGS) {
      const pages = INDUSTRY_PAGES[lang];
      const tiles = pages.flatMap((p) => p.proof).filter((x) => (lang === "ar" ? /ريال\/شهر/ : /SAR\/month/).test(x.l));
      expect(tiles.length, lang).toBeGreaterThanOrEqual(5);
      for (const x of tiles) expect(prices, `${lang}: ${x.n} ${x.l}`).toContain(x.n);
      const agencies = pages.find((p) => p.slug === "agencies")!;
      expect(agencies.proof.map((x) => x.n), lang).toEqual(expect.arrayContaining([String(P.business), formatCount(PLAN_CREDITS.business)]));
      const text = JSON.stringify(agencies);
      expect(text, lang).toMatch(lang === "ar" ? /علامات بلا حد/ : /Unlimited brands/);
      expect(text, lang).toContain(`${ONBOARD_EXTRA_BRAND_COST} ${lang === "ar" ? "كريدت" : "credits"}`);
      const all = JSON.stringify(pages);
      expect(all, lang).not.toMatch(lang === "ar" ? /\(خطة الوكالة\)|خطة الوكالة تدير/ : /\(Agency plan\)|Agency plan runs/);
    }
  });

  it("comparison pages: our price is the Starter price, the range is Starter to Business, the trial credits are the table's", () => {
    for (const lang of LANGS) {
      const rows = VS_PAGES[lang].flatMap((p) => p.rows);
      const priced = rows.filter((r) => /^(Price|السعر)$/.test(r.dim));
      expect(priced.length, lang).toBe(4);
      for (const r of priced) expect(r.us, lang).toContain(String(P.starter));
      expect(rows.find((r) => /^(Monthly cost|التكلفة الشهرية)$/.test(r.dim))!.us, lang).toContain(`${P.starter}–${P.business}`);
      expect(rows.find((r) => /^(Trial|التجربة)$/.test(r.dim))!.us, lang).toContain(String(PLAN_CREDITS.trial));
    }
  });

  it("the Agencies page and menu: the menu item is Agencies, the allowance line is the Agency floor, brands are unlimited", () => {
    expect(SITE.ar.menu.enterprise).toBe("الوكالات");
    expect(SITE.en.menu.enterprise).toBe("Agencies");
    // The e2e suite finds this page by its title, and the route stays /enterprise.
    expect(SITE.en.enterprise.title.startsWith("Many brands, one team")).toBe(true);
    for (const lang of LANGS) {
      const text = SITE[lang].enterprise.features.map((f) => f.d).join(" ");
      expect(text, lang).toContain(formatCount(AGENCY_MIN.credits));
      expect(text, lang).toContain(`${ONBOARD_EXTRA_BRAND_COST} ${lang === "ar" ? "كريدت" : "credits"}`);
    }
  });

  it("the AI marketing agent page and its FAQPage JSON-LD quote Starter to Business", async () => {
    for (const lang of LANGS) {
      const html = renderToStaticMarkup((await AiAgentPage({ params: Promise.resolve({ lang }) })) as ReactElement);
      const range = lang === "ar" ? `${P.starter}–${P.business} ريال` : `SAR ${P.starter}–${P.business}`;
      const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1];
      expect(ld, lang).toContain(range);
      expect(html, lang).toContain(range);
    }
  });

  it("the trial-ending email reads Pro's price and credits from the table", () => {
    const src = readFileSync("src/lib/lifecycle.ts", "utf8");
    expect(src).toContain("خطة الاحتراف ${PLAN_PRICE_SAR.pro} ريال/شهر تعطيك ${formatCount(PLAN_CREDITS.pro)} كريدت");
    expect(src).toContain("Pro at SAR ${PLAN_PRICE_SAR.pro}/mo gives you ${formatCount(PLAN_CREDITS.pro)} credits");
  });

  it("the signup form's trial line reads the trial credits from the table", () => {
    const src = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    expect(src).toContain("تجربة 3 أيام · ${PLAN_CREDITS.trial} كريدت");
    expect(src).toContain("3-day trial · ${PLAN_CREDITS.trial} credits");
    expect(src).not.toMatch(/\b50 (credits|كريدت)/);
  });

  it("the hand-written blog post carries today's prices (markdown cannot import the table, so this pins it)", () => {
    const post = readFileSync("content/blog/replace-your-agency-with-ai.md", "utf8");
    expect(post).toContain(`ابتداءً من ${P.starter} ريالاً شهرياً`);
    expect(post).toContain(`from SAR ${P.starter} a month`);
    expect(post).toContain(`| شهرياً | — | ${P.starter}–${P.business} ريال |`);
    expect(post).toContain(`| Monthly | — | SAR ${P.starter}–${P.business} |`);
    expect(post).toContain(`(البداية ${PLAN_CREDITS.starter}، الاحتراف ${PLAN_CREDITS.pro})`);
    expect(post).toContain(`(Starter ${PLAN_CREDITS.starter}, Pro ${PLAN_CREDITS.pro})`);
  });

  it("the Updates page announces the new prices, the setup cost and the task-price rises from the tables", () => {
    const entry = CHANGELOG.find((e) => e.title.en === "New plans and prices, and unlimited brands")!;
    // Dated no earlier than the day phase 1 was finished (the file dates entries by their merge on main).
    expect(entry.date >= "2026-09-30", entry.date).toBe(true);
    expect(entry.desc.en).toContain(`Starter ${P.starter}, Pro ${P.pro} and Business ${P.business} SAR a month, excluding VAT`);
    expect(entry.desc.ar).toContain(`غير شاملة الضريبة`);
    for (const lang of LANGS) expect(entry.desc[lang], lang).toContain(`${ONBOARD_EXTRA_BRAND_COST} ${lang === "ar" ? "كريدت" : "credits"}`);
    // The weekly plan is charged by cron with nobody asking, so its rise is announced with the others.
    expect(entry.desc.en).toContain(`Three tasks now cost more: the weekly plan ${TASK_COST.weekly_plan} credits, the weekly report ${TASK_COST.weekly_report} and the follow-up cadence ${TASK_COST.followup_seq}.`);
    expect(entry.desc.ar).toContain(`خطة الأسبوع ${TASK_COST.weekly_plan} كريدت، والتقرير الأسبوعي ${TASK_COST.weekly_report}، وسلسلة المتابعة ${TASK_COST.followup_seq}`);
  });

  it("no copy module types a current price or allowance: they all come from the table", () => {
    const FILES = [
      "src/lib/i18n.ts", "src/lib/app-i18n.ts", "src/lib/help.ts", "src/lib/site.ts", "src/lib/pages-industry.ts", "src/lib/pages-vs.ts",
      "src/lib/lifecycle.ts", "src/lib/changelog.ts", "src/components/Pricing.tsx", "src/app/[lang]/app/billing/page.tsx",
      "src/app/[lang]/ai-marketing-agent/page.tsx", "src/components/app/BrandsPanel.tsx", "src/components/app/StartWizard.tsx",
      "src/components/app/TasksPanel.tsx", "src/components/app/ProfilePanel.tsx", "src/components/app/AdminConsole.tsx",
    ];
    const literals = [...SELF_SERVE_PLANS.map((k) => P[k]), ...SELF_SERVE_PLANS.map((k) => PLAN_CREDITS[k]).filter((n) => n >= 1000)];
    const re = new RegExp(`\\b(${literals.map((n) => `${n}|${formatCount(n).replace(",", "\\,")}`).join("|")})\\b`);
    const hits = FILES.flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => (re.test(l) ? `${f}:${i + 1}` : "")).filter(Boolean));
    expect(hits).toEqual([]);
  });
});

describe("the app states what an added brand costs before anyone adds or sets one up (rules 225-227)", () => {
  it("the brands page has no brand limit, and says the setup cost and that the Sunday plan starts off", () => {
    for (const lang of LANGS) {
      const html = renderToStaticMarkup(createElement(BrandsPanel, { lang, manage: true }));
      expect(html, lang).toContain(`<b dir="ltr">0</b>`);
      expect(html, lang).not.toMatch(/ \/ \d|disabled=""|Upgrade to Agency|لخطة الوكالة/);
      expect(html, lang).toContain(`${ONBOARD_EXTRA_BRAND_COST} ${lang === "ar" ? "كريدت" : "credits"}`);
      expect(html, lang).toMatch(lang === "ar" ? /بلا حد في كل الخطط[\s\S]*خطة الأحد تبدأ متوقفة للعلامات المضافة/ : /unlimited on every plan[\s\S]*The Sunday plan starts off for added brands/);
      // A member sees no add form and so no cost note.
      expect(renderToStaticMarkup(createElement(BrandsPanel, { lang, manage: false, readOnlyNote: "x" })), lang).not.toContain(`${ONBOARD_EXTRA_BRAND_COST} ${lang === "ar" ? "كريدت" : "credits"}`);
    }
  });

  it("the start wizard: the first brand is free; an added brand states its cost and the balance before Go, and Go is off when the balance is short", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      const render = (setupCost: number, credits: number, setupPaid = false) => renderToStaticMarkup(createElement(StartWizard, { t, lang, initialUrl: "example.com", setupCost, credits, setupPaid }));
      const go = /<button([^>]*) class="btn btn-accent btn-lg">/;
      const first = render(0, 50);
      expect(first, lang).toContain(esc(t.start.setupFree));
      expect(first.match(go)![1], lang).not.toContain("disabled");
      const added = render(ONBOARD_EXTRA_BRAND_COST, 50);
      expect(added, lang).toContain(esc(fill(t.start.setupCost, ONBOARD_EXTRA_BRAND_COST, 50)));
      expect(added.match(go)![1], lang).not.toContain("disabled");
      const short = render(ONBOARD_EXTRA_BRAND_COST, ONBOARD_EXTRA_BRAND_COST - 1);
      expect(short, lang).toContain(esc(fill(t.start.noCredits, ONBOARD_EXTRA_BRAND_COST, ONBOARD_EXTRA_BRAND_COST - 1)));
      expect(short.match(go)![1], lang).toContain("disabled");
      // A setup already paid for (a charge held from a run that did not finish): the server reuses it at any balance,
      // so the page neither blocks Go nor says nothing was charged.
      const paid = render(ONBOARD_EXTRA_BRAND_COST, 0, true);
      expect(paid, lang).toContain(esc(fill(t.start.setupPaid, ONBOARD_EXTRA_BRAND_COST, 0)));
      expect(paid, lang).not.toContain(esc(fill(t.start.noCredits, ONBOARD_EXTRA_BRAND_COST, 0)));
      expect(paid.match(go)![1], lang).not.toContain("disabled");
    }
  });
});
