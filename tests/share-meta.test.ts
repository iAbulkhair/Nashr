import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";

/**
 * Rules 359-362 (#45). Every shared link used to show the same card: og:title was the brand word on every page, with no
 * share image and no metadataBase. The layout now sets the base, the share image (src/app/[lang]/opengraph-image.png)
 * and a large twitter card, with no og title or description of its own, so Next fills them from each page's metadata.
 * The rendered tags are checked end to end in e2e/public-pages.spec.ts.
 */

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "", className: "", style: {} });
  return { IBM_Plex_Mono: font, IBM_Plex_Sans_Arabic: font, Readex_Pro: font };
});

afterEach(() => vi.unstubAllEnvs());

const LANG_DIR = join("src", "app", "[lang]");
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});
/** Route params for any page under [lang]: `lang` plus whatever dynamic segment the page has. */
type Params = { lang: string; agent: string; tool: string; competitor: string; industry: string; slug: string };
const P = (lang: string, extra: Record<string, string> = {}) => ({ params: Promise.resolve({ lang, agent: "", tool: "", competitor: "", industry: "", slug: "", ...extra } as Params) });

describe("rule 359: the layout's share card is a fallback that pages fill in", () => {
  it("sets metadataBase from appOrigin(), a large twitter card, and no og title or description of its own", async () => {
    vi.stubEnv("APP_ORIGIN", "https://thakeen.example");
    const { generateMetadata } = await import("@/app/[lang]/layout");
    for (const lang of ["ar", "en"]) {
      const m = await generateMetadata(P(lang));
      expect(String(m.metadataBase)).toBe("https://thakeen.example/");
      expect(m.twitter).toMatchObject({ card: "summary_large_image" });
      const og = m.openGraph as Record<string, unknown>;
      expect(og.siteName).toBe(lang === "ar" ? "ذكين" : "Thakeen");
      expect(og, "an og:title here would be every page's og:title").not.toHaveProperty("title");
      expect(og).not.toHaveProperty("description");
      expect(m.twitter).not.toHaveProperty("title");
    }
  });

  it("no page under [lang] sets openGraph or twitter, which would drop the inherited share image", () => {
    const hits = files(LANG_DIR).filter((p) => !p.endsWith(join("[lang]", "layout.tsx")) && /\b(openGraph|twitter)\s*:/.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("rule 360: one share image for every public page", () => {
  it("is a 1200x630 PNG small enough for messaging-app previews, with alt text naming the product and no model", () => {
    const png = readFileSync(join(LANG_DIR, "opengraph-image.png"));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    // X refuses images over 5 MB and Facebook over 8 MB; WhatsApp is known to skip large preview images, so keep it small.
    expect(png.length).toBeLessThan(300 * 1024);
    const alt = readFileSync(join(LANG_DIR, "opengraph-image.alt.txt"), "utf8");
    expect(alt).toContain("ذكين");
    expect(alt).toContain("Thakeen");
    expect(alt).not.toMatch(/claude|anthropic|opus|sonnet|haiku|gpt|gemini/i);
  });
});

describe("rule 361: pageMeta gives each page its own title, description, canonical and hreflang", () => {
  it("builds canonical and both languages, or only the canonical for a one-language page, and never openGraph", async () => {
    const { pageMeta } = await import("@/lib/page-meta");
    const m = pageMeta("ar", "/pricing", { title: "T", description: "D" });
    expect(m).toEqual({ title: "T", description: "D", alternates: { canonical: "/ar/pricing", languages: { ar: "/ar/pricing", en: "/en/pricing" } } });
    expect(pageMeta("en", "/blog/x", { title: "T", bilingual: false })).toEqual({ title: "T", alternates: { canonical: "/en/blog/x" } });
  });
});

describe("rule 362: every public page with metadata names itself in both languages", () => {
  const pages: [string, () => Promise<{ generateMetadata: (p: ReturnType<typeof P>) => Promise<Metadata> }>, Record<string, string>?][] = [
    ["/customers", () => import("@/app/[lang]/customers/page")],
    ["/enterprise", () => import("@/app/[lang]/enterprise/page")],
    ["/resources", () => import("@/app/[lang]/resources/page")],
    ["/agents", () => import("@/app/[lang]/agents/page")],
    ["/agents/noor", () => import("@/app/[lang]/agents/[agent]/page"), { agent: "noor" }],
    ["/tools", () => import("@/app/[lang]/tools/page")],
    ["/tools/hook-generator", () => import("@/app/[lang]/tools/[tool]/page"), { tool: "hook-generator" }],
    ["/help", () => import("@/app/[lang]/help/page")],
    ["/updates", () => import("@/app/[lang]/updates/page")],
    ["/ai-marketing-agent", () => import("@/app/[lang]/ai-marketing-agent/page")],
    ["/vs/chatgpt", () => import("@/app/[lang]/vs/[competitor]/page"), { competitor: "chatgpt" }],
    ["/for/ecommerce", () => import("@/app/[lang]/for/[industry]/page"), { industry: "ecommerce" }],
  ];
  for (const [path, load, extra] of pages) {
    it(path, async () => {
      const { generateMetadata } = await load();
      const titles: unknown[] = [];
      for (const lang of ["ar", "en"]) {
        const m = await generateMetadata(P(lang, extra));
        expect(typeof m.title === "string" && m.title.length > 0, `${lang}${path} needs a title`).toBe(true);
        expect(typeof m.description === "string" && m.description.length > 0, `${lang}${path} needs a description`).toBe(true);
        expect(m.title).not.toBe(lang === "ar" ? "ذكين" : "Thakeen");
        expect(m.alternates?.canonical).toBe(`/${lang}${path}`);
        expect(m).not.toHaveProperty("openGraph");
        titles.push(m.title);
      }
      expect(titles[0]).not.toBe(titles[1]);
    });
  }
});
