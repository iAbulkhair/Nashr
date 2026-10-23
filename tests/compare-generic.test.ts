import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../next.config";
import ComparePage from "@/app/[lang]/compare/page";
import sitemap from "@/app/sitemap";
import { GET as llmsTxt } from "@/app/llms.txt/route";
import { COMPARE_GROUPS, COMPARE_PAGE } from "@/lib/pages-compare";
import { dict, LANGS } from "@/lib/i18n";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * Comparison by kind, no competitor named (rules 1740-1749, docs/system/tests/1740-compare-generic.md). The founder's
 * decision of 2026-10-13 (option b): the `/vs/{competitor}` pages and the agents article named vendors, quoted their
 * prices and ranked Thakeen first by its own score, which is a legal risk. They are now one page comparing kinds of
 * alternative, and the old addresses answer 308 to it.
 */
const read = (f: string) => readFileSync(f, "utf8");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const ARTICLE = "content/blog/best-ai-marketing-agents-gulf-2026.md";

/**
 * The competitors the old pages and the agents article named. Keep this list: a name added back to any public page
 * fails rule 1740. `Buffer` is matched only as a word not followed by a dot, so Node's `Buffer.from` in code is not a hit.
 */
const REMOVED_COMPETITORS: { name: string; re: RegExp }[] = [
  { name: "Enrich Labs", re: /Enrich ?Labs|enrichlabs/i },
  { name: "Helena", re: /\bHelena\b/ },
  { name: "ChatGPT", re: /ChatGPT|chatgpt\.com/i },
  { name: "Jasper", re: /\bJasper\b|jasper\.ai/i },
  { name: "Hootsuite", re: /Hootsuite/i },
  { name: "Buffer", re: /\bBuffer\b(?!\.)/ },
  { name: "Okara", re: /\bOkara\b/i },
  { name: "Sintra", re: /\bSintra\b/i },
];

/** The five removed comparison pages and the blog post about one vendor. */
const RETIRED = ["/vs/enrich-labs", "/vs/chatgpt", "/vs/jasper", "/vs/agency", "/vs/hootsuite", "/blog/nashr-vs-enrich-labs"];

/**
 * Where a name may still appear on a public page, and why. Each entry is removed from the file's text before the scan,
 * so anything else in that file still fails. Neither compares Thakeen with the product.
 */
const ALLOWED: Record<string, string[]> = {
  // "Ask an AI about this page": a link that opens the visitor's own assistant with a question about the page.
  "src/app/[lang]/ai-marketing-agent/page.tsx": ['["ChatGPT", `https://chatgpt.com/?q=${q}`]'],
  // A wishlist item on /updates: an app for that assistant's app directory, an integration owners can vote for.
  "src/lib/changelog.ts": ['id: "chatgpt-app"', 'تطبيق ذكين في دليل تطبيقات ChatGPT', 'A Thakeen app in the ChatGPT app directory'],
};

/** Every source of public-site copy: the marketing pages (not the signed-in app or the console), shared components, copy modules, blog posts. */
const PUBLIC_FILES = [
  ...walk("src/app/[lang]").filter((f) => !/\/(app|admin)\//.test(f.replace("src/app/[lang]", ""))),
  ...walk("src/app/llms.txt"),
  ...walk("src/app/llms-full.txt"),
  ...walk("src/app/p"),
  "src/app/sitemap.ts", "src/app/robots.ts", "src/app/manifest.ts",
  ...readdirSync("src/components").filter((f) => f.endsWith(".tsx")).map((f) => join("src/components", f)),
  ...walk("src/components/home"),
  ...["i18n", "home", "home-hero", "site", "help", "pages-compare", "pages-industry", "changelog", "dictionary", "legal", "tools", "agents", "blog"].map((f) => `src/lib/${f}.ts`),
  ...walk("content/blog"),
].filter((f) => /\.(tsx?|md|txt)$/.test(f));

const names = (text: string) => REMOVED_COMPETITORS.filter((c) => c.re.test(text)).map((c) => c.name);

describe("rule 1740: no public page names a removed competitor", () => {
  it("scans enough files to mean something", () => {
    expect(PUBLIC_FILES.length).toBeGreaterThan(60);
    expect(PUBLIC_FILES).toContain(ARTICLE);
    expect(PUBLIC_FILES).toContain("src/app/[lang]/compare/page.tsx");
    expect(PUBLIC_FILES.some((f) => f.includes("/app/") && f.startsWith("src/app/[lang]/app/"))).toBe(false);
  });

  it("no copy file, page or blog post names one, outside the two allowed non-comparisons", () => {
    const hits: string[] = [];
    for (const f of PUBLIC_FILES) {
      let text = read(f);
      for (const ok of ALLOWED[f] ?? []) {
        expect(text, `${f}: the allowed text moved, update ALLOWED`).toContain(ok);
        text = text.split(ok).join("");
      }
      for (const n of names(text)) hits.push(`${f}: ${n}`);
    }
    expect(hits).toEqual([]);
  });

  it("the rendered comparison page, the sitemap and llms.txt name none either", async () => {
    for (const lang of LANGS) {
      const html = renderToStaticMarkup(await ComparePage({ params: Promise.resolve({ lang }) }));
      expect(names(html), lang).toEqual([]);
    }
    expect(names(JSON.stringify(sitemap()))).toEqual([]);
    expect(names(await llmsTxt().text())).toEqual([]);
  });

  it("the home FAQ, the definition page and the law-firm page compare with a kind of tool, not a brand (rule 1745)", () => {
    expect(dict.ar.faq.items[0].q).toBe("ليش ما أستخدم أداة محادثة عامة مباشرة؟");
    expect(dict.en.faq.items[0].q).toBe("Can't I just use a general AI chat tool?");
    const def = read("src/app/[lang]/ai-marketing-agent/page.tsx");
    expect(def).toContain('"مساعد محادثة عام"');
    expect(def).toContain('"General chat assistant"');
    expect(def).toContain("href={`/${lang}/compare`}");
    expect(read("src/lib/pages-industry.ts")).toContain("Competitors show up in AI answers, you don't");
  });
});

describe("rule 1741: one comparison page, by kind, with no scores, ranks or other vendors' prices", () => {
  it("both languages show the same four kinds, in order", () => {
    for (const lang of LANGS) expect(COMPARE_PAGE[lang].groups.map((g) => g.id), lang).toEqual([...COMPARE_GROUPS]);
    expect(COMPARE_GROUPS).toEqual(["general-ai-chat", "global-marketing-platforms", "agencies", "freelancers"]);
  });

  it("every kind says where it is the better choice too, and the rows line up across languages", () => {
    for (const g of COMPARE_GROUPS) {
      const [ar, en] = LANGS.map((l) => COMPARE_PAGE[l].groups.find((x) => x.id === g)!);
      expect(ar.rows.length, g).toBe(en.rows.length);
      expect(ar.rows.length, g).toBeGreaterThanOrEqual(4);
      for (const x of [ar, en]) {
        expect(x.chooseThem.length, g).toBeGreaterThanOrEqual(2);
        expect(x.chooseUs.length, g).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("no cell about the alternative states a number: no price, no score, no count", () => {
    for (const lang of LANGS) for (const g of COMPARE_PAGE[lang].groups) for (const r of g.rows) expect(r.them, `${lang} ${g.id}`).not.toMatch(/\d/);
  });

  it("no score, weight, rank or 'best' wording anywhere on the page", () => {
    // The disclosure says it gives no scores and ranks nothing; every other string is checked.
    const all = JSON.stringify(LANGS.map((l) => ({ ...COMPARE_PAGE[l], disclosure: "" })));
    expect(all).not.toMatch(/\b(score|scores|rank|ranked|ranking|weight|best|#1|number one)\b/i);
    expect(all).not.toMatch(/درجة|الدرجات|المرتبة|الأفضل|الأول في/);
  });

  it("says it is our own opinion and gives the corrections address, in both languages", () => {
    expect(COMPARE_PAGE.ar.disclosure).toContain("هذه المقارنة رأينا نحن");
    expect(COMPARE_PAGE.ar.disclosure).toContain("لا نعطي درجات ولا نرتّب الخيارات");
    expect(COMPARE_PAGE.ar.disclosure).toContain("hello@thakeen.com");
    expect(COMPARE_PAGE.en.disclosure).toContain("this comparison is our own opinion");
    expect(COMPARE_PAGE.en.disclosure).toContain("we give no scores and we do not rank the options");
    expect(COMPARE_PAGE.en.disclosure).toContain("hello@thakeen.com");
  });

  it("renders a heading and an anchor per kind, the disclosure first", async () => {
    for (const lang of LANGS) {
      const html = renderToStaticMarkup(await ComparePage({ params: Promise.resolve({ lang }) }));
      for (const g of COMPARE_PAGE[lang].groups) {
        expect(html).toContain(`<section id="${g.id}"`);
        expect(html).toContain(`href="#${g.id}"`);
      }
      expect(html.indexOf("hello@thakeen.com")).toBeLessThan(html.indexOf(`id="${COMPARE_GROUPS[0]}"`));
    }
  });
});

describe("rule 1742: the old addresses answer 308 to the comparison page, and nothing lists them", () => {
  it("each retired address, in both languages, is a permanent redirect to /{lang}/compare", async () => {
    const rules = await nextConfig.redirects!();
    for (const lang of LANGS) {
      for (const path of [...RETIRED, "/vs", "/vs/not-a-competitor"]) {
        const hit = rules.find((r) => getPathMatch(r.source)(`/${lang}${path}`));
        expect(hit, `/${lang}${path}`).toBeTruthy();
        expect(hit!.permanent, path).toBe(true);
        expect(hit!.destination.replace(":lang", lang), path).toBe(`/${lang}/compare`);
      }
    }
    // The redirects are narrow: the comparison page itself, other blog posts and unknown languages are untouched.
    for (const path of ["/ar/compare", "/en/blog/best-ai-marketing-agents-gulf-2026", "/xx/vs/chatgpt", "/ar/vsx"]) {
      expect(rules.some((r) => getPathMatch(r.source)(path)), path).toBe(false);
    }
  });

  it("the old route, the old module and the vendor post are gone", () => {
    expect(existsSync("src/app/[lang]/vs")).toBe(false);
    expect(existsSync("src/lib/pages-vs.ts")).toBe(false);
    expect(existsSync("src/components/VsThem.tsx")).toBe(false);
    expect(existsSync("content/blog/nashr-vs-enrich-labs.md")).toBe(false);
  });

  it("the sitemap lists /compare in both languages and none of the retired addresses", () => {
    const urls = sitemap().map((e) => new URL(e.url).pathname);
    for (const lang of LANGS) expect(urls).toContain(`/${lang}/compare`);
    expect(urls.filter((u) => /\/vs(\/|$)|nashr-vs-enrich-labs/.test(u))).toEqual([]);
  });

  it("llms.txt, the resources page, the footer and the menus link /compare, never /vs", async () => {
    const txt = await llmsTxt().text();
    expect(txt).toContain("/ar/compare");
    expect(txt).toContain("/en/compare");
    expect(txt).not.toMatch(/\/vs\//);
    for (const f of ["src/app/[lang]/resources/page.tsx", "src/components/Footer.tsx", "src/lib/i18n.ts", "src/app/[lang]/ai-marketing-agent/page.tsx"]) {
      expect(read(f), f).toContain("/compare");
      expect(read(f), f).not.toMatch(/\/vs\//);
    }
  });
});

describe("rule 1743: a direct Salla or Zid link is called planned; reading a store from its link is what works today", () => {
  it("every sentence on the page that names a Salla or Zid link says planned", () => {
    for (const lang of LANGS) {
      const text = COMPARE_PAGE[lang].groups.flatMap((g) => g.rows.map((r) => r.us)).filter((s) => /سلة|زد|Salla|Zid/.test(s));
      expect(text.length, lang).toBeGreaterThan(0);
      for (const s of text) expect(s, s).toMatch(lang === "ar" ? /مخطط له/ : /planned/);
    }
  });

  it("nothing says products are imported from Salla or Zid today", () => {
    const all = JSON.stringify(COMPARE_PAGE) + read(ARTICLE);
    expect(all).not.toMatch(/استيراد المنتجات من سلة|Product import from Salla|reads Salla and Zid stores|تقرأ متاجر سلة وزد|connects? (to )?Salla/i);
  });

  it("the agents article says the same", () => {
    const [ar, en] = read(ARTICLE).split(/\n---EN---\n/);
    expect(ar).toContain("ربط سلة وزد مخطط له");
    expect(en).toContain("the Salla and Zid link is planned");
  });
});

describe("rule 1744: the agents article compares kinds and points to the comparison page", () => {
  it("both halves link /compare in their own language", () => {
    const [ar, en] = read(ARTICLE).split(/\n---EN---\n/);
    expect(ar).toContain("](/ar/compare)");
    expect(en).toContain("](/en/compare)");
  });

  it("its title promises no count and no 'best'", () => {
    const head = read(ARTICLE).match(/^---\n([\s\S]*?)\n---\n/)![1];
    // The year in the title is a date, not a count.
    expect(head.replace(/2026/g, "")).not.toMatch(/title_(ar|en): .*\d/);
    expect(head).not.toMatch(/أفضل|\bbest\b/i);
  });
});
