// Release R1 honesty fixes (rules 924-929, docs/system/tests/0924-release-honesty.md): the support address, the dead
// waitlist promise, the homepage scenes heading, "coming soon" in plan bullets, the pitch deck generator and the
// release checklist. Source-reading checks plus the dictionaries read directly.
import { describe, expect, it } from "vitest";
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { SUPPORT_EMAIL, dict, LANGS } from "@/lib/i18n";
import { SCENES_COPY } from "@/lib/home";
import { PLAN_CREDITS, PLAN_PRICE_SAR, PLAN_SEATS, formatCount } from "@/lib/pricing";

const read = (f: string) => readFileSync(f, "utf8");
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|mdx|txt|html|css|py|xml|webmanifest)$/;
const files = (dirs: string[]) => dirs.flatMap((d) => globSync(`${d}/**/*`)).filter((f) => TEXT.test(f) && statSync(f).isFile());

describe("rule 924: the support address is hello@thakeen.com, in one constant", () => {
  it("is the constant's value", () => {
    expect(SUPPORT_EMAIL).toBe("hello@thakeen.com");
  });

  it("leaves no nashr.ai address in src/, content/, public/ or scripts/", () => {
    const hits = files(["src", "content", "public", "scripts"]).filter((f) => /nashr\.ai/i.test(read(f)));
    expect(hits).toEqual([]);
  });

  it("is read from the constant by the billing page and the top-up card, never typed there", () => {
    for (const f of ["src/app/[lang]/app/settings/billing/page.tsx", "src/components/app/TopupCard.tsx"]) {
      const src = read(f);
      expect(src, f).toMatch(/mailto:\$\{SUPPORT_EMAIL\}/);
      expect(src, f).not.toMatch(/hello@/);
    }
  });
});

describe("rule 925: no dead launch promise of free months for the first brands", () => {
  it("has no waitlist dictionary (it was never rendered)", () => {
    for (const lang of LANGS) expect(Object.keys(dict[lang]), lang).not.toContain("waitlist");
  });

  it("says nowhere in src/ that the first 100 brands get months free", () => {
    const re = /first 100 brands|أول 100 علامة|two months free on Pro|شهرين مجاناً على خطة الاحتراف/i;
    expect(files(["src"]).filter((f) => re.test(read(f)))).toEqual([]);
  });
});

describe("rule 926: the scenes heading and subline name no customers and use no \"example\" wording, in both languages", () => {
  it("says no «مثال» / «أمثلة» / \"example\" / \"illustrative\" (founder decision 2026-10-14)", () => {
    for (const t of [SCENES_COPY.h.ar, SCENES_COPY.h.en, SCENES_COPY.sub.ar, SCENES_COPY.sub.en]) {
      expect(t).not.toMatch(/مثال|أمثلة|توضيحي|example|illustrative/i);
    }
  });

  it("frames the cards as scenarios, not customers (critique 2026-10-14, rule 1840; it replaces the 2026-10-11 heading)", () => {
    expect(SCENES_COPY.h.ar).toBe("كيف يشتغل ذكين مع أصحاب المحلات.");
    expect(SCENES_COPY.h.en).toBe("How Thakeen works with shop owners.");
    expect(SCENES_COPY.sub.ar).toBe("عندك محل؟ هذا اللي يسويه الفريق معك.");
    expect(SCENES_COPY.sub.en).toBe("Run a shop? Here's what the team does with you.");
    for (const t of [SCENES_COPY.h.ar, SCENES_COPY.h.en, SCENES_COPY.sub.ar, SCENES_COPY.sub.en]) {
      expect(t).not.toMatch(/عملاء|customer/i);
    }
  });

  it("renders the heading and the line, with the wording in src/lib/home.ts only", () => {
    const stories = read("src/components/home/Stories.tsx");
    expect(stories).toContain("{c.h[lang]}");
    expect(stories).toContain("{c.sub[lang]}");
    expect(stories.indexOf("{c.sub[lang]}")).toBeLessThan(stories.indexOf("<SceneTrack"));
    for (const t of [SCENES_COPY.h.ar, SCENES_COPY.sub.ar, SCENES_COPY.sub.en]) {
      expect(files(["src"]).filter((f) => f !== "src/lib/home.ts" && read(f).includes(t)), t).toEqual([]);
    }
  });
});

describe("rule 927: no plan bullet promises something coming soon", () => {
  it("lists only what each plan has today, in both languages", () => {
    for (const lang of LANGS) {
      for (const plan of dict[lang].pricing.plans) {
        for (const f of plan.features) expect(f, `${lang} ${plan.id}`).not.toMatch(/coming soon|قريباً|\(soon\)/i);
      }
    }
  });

  it("has no Saudi data-hosting promise among the plans", () => {
    for (const lang of LANGS) {
      const all = dict[lang].pricing.plans.flatMap((p) => p.features).join(" · ");
      expect(all, lang).not.toMatch(/inside Saudi|داخل السعودية|in-Kingdom/i);
    }
  });
});

describe("rule 928: the pitch deck generator states no invented quote, number or claim", () => {
  const deck = read("scripts/build_deck.py");

  it("has no invented merchant quote", () => {
    expect(deck).not.toMatch(/merchant told us|Perfume store|“I spend/i);
  });

  it("has the current prices, credits and seats, with VAT on top, and none of the old prices", () => {
    expect(deck).not.toMatch(/"(149|399|799)"/);
    expect(deck).toMatch(/\+ VAT/);
    for (const p of ["starter", "pro", "business"] as const) {
      expect(deck, p).toContain(`"${PLAN_PRICE_SAR[p]}", "${formatCount(PLAN_CREDITS[p])}", "${PLAN_SEATS[p]}"`);
    }
  });

  it("gives no trial length", () => {
    expect(deck).not.toMatch(/\d+[- ]day trial|trial of \d+|\d+ days free/i);
  });

  it("has no invented numbers in the product slide", () => {
    const slide = deck.slice(deck.indexOf("# 4 Product"), deck.indexOf("# 5 Why now"));
    const rows = slide.slice(slide.indexOf("rows = ["), slide.indexOf("]\ntable("));
    expect(rows.replace(/08:00/g, "")).not.toMatch(/\d/);
    expect(slide).not.toMatch(/\d+%|SAR \d/);
  });

  it("claims no data residency or compliance and uses the Thakeen address", () => {
    expect(deck).not.toMatch(/PDPL-compliant|KSA region|hosted in-Kingdom|In-Kingdom data/i);
    expect(deck).not.toMatch(/nashr\.ai/);
    expect(deck).toContain("hello@thakeen.com");
  });

  // Founder decisions 2026-10-11: the product's name, the payment provider, the brief, the connectors, the launch status
  // and a visible marker on figures that have no checked source yet.
  it("names the product Thakeen / ذكين, never Nashr, outside file names", () => {
    const quoted = (deck.match(/"[^"\n]*"/g) ?? []).join("\n").replace(/Nashr_[A-Za-z_]+\.(pptx|xlsx)/g, "");
    expect(quoted).not.toMatch(/Nashr|نشر/);
    expect(deck).toContain("ذكين  ·  Thakeen");
  });

  it("states Paymob, the in-app brief, connectors waiting on keys and the live status, with no one-click or waitlist claim", () => {
    expect(deck).not.toMatch(/Tap ?\/ ?Moyasar|Moyasar|one-click OAuth|WhatsApp brief|waitlist live/i);
    expect(deck).toContain("Paymob");
    expect(deck).toContain("morning brief in the app");
    expect(deck).toContain("Now: live at thakeen.com");
  });

  it("marks every slide with market figures, targets or the base case as to verify", () => {
    for (const marker of ["# 2 Problem", "# 5 Why now", "# 6 Market", "# 10 Traction plan", "# 12 Financials", "# 14 Ask"]) {
      const start = deck.indexOf(marker);
      const next = deck.indexOf("\n# ", start + 1);
      expect(deck.slice(start, next === -1 ? undefined : next), marker).toContain("to_verify(s)");
    }
    expect(deck).toMatch(/VERIFY = "TO VERIFY/);
  });
});

describe("rule 929: the R1 release checklist lists what ships and what to check after", () => {
  const path = "docs/release/2026-10-R1-checklist.md";

  it("exists and names every merged pull request it carries", () => {
    expect(existsSync(path)).toBe(true);
    const doc = read(path);
    for (const pr of [298, 311, 313, 314, 315, 317, 318]) expect(doc, `#${pr}`).toContain(`#${pr}`);
  });

  it("has the smoke checks: heading text, partner redirect, billing email, console Cancel, titles, health", () => {
    const doc = read(path);
    // R1 is a past release: its checklist keeps the wording that shipped then (the scenes were reframed later, rule 1840).
    const r1 = ["عملاء جربوا ذكين.", "أمثلة توضيحية: وش عجبهم، وش تعلّموا، ووش ينصحون غيرهم فيه.", "How owners work with Thakeen.", "Illustrative examples: what they like, what they learned, and what they recommend."];
    for (const s of [...r1, "/p/", "0.0.0.0", SUPPORT_EMAIL, "Cancel", "titles", "/api/health"]) {
      expect(doc, s).toContain(s);
    }
  });

  it("holds no secret value, only names", () => {
    expect(read(path)).not.toMatch(/sk-ant-|Bearer [A-Za-z0-9]|[A-Z_]{6,}=\S/);
  });
});
