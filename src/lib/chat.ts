import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "crypto";
import { db } from "./db";
import type { User } from "./auth";
import { saveUser } from "./auth";
import { TASK_COST, getBrand, listPreferences, saveBrand, saveTask, listTasks, type Brand, type Task, type TaskType } from "./brand";
import { generate } from "./noor";
import { listFiles, memoryBlock, readFile, writeFile } from "./files";
import { getGov } from "./governance";
import { activeSeasons } from "./seasons";
import { importCatalog } from "./catalog";
import { generateImage } from "./images";
import { listConnections } from "./connectors/store";
import { publishTask, targetsFor } from "./connectors/publish";
import { HELP } from "./help";
import { IMAGE_COST, getTask } from "./brand";

export type ChatMsg = { role: "user" | "assistant"; content: string; at: string; actions?: string[] };

const key = (email: string, conv?: string) => (conv && conv !== "default" ? `chat:${email}:${conv}` : `chat:${email}`);
export async function history(email: string, conv?: string): Promise<ChatMsg[]> {
  const rows = await db.lrange(key(email, conv), 0, 39);
  return rows.map((r) => JSON.parse(r) as ChatMsg).reverse();
}
async function push(email: string, m: ChatMsg, conv?: string) {
  await db.lpush(key(email, conv), JSON.stringify(m));
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "generate_content",
    description: "Create marketing items and put them in the owner's approval inbox. Deducts credits. Use when the owner asks for posts, an article, WhatsApp messages, ads, Google Business posts, or a weekly plan.",
    input_schema: { type: "object", additionalProperties: false, required: ["type"], properties: { type: { type: "string", enum: ["weekly_plan", "social", "article", "whatsapp", "ads", "gbp"] }, notes: { type: "string", description: "Owner's specific instructions for this batch (product, season, angle)." } } },
    strict: true,
  },
  {
    name: "update_brand",
    description: "Update one field of the structured brand file when the owner states a fact or preference (tone, products, offers, banned words, dialect, channels, audience, competitors, city).",
    input_schema: { type: "object", additionalProperties: false, required: ["field", "value"], properties: { field: { type: "string", enum: ["tone", "products", "audience", "offers", "competitors", "banned", "preferred", "dialect", "city", "name"] }, value: { type: "string" } } },
    strict: true,
  },
  {
    name: "read_file",
    description: "Read a workspace file (brand.md, strategy.md, market-research.md, preferences.md, or any file the owner created).",
    input_schema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } },
    strict: true,
  },
  {
    name: "write_file",
    description: "Create or overwrite a workspace markdown file. Use for new strategy docs, campaign briefs, calendars, or when the owner asks you to remember something long-form.",
    input_schema: { type: "object", additionalProperties: false, required: ["name", "content"], properties: { name: { type: "string", description: "kebab-case.md" }, content: { type: "string" } } },
    strict: true,
  },
  {
    name: "import_catalog",
    description: "Import the store's product catalog (names, prices, links) from its sitemap into products.md so content uses real products. Use when the owner mentions products, prices, or asks you to know their catalog. Takes 20-60 seconds.",
    input_schema: { type: "object", additionalProperties: false, properties: { url: { type: "string", description: "Store URL; defaults to the brand website." } } },
    strict: true,
  },
  {
    name: "generate_image",
    description: "Generate an image for an inbox item (1 credit). Use when the owner asks for a visual/photo for a specific post. Needs the item id from list_inbox.",
    input_schema: { type: "object", additionalProperties: false, required: ["task_id"], properties: { task_id: { type: "string" } } },
    strict: true,
  },
  {
    name: "publish_item",
    description: "Publish an approved inbox item to a connected platform (wordpress or shopify for articles → saved as draft on the site; x for X posts → published). Only when the owner explicitly asks to publish. Needs the item id from list_inbox.",
    input_schema: { type: "object", additionalProperties: false, required: ["task_id", "provider"], properties: { task_id: { type: "string" }, provider: { type: "string", enum: ["wordpress", "shopify", "x"] } } },
    strict: true,
  },
  {
    name: "list_inbox",
    description: "List the owner's inbox items with status counts. Use when asked what's pending or what was approved.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
    strict: true,
  },
];

function system(brand: Brand | null, user: User, prefs: string[], memory: string, files: string[], connected: string[]) {
  const seasons = activeSeasons().map((s) => `${s.name} (${s.nameAr}) in ${s.daysLeft} days`).join("; ") || "none within 35 days";
  return `You are Noor (نور), the marketing agent inside Nashr, talking with the owner of "${brand?.name ?? "their business"}". You are warm, direct, and practical, like a senior marketer who is also a friend. Reply in the language the owner writes in (Arabic in light Saudi/Gulf tone unless the brand dialect says otherwise; English if they write English). Keep replies short (2-6 sentences) unless asked for a document.

WHAT YOU CAN DO
- Create content via generate_content (it lands in the approval inbox; tell the owner it's there and how many credits it used).
- Remember facts via update_brand and write_file. Read your memory via read_file.
- Import real products from the store via import_catalog (writes products.md). Generate a visual for an inbox item via generate_image (${IMAGE_COST} credit).
- CONNECTED PLATFORMS: ${connected.length ? connected.join(", ") : "none"}. You can publish_item to connected ones (articles → WordPress/Shopify as drafts; X posts → live). For anything not connected, the owner copies approved items; say so plainly and point to the Integrations page.

CREDITS: owner has ${user.credits}. Costs: ${Object.entries(TASK_COST).map(([k, v]) => `${k}=${v}`).join(", ")}. If credits are insufficient, say so and point to the Subscription page.
PLAN: ${user.plan}${user.plan === "trial" ? ` (trial ends ${user.trialEnds.slice(0, 10)})` : ""}.
GULF CALENDAR: ${seasons}.
WORKSPACE FILES: ${files.join(", ") || "none yet"}.

BRAND (structured): ${brand ? JSON.stringify(brand) : "not set — ask for their website and suggest running onboarding"}.
OWNER PREFERENCES: ${prefs.slice(0, 15).join(" | ") || "none yet"}.

MEMORY FILES
${memory || "(empty)"}

HOW NASHR WORKS (answer "how do I…" questions from this; point to the page)
${HELP.map((t) => t.items.map((i) => `- ${i.q.en} → ${i.a.en}`).join("\n")).join("\n")}
Pages: /app/chat (you), /app (inbox), /app/files, /app/tasks, /app/governance, /app/integrations, /app/mcp, /app/billing, /app/refer, /app/help.

RULES: never invent prices/claims; respect Saudi advertising norms; one clear next step per reply; when you used a tool, say what happened in one line. Do not include internal or system XML tags in your response.`;
}

export async function chat(user: User, text: string, conv?: string): Promise<ChatMsg> {
  const email = user.scope ?? user.email;
  await push(email, { role: "user", content: text, at: new Date().toISOString() }, conv);
  const actions: string[] = [];

  if (!process.env.ANTHROPIC_API_KEY) {
    const m: ChatMsg = { role: "assistant", content: "[DEV MOCK] ANTHROPIC_API_KEY not set. I would answer here and use tools.", at: new Date().toISOString(), actions };
    await push(email, m, conv);
    return m;
  }

  const client = new Anthropic();
  const brand = await getBrand(email);
  const prefs = await listPreferences(email);
  const memory = await memoryBlock(email);
  const files = (await listFiles(email)).map((f) => f.name);
  const connected = (await listConnections(email)).map((c) => c.provider);
  const past = (await history(email, conv)).slice(-16);
  const messages: Anthropic.MessageParam[] = past.map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[messages.length - 1].role !== "user") messages.push({ role: "user", content: text });

  const sys = system(brand, user, prefs, memory, files, connected);

  for (let turn = 0; turn < 5; turn++) {
    const res = await client.messages
      .stream({ model: "claude-opus-5", max_tokens: 8000, system: sys, messages, tools: TOOLS, thinking: { type: "adaptive" }, output_config: { effort: "medium" } })
      .finalMessage();
    if (res.stop_reason === "refusal") break;
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!uses.length) {
      const reply = res.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("\n").trim();
      const m: ChatMsg = { role: "assistant", content: reply || "…", at: new Date().toISOString(), actions };
      await push(email, m, conv);
      return m;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      let out = "";
      let isError = false;
      try {
        out = await runTool(user, u.name, u.input as Record<string, unknown>, actions);
      } catch (e) {
        isError = true;
        out = e instanceof Error ? e.message : "tool_failed";
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: out, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
  const m: ChatMsg = { role: "assistant", content: "تم. تحقق من صندوق الموافقة.", at: new Date().toISOString(), actions };
  await push(email, m, conv);
  return m;
}

async function runTool(user: User, name: string, input: Record<string, unknown>, actions: string[]): Promise<string> {
  const email = user.scope ?? user.email;
  switch (name) {
    case "generate_content": {
      const type = input.type as TaskType;
      const cost = TASK_COST[type];
      const brand = await getBrand(email);
      if (!brand) return "No brand file yet. Ask the owner to run onboarding.";
      if (user.plan === "trial" && new Date(user.trialEnds) < new Date()) return "Trial ended. Owner must subscribe.";
      if (user.credits < cost) return `Insufficient credits: need ${cost}, have ${user.credits}.`;
      const gov = await getGov(email);
      const items = await generate(type, brand, await listPreferences(email), String(input.notes ?? ""), { memory: await memoryBlock(email), reviewer: gov.reviewer, noEmDash: gov.noEmDash });
      for (const it of items) {
        const t: Task = { id: randomBytes(8).toString("hex"), type, channel: it.channel, title: it.title, body: it.body, status: gov.autoApprove[type] ? "approved" : "pending", createdAt: new Date().toISOString(), lang: brand.languages[0] ?? "ar" };
        await saveTask(email, t, true);
      }
      user.credits -= cost;
      await saveUser(user);
      actions.push(`generated:${type}:${items.length}`);
      return `Created ${items.length} ${type} item(s) in the inbox${gov.autoApprove[type] ? " (auto-approved per governance)" : ""}. Credits left: ${user.credits}. Titles: ${items.map((i) => i.title).join(" | ")}`;
    }
    case "update_brand": {
      const brand = await getBrand(email);
      if (!brand) return "No brand file yet.";
      const field = String(input.field) as keyof Brand;
      const value = String(input.value).slice(0, 1000);
      if (field === "dialect") (brand as Brand).dialect = (["msa", "saudi", "emirati", "kuwaiti", "english"].includes(value) ? value : brand.dialect) as Brand["dialect"];
      else (brand as unknown as Record<string, string>)[field] = value;
      brand.updatedAt = new Date().toISOString();
      await saveBrand(email, brand);
      actions.push(`brand:${field}`);
      return `Updated brand.${field}.`;
    }
    case "read_file": {
      const f = await readFile(email, String(input.name));
      return f ? f.content.slice(0, 12000) : "File not found.";
    }
    case "write_file": {
      const f = await writeFile(email, String(input.name), String(input.content), "noor");
      actions.push(`file:${f.name}`);
      return `Saved ${f.name} (${f.content.length} chars).`;
    }
    case "publish_item": {
      const t = await getTask(email, String(input.task_id));
      if (!t) return "Item not found.";
      const connected = (await listConnections(email)).map((c) => c.provider);
      const provider = String(input.provider);
      if (!targetsFor(t, connected).includes(provider)) return `Cannot publish this ${t.type}/${t.channel} item to ${provider} (not connected or wrong type).`;
      const r = await publishTask(email, t, provider);
      t.published = [...(t.published ?? []), { provider: r.provider, url: r.url, status: r.status, at: new Date().toISOString() }];
      t.status = "approved";
      await saveTask(email, t);
      actions.push(`published:${provider}`);
      return `Published to ${provider} as ${r.status}: ${r.url}`;
    }
    case "list_inbox": {
      const tasks = await listTasks(email);
      const c = (s: string) => tasks.filter((t) => t.status === s).length;
      return `Inbox: ${c("pending")} pending, ${c("approved")} approved, ${c("rejected")} rejected. Latest: ${tasks.slice(0, 8).map((t) => `[id=${t.id}] ${t.type}/${t.channel}: ${t.title} [${t.status}]${t.imageUrl ? " (has image)" : ""}`).join("; ")}`;
    }
    case "import_catalog": {
      const brand = await getBrand(email);
      const site = String(input.url ?? "") || brand?.website;
      if (!site) return "No store URL known. Ask the owner for it.";
      const r = await importCatalog(email, site);
      actions.push(`catalog:${r.count}`);
      return r.count ? `Imported ${r.count} products into products.md. Examples: ${r.products.slice(0, 5).map((p) => `${p.title}${p.price ? " (" + p.price + ")" : ""}`).join("; ")}` : "Could not find product pages (no sitemap or unusual URLs). Ask the owner for 3-5 product links or a product list.";
    }
    case "generate_image": {
      const brand = await getBrand(email);
      const t = await getTask(email, String(input.task_id));
      if (!brand || !t) return "Item not found.";
      if (user.credits < IMAGE_COST) return "Insufficient credits for an image.";
      const img = await generateImage(brand, t);
      t.imageUrl = img.url;
      t.imagePrompt = img.prompt;
      await saveTask(email, t);
      user.credits -= IMAGE_COST;
      await saveUser(user);
      actions.push(`image:${t.id}`);
      return `Image generated for "${t.title}" (${img.provider}). It's attached to the item in the inbox. Credits left: ${user.credits}.`;
    }
    default:
      return "Unknown tool.";
  }
}
