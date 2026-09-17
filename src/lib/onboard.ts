import { meter } from "./usage";
import Anthropic from "@anthropic-ai/sdk";
import type { Brand } from "./brand";
import { activeSeasons } from "./seasons";
import type { SiteSnapshot } from "./crawl";

export type OnboardResult = { brand: Brand; files: { name: string; content: string }[] };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["brand", "brand_md", "market_research_md", "strategy_md"],
  properties: {
    brand: {
      type: "object",
      additionalProperties: false,
      required: ["name", "industry", "city", "dialect", "languages", "tone", "products", "audience", "offers", "competitors", "channels"],
      properties: {
        name: { type: "string" },
        industry: { type: "string", enum: ["متجر إلكتروني", "عقار", "مكتب قانوني", "شركة ناشئة", "عيادة / تجميل", "مطعم / كافيه", "وكالة تسويق", "خدمات مهنية", "أخرى"] },
        city: { type: "string" },
        dialect: { type: "string", enum: ["saudi", "msa", "emirati", "kuwaiti", "english"] },
        languages: { type: "array", items: { type: "string", enum: ["ar", "en"] } },
        tone: { type: "string" },
        products: { type: "string" },
        audience: { type: "string" },
        offers: { type: "string" },
        competitors: { type: "string" },
        channels: { type: "array", items: { type: "string", enum: ["instagram", "snapchat", "tiktok", "x", "linkedin", "whatsapp", "google"] } },
      },
    },
    brand_md: { type: "string" },
    market_research_md: { type: "string" },
    strategy_md: { type: "string" },
  },
} as const;

function mock(site: SiteSnapshot, lang: "ar" | "en"): OnboardResult {
  const name = site.title.split(/[|–-]/)[0].trim() || new URL(site.url).hostname;
  return {
    brand: { name, website: site.url, industry: "متجر إلكتروني", city: "الرياض", dialect: "saudi", languages: [lang, lang === "ar" ? "en" : "ar"], tone: "ودود، واضح", products: site.description || "(dev mock)", audience: "عملاء في السعودية", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram", "snapchat", "tiktok", "whatsapp"], updatedAt: new Date().toISOString() },
    files: [
      { name: "brand.md", content: `# ${name}\n\n(DEV MOCK — set ANTHROPIC_API_KEY)\n\nSite: ${site.url}\nPlatform: ${site.platform}` },
      { name: "market-research.md", content: "# Market research\n\n(DEV MOCK)" },
      { name: "strategy.md", content: "# 90-day strategy\n\n(DEV MOCK)" },
    ],
  };
}

export async function buildFromSite(site: SiteSnapshot, lang: "ar" | "en", hints?: string, email?: string): Promise<OnboardResult> {
  if (!process.env.ANTHROPIC_API_KEY) return mock(site, lang);
  const client = new Anthropic();
  const seasons = activeSeasons().map((s) => `${s.name} in ${s.daysLeft} days`).join("; ") || "none in 35 days";
  const sys = `You are Noor (نور), Nashr's marketing agent for Gulf businesses. From a website snapshot, build the founding workspace files for this brand. Be specific to what the site actually says; when the site is thin or unreachable, infer carefully from the domain, title, and any hints, and mark inferred facts with "(مُستنتج)" / "(inferred)". Never invent prices, certifications, or numbers.

Write the markdown files in ${lang === "ar" ? "Arabic (simplified MSA), with English terms where standard" : "English"}.

brand_md: brand profile — name, what they sell, audience, positioning, tone of voice, dialect policy, banned/preferred words (suggest 5 each), visual/cultural notes for the Gulf, payment/delivery trust signals to mention (mada, Apple Pay, Tabby/Tamara, delivery cities) if e-commerce.
market_research_md: KSA/GCC market notes for this industry — where customers discover (Snap/TikTok/IG/X/Google), 3-5 likely competitors (name only if confident, else describe types), seasonal opportunities (upcoming: ${seasons}), quick wins.
strategy_md: 90-day plan in 3 phases with concrete weekly cadence per channel, the first 5 tasks Noor should run, and 3 measurable targets.

brand.industry must be one of the allowed Arabic labels. dialect: saudi unless the site is clearly UAE (emirati), Kuwait (kuwaiti), or English-only (english).`;

  const user = `WEBSITE SNAPSHOT
URL: ${site.url}
Reachable: ${site.ok} ${site.error ? "(" + site.error + ")" : ""}
Platform detected: ${site.platform}
Title: ${site.title}
Description: ${site.description}
Links sample: ${site.links.slice(0, 25).join(", ")}
${hints ? "\nOWNER HINTS: " + hints.slice(0, 800) : ""}

PAGE TEXT (truncated):
${site.text.slice(0, 9000)}`;

  const msg = await client.messages
    .stream({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: sys,
      messages: [{ role: "user", content: user }],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    })
    .finalMessage();
  await meter(email, msg.model, "onboard", msg.usage);
  const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  const j = JSON.parse(text) as { brand: Omit<Brand, "website" | "banned" | "preferred" | "updatedAt">; brand_md: string; market_research_md: string; strategy_md: string };
  const brand: Brand = { ...j.brand, website: site.url, banned: "", preferred: "", updatedAt: new Date().toISOString() } as Brand;
  return {
    brand,
    files: [
      { name: "brand.md", content: j.brand_md },
      { name: "market-research.md", content: j.market_research_md },
      { name: "strategy.md", content: j.strategy_md },
    ],
  };
}
