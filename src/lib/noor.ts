import Anthropic from "@anthropic-ai/sdk";
import type { Brand, TaskType } from "./brand";

export type Generated = { channel: string; title: string; body: string };

const DIALECT: Record<Brand["dialect"], string> = {
  msa: "Modern Standard Arabic, simple and warm (not classical).",
  saudi: "Light Saudi (Najdi/Hijazi-neutral) dialect for social; simplified MSA for articles and formal messages.",
  emirati: "Light Emirati dialect for social; simplified MSA for articles and formal messages.",
  kuwaiti: "Light Kuwaiti dialect for social; simplified MSA for articles and formal messages.",
  english: "English only.",
};

const SPECS: Record<TaskType, { count: number; spec: string }> = {
  weekly_plan: { count: 1, spec: "One weekly marketing plan for the next 7 days: 7 day-by-day entries (channel, post idea, best posting time in local time, CTA), plus 2 ad ideas and 1 WhatsApp message idea. Consider upcoming Gulf seasons (Ramadan, Eids, Founding Day 22 Feb, Saudi National Day 23 Sep, UAE National Day 2 Dec, White Friday, back to school). channel = 'plan'." },
  social: { count: 10, spec: "10 social media posts ready to publish. Mix: 4 Instagram captions (with 5-8 Arabic+English hashtags), 3 Snapchat story scripts (short, spoken tone), 2 TikTok video scripts (hook, 3 beats, CTA, ≤30s), 1 X post. Each body must be complete and copy-paste ready. channel = instagram | snapchat | tiktok | x." },
  article: { count: 1, spec: "One SEO article of 1,200-1,600 words in the brand's primary language, targeting a keyword a competitor is likely missing. Include: title, meta description (≤155 chars), H2/H3 structure in Markdown, FAQ section with 3 questions, internal CTA. channel = 'blog'." },
  whatsapp: { count: 3, spec: "3 WhatsApp Business messages: (1) abandoned-cart or lead follow-up, (2) seasonal offer announcement, (3) post-purchase thank-you with review request. Each ≤ 700 characters, template-friendly (use {{1}} placeholders for name/order), respectful tone, one clear CTA, opt-out line. channel = 'whatsapp'." },
  ads: { count: 5, spec: "5 paid ad copies: 2 Snapchat (headline ≤34 chars + primary text ≤ 3 lines + CTA), 2 Meta/Instagram (primary text, headline ≤40 chars, description), 1 TikTok (spoken script ≤15s). Each with a target audience note and a suggested daily budget in SAR. channel = snapchat | meta | tiktok." },
  gbp: { count: 3, spec: "3 Google Business Profile posts (≤ 300 chars each): 1 offer, 1 update, 1 event/seasonal. Include CTA type (Call / Book / Order / Learn more). channel = 'gbp'." },
};

function systemPrompt(brand: Brand, prefs: string[]) {
  return `You are Noor (نور), the autonomous marketing agent of Nashr, working for a Gulf business. You produce publish-ready marketing content that a busy owner approves in one click.

BRAND FILE
- Name: ${brand.name}
- Website: ${brand.website || "n/a"}
- Industry: ${brand.industry}
- City / market: ${brand.city || "Saudi Arabia"}
- Products / services: ${brand.products}
- Audience: ${brand.audience}
- Current offers: ${brand.offers || "none stated"}
- Competitors: ${brand.competitors || "unknown"}
- Tone: ${brand.tone}
- Language policy: ${DIALECT[brand.dialect]} Output languages: ${brand.languages.join(" + ")}.${brand.languages.length > 1 ? " When both are listed, write the Arabic version first, then the English version, inside the same body." : ""}
- Banned words/claims: ${brand.banned || "none"}
- Preferred words/phrases: ${brand.preferred || "none"}
- Active channels: ${brand.channels.join(", ") || "instagram, snapchat, tiktok, whatsapp"}

RULES
- Never invent prices, discounts, certifications, or medical/legal/financial claims that are not in the brand file. If a number is needed, write [رقم] / [number] as a placeholder.
- Respect Gulf cultural norms and Saudi advertising rules: no alcohol, gambling, or indecent content; healthcare and legal content must be educational, not guarantees; real-estate content must leave room for the license number.
- Use Hijri/Gregorian season awareness. Today is ${new Date().toISOString().slice(0, 10)}.
- Emojis: light, tasteful, max 2 per post unless the tone says otherwise.
- Every item must be complete and ready to paste. No meta commentary.

OWNER PREFERENCES LEARNED FROM PAST EDITS (highest priority)
${prefs.length ? prefs.map((p) => "- " + p).join("\n") : "- none yet"}

OUTPUT FORMAT
Return ONLY a JSON array. Each element: {"channel": string, "title": string, "body": string}. "title" is a short internal label (≤ 60 chars). "body" is the full content (Markdown allowed). No text before or after the JSON.`;
}

function parseItems(text: string): Generated[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  const json = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  const arr = JSON.parse(json) as unknown;
  if (!Array.isArray(arr)) throw new Error("not_array");
  return arr
    .filter((x): x is Generated => typeof x === "object" && x !== null && typeof (x as Generated).body === "string")
    .map((x) => ({ channel: String(x.channel ?? "general").slice(0, 30), title: String(x.title ?? "").slice(0, 80), body: String(x.body) }));
}

function mock(type: TaskType, brand: Brand): Generated[] {
  const n = SPECS[type].count;
  return Array.from({ length: n }, (_, i) => ({
    channel: type === "social" ? ["instagram", "snapchat", "tiktok", "x"][i % 4] : type,
    title: `[DEV MOCK] ${type} #${i + 1} for ${brand.name}`,
    body: `ANTHROPIC_API_KEY is not set, so this is placeholder content.\n\nBrand: ${brand.name}\nTask: ${type}\nItem ${i + 1} of ${n}.`,
  }));
}

export async function generate(type: TaskType, brand: Brand, prefs: string[], extra?: string): Promise<Generated[]> {
  if (!process.env.ANTHROPIC_API_KEY) return mock(type, brand);
  const client = new Anthropic();
  const userMsg = `TASK: ${SPECS[type].spec}${extra ? `\n\nOWNER NOTES FOR THIS BATCH: ${extra.slice(0, 1000)}` : ""}\n\nReturn exactly ${SPECS[type].count} item(s) as a JSON array.`;

  const params = {
    model: "claude-opus-5",
    max_tokens: 16000,
    system: [{ type: "text" as const, text: systemPrompt(brand, prefs), cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content: userMsg }],
    thinking: { type: "adaptive" as const },
    output_config: { effort: "medium" as const },
  };

  let text = "";
  try {
    const msg = await client.beta.messages
      .stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      .finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("refused");
    text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  } catch (e) {
    // Fallback parameter not accepted (older org/plan) → plain request.
    if (e instanceof Anthropic.BadRequestError) {
      const msg = await client.messages.stream(params).finalMessage();
      text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    } else {
      throw e;
    }
  }
  return parseItems(text);
}
