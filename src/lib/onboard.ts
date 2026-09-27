import { meter } from "./usage";
import Anthropic from "@anthropic-ai/sdk";
import type { Brand } from "./brand";
import { activeSeasons } from "./seasons";
import type { SiteSnapshot } from "./crawl";

import type { PlanItem } from "./chat";

export type OnboardResult = { brand: Brand; files: { name: string; content: string }[]; /** three starter tasks the owner can add with one tap */ plan: PlanItem[]; /** an output goal Nashr controls (items shipped), never a results promise */ goal: string; /** closing chat message */ summary: string };

/** Task types the starter plan may use: small, fast, visibly useful in the first session. */
const PLAN_TYPES = ["social", "article", "whatsapp", "ads", "gbp", "weekly_plan", "followup_seq", "pricing_review", "growth_experiments"] as const;

const str = { type: "string" } as const;
const BRAND_SCHEMA = {
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
} as const;
const obj = <P extends Record<string, unknown>>(properties: P) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties }) as const;

/**
 * The workspace is written by three model calls that run side by side, each from the same snapshot. One call used to write
 * all five files in a row, and a new owner waited for the sum; now the wait is the slowest part. Every output key belongs
 * to exactly one part (pinned by tests/onboard-parts.test.ts).
 */
export const PARTS = {
  core: { maxTokens: 10000, schema: obj({ brand: BRAND_SCHEMA, brand_md: str, plan: { type: "array", items: obj({ title: str, type: { type: "string", enum: [...PLAN_TYPES] }, brief: str }) }, goal: str, summary: str }) },
  identity: { maxTokens: 12000, schema: obj({ brand_guidelines_md: str, opportunities_md: str }) },
  market: { maxTokens: 12000, schema: obj({ market_research_md: str, strategy_md: str }) },
} as const;
export type PartName = keyof typeof PARTS;

function mock(site: SiteSnapshot, lang: "ar" | "en"): OnboardResult {
  const name = site.title.split(/[|–-]/)[0].trim() || new URL(site.url).hostname;
  return {
    brand: { name, website: site.url, industry: "متجر إلكتروني", city: "الرياض", dialect: "saudi", languages: [lang, lang === "ar" ? "en" : "ar"], tone: "ودود، واضح", products: site.description || "(dev mock)", audience: "عملاء في السعودية", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram", "snapchat", "tiktok", "whatsapp"], updatedAt: new Date().toISOString() },
    files: [
      { name: "brand.md", content: `# ${name}\n\n(DEV MOCK — set ANTHROPIC_API_KEY)\n\nSite: ${site.url}\nPlatform: ${site.platform}` },
      { name: "brand-guidelines.md", content: `# Brand guidelines\n\n(DEV MOCK)\n\nColours: ${(site.colors ?? []).join(", ") || "not detected"}\nFonts: ${(site.fonts ?? []).join(", ") || "not detected"}` },
      { name: "opportunities.md", content: "# Opportunities\n\n(DEV MOCK)" },
      { name: "market-research.md", content: "# Market research\n\n(DEV MOCK)" },
      { name: "strategy.md", content: "# 90-day strategy\n\n(DEV MOCK)" },
    ],
    plan: [
      { title: lang === "ar" ? "3 منشورات إنستقرام تعريفية" : "3 introductory Instagram posts", type: "social", brief: "DEV MOCK" },
      { title: lang === "ar" ? "رسالتا واتساب للمتابعة" : "2 WhatsApp follow-up messages", type: "whatsapp", brief: "DEV MOCK" },
      { title: lang === "ar" ? "مقالة SEO واحدة" : "One SEO article", type: "article", brief: "DEV MOCK" },
    ],
    goal: lang === "ar" ? "أول 20 عنصراً معتمداً خلال 14 يوماً" : "First 20 approved items in 14 days",
    summary: lang === "ar" ? "(DEV MOCK) قرأت موقعك وجهزت ملفاتك. بماذا نبدأ؟" : "(DEV MOCK) I read your site and prepared your files. Where do we start?",
  };
}

/** `onPart` fires as each of the three parts lands, so the chat can show real progress instead of a timer. */
export async function buildFromSite(site: SiteSnapshot, lang: "ar" | "en", hints?: string, email?: string, onPart?: (part: PartName) => void): Promise<OnboardResult> {
  if (!process.env.ANTHROPIC_API_KEY) return mock(site, lang);
  const client = new Anthropic();
  const seasons = activeSeasons().map((s) => `${s.name} in ${s.daysLeft} days`).join("; ") || "none in 35 days";
  const shared = `You are Noor (نور), Nashr's marketing agent for Gulf businesses. From a website snapshot, build part of the founding workspace for this brand. Two other parts are being written at the same time from the same snapshot, so stay strictly inside the fields asked for here. Be specific to what the site actually says; when the site is thin or unreachable, infer carefully from the domain, title, and any hints, and mark inferred facts with "(مُستنتج)" / "(inferred)". Never invent prices, certifications, or numbers. The brand's dialect is saudi unless the site is clearly UAE (emirati), Kuwait (kuwaiti), or English-only (english).

Write the markdown files in ${lang === "ar" ? "Arabic (simplified MSA), with English terms where standard" : "English"}.

`;
  const asks: Record<PartName, string> = {
    core: `brand_md: brand profile — name, what they sell, audience, positioning, tone of voice, dialect policy, banned/preferred words (suggest 5 each), visual/cultural notes for the Gulf, payment/delivery trust signals to mention (mada, Apple Pay, Tabby/Tamara, delivery cities) if e-commerce.
plan: exactly 3 starter tasks Noor's team can deliver today, most valuable first, each quantified and specific to this business (for example "3 Instagram posts introducing the monthly subscription"). title is what the owner reads on the button (<= 90 chars, in the output language); type is the task type; brief is the instruction the agent will receive (2-3 sentences, concrete, in the output language).
goal: one line, an OUTPUT goal Nashr controls (items drafted, approved or published in a period), never a results promise such as traffic, leads or revenue growth.
summary: the closing chat message, 2-3 sentences in the output language, first person as Noor: what you read, what you prepared (five files and a plan), then ask what to tackle first. No greetings, no emojis.

brand.industry must be one of the allowed Arabic labels. dialect: saudi unless the site is clearly UAE (emirati), Kuwait (kuwaiti), or English-only (english).`,
    identity: `brand_guidelines_md: visual and verbal identity. Colour palette with hex codes and the role of each colour, and fonts, taken ONLY from DETECTED VISUALS below (if none were detected say so plainly and tell the owner to upload the logo and brand colours; never invent hex codes). Then tone of voice, 4-6 messaging principles, do and do-not wording examples in the brand's dialect.
opportunities_md: "money on the table" audit as a Markdown table (opportunity, status, source, benefit, fit or gaps, next step). Cover what is relevant: Gulf SME programs (Monsha'at, Kafalah, Saudi Business Center, or the UAE/Kuwait equivalents for that market), ad-platform credits for new advertisers, store-platform app perks (Salla, Zid, Shopify) when that platform was detected, payment and BNPL options missing from the site, and tracking or conversion leaks visible in the snapshot (no WhatsApp link, no clear CTA, no reviews, missing meta description). Status is exactly one of "يحتاج تحققاً" / "Needs verification" or "قابل للتنفيذ الآن" / "Actionable now". Never state amounts, eligibility or deadlines you cannot see: say what to verify and where.`,
    market: `market_research_md: KSA/GCC market notes for this industry — where customers discover (Snap/TikTok/IG/X/Google), 3-5 likely competitors (name only if confident, else describe types), seasonal opportunities (upcoming: ${seasons}), quick wins.
strategy_md: 90-day plan in 3 phases with concrete weekly cadence per channel, the first 5 tasks Noor should run, and 3 measurable OUTPUT targets Nashr controls (items drafted, approved or published in a period), never results promises such as traffic, followers, leads or revenue growth.`,
  };

  const user = `WEBSITE SNAPSHOT
URL: ${site.url}
Reachable: ${site.ok} ${site.error ? "(" + site.error + ")" : ""}
Platform detected: ${site.platform}
Title: ${site.title}
Description: ${site.description}
Links sample: ${site.links.slice(0, 25).join(", ")}
DETECTED VISUALS: colours ${(site.colors ?? []).join(", ") || "none detected"}; fonts ${(site.fonts ?? []).join(", ") || "none detected"}
${hints ? "\nOWNER HINTS: " + hints.slice(0, 800) : ""}

PAGE TEXT (truncated):
${site.text.slice(0, 9000)}`;

  const run = async (name: PartName, attempt = 0): Promise<Record<string, unknown>> => {
    try {
      const msg = await client.messages
        .stream({
          model: "claude-opus-5",
          max_tokens: PARTS[name].maxTokens,
          system: `${shared}${asks[name]}`,
          messages: [{ role: "user", content: user }],
          thinking: { type: "adaptive" },
          output_config: { effort: "medium", format: { type: "json_schema", schema: PARTS[name].schema } },
        })
        .finalMessage();
      await meter(email, msg.model, "onboard", msg.usage);
      const out = JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("")) as Record<string, unknown>;
      onPart?.(name);
      return out;
    } catch (e) {
      // Three calls fail more often than one; a part gets one more try before the whole run gives up.
      if (attempt < 1) return run(name, attempt + 1);
      throw e;
    }
  };
  const [core, identity, market] = await Promise.all([run("core"), run("identity"), run("market")]);
  const j = { ...core, ...identity, ...market } as { brand: Omit<Brand, "website" | "banned" | "preferred" | "updatedAt">; brand_md: string; brand_guidelines_md: string; opportunities_md: string; market_research_md: string; strategy_md: string; plan: PlanItem[]; goal: string; summary: string };
  const brand: Brand = { ...j.brand, website: site.url, banned: "", preferred: "", updatedAt: new Date().toISOString() } as Brand;
  return {
    brand,
    files: [
      { name: "brand.md", content: j.brand_md },
      { name: "brand-guidelines.md", content: j.brand_guidelines_md },
      { name: "opportunities.md", content: j.opportunities_md },
      { name: "market-research.md", content: j.market_research_md },
      { name: "strategy.md", content: j.strategy_md },
    ],
    plan: (j.plan ?? []).slice(0, 3).map((x) => ({ title: String(x.title).slice(0, 120), type: x.type, brief: String(x.brief).slice(0, 600) })),
    goal: String(j.goal ?? "").slice(0, 140),
    summary: String(j.summary ?? "").slice(0, 600),
  };
}
