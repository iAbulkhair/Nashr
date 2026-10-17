import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMPARE_PAGE } from "@/lib/pages-compare";
import { backArrow, formatNumber, nextArrow } from "@/lib/format";
import { HELP } from "@/lib/help";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { LANGS } from "@/lib/i18n";

/**
 * Public-site fixes of 2026-10-13 (rules 1580-1589, docs/system/tests/1580-public-site-fixes.md): the comparison pages
 * name no model; the UI writes Western digits everywhere, loads a real Arabic bold, preloads less, mirrors text arrows in
 * Arabic and keeps footer links 24px tall. Rules 1580 (dated competitor prices) and 1582 (Salla and Zid planned) went
 * with the named comparison pages the same day: no competitor price is left to date, and rule 1743 in
 * tests/compare-generic.test.ts holds the Salla and Zid wording (docs/system/tests/1740-compare-generic.md).
 */
const read = (f: string) => readFileSync(f, "utf8");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const ARTICLE = "content/blog/best-ai-marketing-agents-gulf-2026.md";

describe("rule 1583: the comparison page and the agents article name no AI model", () => {
  it("no model or model vendor is named", () => {
    const MODEL = /Claude|Anthropic|Sonnet|Opus|Haiku|Gemini|GPT-?\d|\bo\d-|Llama|Mistral|DeepSeek/i;
    expect(JSON.stringify(COMPARE_PAGE)).not.toMatch(MODEL);
    expect(read(ARTICLE)).not.toMatch(MODEL);
  });
});

describe("rule 1584: Western digits in the whole UI, Arabic pages included", () => {
  const ARABIC_INDIC = /[٠-٩۰-۹]/;
  // Parsers that read what a person typed or pasted turn Arabic-Indic digits into Western ones; they keep the digits on
  // purpose and are not UI copy.
  const PARSERS = new Set(["src/lib/perf-import.ts", "src/lib/cart-recovery.ts", "src/lib/instructions-safety.ts", "src/lib/verify-email.ts", "src/lib/verify-client.ts", "src/lib/secretary-input.ts", "src/lib/golden.ts"]);
  const ui = [...walk("src/components"), ...walk("src/app"), ...walk("src/lib").filter((f) => /\.tsx?$/.test(f))].filter((f) => /\.(tsx?|css)$/.test(f) && !PARSERS.has(f));

  it("no component, page or copy file writes an Arabic-Indic digit", () => {
    expect(ui.length).toBeGreaterThan(100);
    const hits = ui.filter((f) => ARABIC_INDIC.test(read(f)));
    expect(hits).toEqual([]);
  });

  it("parsers only write them inside a pattern or a lookup, never in a label", () => {
    expect(read("src/lib/perf-import.ts")).toContain('label: { ar: "قصير (60 حرفاً أو أقل)"');
  });

  it("no blog post writes them", () => {
    for (const f of walk("content/blog")) expect(read(f), f).not.toMatch(ARABIC_INDIC);
  });

  it("no formatter asks for Arabic-Indic digits, and the home steps use the shared one", () => {
    for (const f of ui) expect(read(f), f).not.toMatch(/nu-arab|ar-SA-u-nu-arab/);
    expect(read("src/components/home/Steps.tsx")).toContain("formatNumber(i + 1, lang)");
    expect(formatNumber(1250, "ar")).toBe("1,250");
  });
});

describe("rule 1585: the Arabic body font has a real bold", () => {
  it("IBM Plex Sans Arabic loads 700 next to 400, 500 and 600", () => {
    expect(read("src/app/[lang]/layout.tsx")).toMatch(/IBM_Plex_Sans_Arabic\(\{[^)]*weight: \["400", "500", "600", "700"\]/);
  });
});

describe("rule 1586: fonts preloaded are only those the first screen uses", () => {
  const layout = read("src/app/[lang]/layout.tsx");
  it("Plex Arabic preloads the Arabic subset only; Plex Mono is not preloaded", () => {
    expect(layout).toMatch(/IBM_Plex_Sans_Arabic\(\{ subsets: \["arabic"\],/);
    expect(layout).toMatch(/IBM_Plex_Mono\(\{[^)]*preload: false/);
  });
  it("the home page itself uses no mono text, so nothing there waits for that face", () => {
    for (const f of walk("src/components/home")) expect(read(f), f).not.toMatch(/font-mono|--font-mono/);
  });
});

describe("rule 1587: footer links are at least 24px tall", () => {
  it("each footer link is an inline flex box with min-height 24px, and the rows keep their old pitch", () => {
    const src = read("src/components/Footer.tsx");
    expect(src).toContain('className="inline-flex min-h-6 items-center text-foreground hover:underline"');
    expect(src).toContain('<ul className="mt-3 space-y-1 text-sm">');
  });
});

describe("rule 1588: text arrows follow the reading direction", () => {
  it("the helpers point forward and back by language", () => {
    expect([nextArrow("ar"), backArrow("ar"), nextArrow("en"), backArrow("en")]).toEqual(["←", "→", "→", "←"]);
  });
  it("back and next links use them", () => {
    expect(read("src/app/[lang]/tools/[tool]/page.tsx")).toContain("${backArrow(lang)}");
    expect(read("src/components/app/InspoPanel.tsx")).toContain("${nextArrow(lang)}");
    expect(read("src/components/app/ReportsPanel.tsx")).toContain("{nextArrow(lang)}</Link>");
  });
  it("no Arabic sentence in the help, the sector pages or the Arabic half of a blog post uses →", () => {
    for (const s of HELP.flatMap((sec) => sec.items.map((i) => i.a.ar))) expect(s, s).not.toContain("→");
    expect(JSON.stringify(INDUSTRY_PAGES.ar)).not.toContain("→");
    for (const f of walk("content/blog")) expect(read(f).split(/\n---EN---\n/)[0], f).not.toContain("→");
  });
});

describe("rule 1589: Arabic words where English had slipped in", () => {
  it("the OAuth consent screen speaks Arabic by default and English when the browser asks for it", () => {
    const src = read("src/app/oauth/authorize/page.tsx");
    expect(src).toContain('<html lang={lang} dir={lang === "ar" ? "rtl" : "ltr"}>');
    expect(src).toMatch(/allow: "اسمح",\s*deny: "ارفض"/);
    expect(src).toContain("{t.allow}</button>");
    expect(src).toContain("{t.deny}</button>");
    expect(src).not.toMatch(/>(Allow|Deny)<\/button>/);
  });
  it("public forms and the main menu label their fields in Arabic on Arabic pages", () => {
    for (const f of ["src/components/HelpCenter.tsx", "src/components/AffiliateForm.tsx"]) expect(read(f), f).not.toMatch(/placeholder="Email"|aria-label="Email"/);
    expect(read("src/components/Nav.tsx")).not.toContain('aria-label="Main"');
  });
});
