import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Metadata } from "next";

/**
 * Rules 359-362 and 366 (#45). Every shared link used to show the same card: og:title was the brand word on every page, with no
 * share image and no metadataBase. The layout now sets the base, the share image (src/app/[lang]/opengraph-image.png)
 * and a large twitter card, with no og title or description of its own, so Next fills them from each page's metadata.
 * The rendered tags are checked end to end in e2e/public-pages.spec.ts.
 */

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "", className: "", style: {} });
  return { IBM_Plex_Mono: font, IBM_Plex_Sans_Arabic: font };
});
vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "", style: {} }) }));

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

describe("rule 366: the default share card carries the public name and the founder's slogan, not an agent's tagline", () => {
  const NO_AGENT_OR_MODEL = /نور|Noor|claude|anthropic|opus|sonnet|haiku|gpt|gemini/i;

  it("the layout's default title and description (the homepage's og:title and og:description)", async () => {
    const { generateMetadata } = await import("@/app/[lang]/layout");
    const { SLOGAN_AR } = await import("@/lib/page-meta");
    const { SLOGAN } = await import("@/lib/home");
    // One source: the homepage h1's slogan (src/lib/home.ts), never a second literal that can drift.
    expect(SLOGAN_AR).toBe(SLOGAN.line1.ar);
    expect(SLOGAN.line1).toEqual({ ar: "ذكين. الذكي المكين.", en: "Thakeen. Smart. Steadfast." });
    const ar = await generateMetadata(P("ar"));
    expect(ar.title).toBe("ذكين. الذكي المكين.");
    // Masculine, to agree with ذكين (الذكي المكين); the feminine «وكيلة … مبنية» is Noor's and stays in the footer.
    expect(ar.description).toBe("ذكين. الذكي المكين. وكيل تسويق مبني للخليج.");
    expect(String(ar.description)).not.toMatch(/وكيلة|مبنية/);
    const en = await generateMetadata(P("en"));
    expect(en.title).toBe("Thakeen. Smart. Steadfast.");
    expect(en.description).toBe("Thakeen. Smart. Steadfast. A marketing agent built for the Gulf.");
    for (const m of [ar, en]) {
      expect(String(m.title)).not.toMatch(NO_AGENT_OR_MODEL);
      expect(String(m.description)).not.toMatch(NO_AGENT_OR_MODEL);
    }
  });

  it("the share image's alt text says the same, and the e2e default title matches the layout", async () => {
    const alt = readFileSync(join(LANG_DIR, "opengraph-image.alt.txt"), "utf8");
    expect(alt).toContain("ذكين. الذكي المكين.");
    expect(alt).toContain("Thakeen. Smart. Steadfast.");
    expect(alt).not.toMatch(NO_AGENT_OR_MODEL);
    const { DEFAULT_TITLE } = await import("../e2e/fixtures/routes");
    const { SITE_DEFAULT } = await import("@/lib/page-meta");
    expect(DEFAULT_TITLE).toEqual({ ar: SITE_DEFAULT.ar.title, en: SITE_DEFAULT.en.title });
  });

  it("the share image is a new file, not the card with the agent's tagline", () => {
    const png = readFileSync(join(LANG_DIR, "opengraph-image.png"));
    // SHA-256 of the #45 card that read "نور، وكيلة تسويق للخليج / Noor, the AI marketing agent for the Gulf".
    const OLD_CARD_SHA256 = "66093f6d401a0228cc8a57cf2c971cc8c31bb62a391a9bac89dd9e82a0cf40f6";
    // And the first slogan card, whose English line was the footer tagline instead of the English slogan.
    const FOOTER_TAGLINE_CARD_SHA256 = "670f9a7546401b3b5c9eb27e9ed2ac1a25d8ce1a1338951ba42c88a5b1470ce0";
    const sha = createHash("sha256").update(png).digest("hex");
    expect(sha).not.toBe(OLD_CARD_SHA256);
    expect(sha).not.toBe(FOOTER_TAGLINE_CARD_SHA256);
  });
});
