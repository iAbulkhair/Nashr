import { meter } from "./usage";
import Anthropic from "@anthropic-ai/sdk";
import type { Brand, TaskType } from "./brand";
import { pickPlaybook } from "./playbooks";
import { activeSeasons } from "./seasons";

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

${playbookBlock(brand)}

GULF CALENDAR — LIVE OR WITHIN 35 DAYS (plan for these)
${seasonBlock()}

OWNER PREFERENCES LEARNED FROM PAST EDITS (highest priority)
${prefs.length ? prefs.map((p) => "- " + p).join("\n") : "- none yet"}

OUTPUT FORMAT
Return ONLY a JSON array. Each element: {"channel": string, "title": string, "body": string}. "title" is a short internal label (≤ 60 chars). "body" is the full content (Markdown allowed). No text before or after the JSON.`;
}

function playbookBlock(brand: Brand) {
  const pb = pickPlaybook(brand.industry);
  return pb ? pb.text : "INDUSTRY PLAYBOOK\n- General SMB: one clear offer, one CTA, local proof, WhatsApp as the conversion channel.";
}

function seasonBlock() {
  const s = activeSeasons();
  if (!s.length) return "- No major season in the next 35 days. Focus on evergreen content and audience building.";
  return s.map((x) => `- ${x.name} (${x.nameAr}) in ${x.daysLeft} days: ${x.play}`).join("\n");
}

const CHANNELS = ["instagram", "snapchat", "tiktok", "whatsapp", "meta", "linkedin", "gbp", "blog", "plan", "x"];
function normalizeChannel(raw: string): string {
  const c = raw.toLowerCase().trim();
  if (c === "x" || c === "twitter") return "x";
  for (const k of CHANNELS) if (c.startsWith(k.slice(0, 4))) return k;
  if (c.includes("google")) return "gbp";
  if (c.includes("face") || c.includes("insta")) return c.includes("insta") ? "instagram" : "meta";
  return c.slice(0, 20) || "general";
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
    .map((x) => ({ channel: normalizeChannel(String(x.channel ?? "general")), title: String(x.title ?? "").slice(0, 80), body: String(x.body) }));
}

function mock(type: TaskType, brand: Brand): Generated[] {
  const n = SPECS[type].count;
  return Array.from({ length: n }, (_, i) => ({
    channel: type === "social" ? ["instagram", "snapchat", "tiktok", "x"][i % 4] : type,
    title: `[DEV MOCK] ${type} #${i + 1} for ${brand.name}`,
    body: `ANTHROPIC_API_KEY is not set, so this is placeholder content.\n\nBrand: ${brand.name}\nTask: ${type}\nItem ${i + 1} of ${n}.`,
  }));
}

export type GenOptions = { /** account email for token metering */ meter?: string; memory?: string; reviewer?: boolean; noEmDash?: boolean };

function stripDashes(items: Generated[]) {
  return items.map((i) => ({ ...i, body: i.body.replace(/\s*[—–]\s*/g, ", ") }));
}

export async function generate(type: TaskType, brand: Brand, prefs: string[], extra?: string, opts: GenOptions = {}): Promise<Generated[]> {
  if (!process.env.ANTHROPIC_API_KEY) return mock(type, brand);
  const client = new Anthropic();
  const userMsg = `TASK: ${SPECS[type].spec}${extra ? `\n\nOWNER NOTES FOR THIS BATCH: ${extra.slice(0, 1000)}` : ""}\n\nReturn exactly ${SPECS[type].count} item(s) as a JSON array.`;

  const params = {
    model: "claude-opus-5",
    max_tokens: 16000,
    system: [{ type: "text" as const, text: systemPrompt(brand, prefs) + (opts.memory ? "\n\nWORKSPACE FILES (Noor's memory — follow them)\n" + opts.memory : ""), cache_control: { type: "ephemeral" as const } }],
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
    await meter(opts.meter, msg.model, "generate", msg.usage);
    text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  } catch (e) {
    // Fallback parameter not accepted (older org/plan) → plain request.
    if (e instanceof Anthropic.BadRequestError) {
      const msg = await client.messages.stream(params).finalMessage();
      await meter(opts.meter, msg.model, "generate", msg.usage);
      text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    } else {
      throw e;
    }
  }
  let items = parseItems(text);
  if (opts.reviewer !== false) items = await critique(client, brand, prefs, type, items, opts.meter);
  if (opts.noEmDash) items = stripDashes(items);
  return items;
}

/**
 * Second pass: a cheaper model reviews every item against the brand file, Gulf
 * compliance rules and the owner's preferences, and rewrites what fails.
 */
async function critique(client: Anthropic, brand: Brand, prefs: string[], type: TaskType, items: Generated[], meterEmail?: string): Promise<Generated[]> {
  if (!items.length) return items;
  try {
    const review = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: `You are the quality reviewer for Noor, a Gulf marketing agent. You receive the brand file and a batch of generated items. For EACH item check:
1. Language policy and dialect match the brand file.
2. No invented prices, discounts, certifications, medical/legal/financial guarantees, or fake social proof (numbers not in the brand file must be placeholders like [رقم]).
3. Gulf/Saudi advertising compliance for the industry (health, legal, real estate license placeholders).
4. Banned words absent, preferred words used where natural.
5. Owner preferences respected.
6. Platform fit (length, hashtags, CTA present, no meta commentary, complete and paste-ready).
Return ONLY a JSON array, same length and order as input: {"ok": true} if the item passes, or {"ok": false, "body": "<full corrected body>"} with the minimal fix applied. Never change the item's language or intent; never add commentary.`,
      messages: [
        {
          role: "user",
          content: `BRAND FILE\n${JSON.stringify({ name: brand.name, industry: brand.industry, dialect: brand.dialect, languages: brand.languages, tone: brand.tone, banned: brand.banned, preferred: brand.preferred, offers: brand.offers }, null, 0)}\n\nOWNER PREFERENCES\n${prefs.join("\n") || "none"}\n\nTASK TYPE: ${type}\n\nITEMS\n${JSON.stringify(items.map((i) => ({ channel: i.channel, body: i.body })))}`,
        },
      ],
    });
    await meter(meterEmail, review.model, "review", review.usage);
    const raw = review.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const verdicts = JSON.parse(cleaned.slice(cleaned.indexOf("["), cleaned.lastIndexOf("]") + 1)) as Array<{ ok: boolean; body?: string }>;
    return items.map((it, i) => (verdicts[i] && verdicts[i].ok === false && typeof verdicts[i].body === "string" && verdicts[i].body!.length > 20 ? { ...it, body: verdicts[i].body! } : it));
  } catch (e) {
    // Reviewer failure must never block delivery; ship the first pass.
    console.warn("critique skipped", e instanceof Error ? e.message : e);
    return items;
  }
}
