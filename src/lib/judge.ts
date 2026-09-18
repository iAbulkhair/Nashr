import Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import { getTask, saveTask, type Brand, type Task, type TaskType } from "./brand";
import { taskSpec } from "./noor";
import { agentForTask } from "./agents";
import { meter } from "./usage";
import { notifyItem } from "./notifications";

/**
 * Automated quality judge. A cheaper model scores every generated item against
 * the task spec and the brand file, right after generation, without blocking
 * the response (Next `after`). Scores live on the task (`quality`) and feed the
 * evals dashboards. Never rewrites content; that is the reviewer's job.
 */
export type Quality = {
  score: number; // 0-100 weighted
  dims: { completeness: number; brand: number; honesty: number; language: number; format: number };
  notes: string;
  model: string;
  at: string;
};

const WEIGHTS = { completeness: 0.3, brand: 0.2, honesty: 0.25, language: 0.15, format: 0.1 } as const;
const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export type JudgeItem = { channel: string; title: string; body: string };

/** Score items without touching storage. Used by judgeTasks and the golden set (src/lib/golden.ts). */
export async function scoreItems(email: string | undefined, brand: Brand, type: TaskType, items: JudgeItem[]): Promise<Quality[]> {
  if (!items.length || !process.env.ANTHROPIC_API_KEY) return [];
  const agent = agentForTask(type);
  const client = new Anthropic();
  const res = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: `You are the quality judge for Nashr, a Gulf AI agent team. You receive the TASK SPEC the agent (${agent.name.en}, ${agent.role.en}) was given, the BRAND FILE, and the ITEMS produced. Score EACH item independently, 0-100 per dimension:
- completeness: does it deliver everything the spec asks (parts, counts, sections, lengths)?
- brand: dialect and language policy, tone, banned/preferred words, offers and facts from the brand file, Gulf cultural fit and Saudi advertising norms.
- honesty: no invented prices, stats, certifications, testimonials or guarantees; unknown numbers written as placeholders like [رقم]; assumptions labeled.
- language: grammar, natural dialect, readability, no meta commentary, no filler.
- format: paste-ready, follows the structure the spec requires (tables, slide headers, character limits, CTA), valid Markdown.
Be strict but fair: 85+ means ready to use as is; 70-84 needs a light edit; below 70 should be regenerated.
Return ONLY a JSON array, same length and order as ITEMS: {"completeness":n,"brand":n,"honesty":n,"language":n,"format":n,"notes":"<= 25 words in the item's language: the single most important fix, or 'ready'"}.`,
    messages: [{
      role: "user",
      content: `TASK SPEC\n${taskSpec(type)}\n\nBRAND FILE\n${JSON.stringify({ name: brand.name, industry: brand.industry, city: brand.city, dialect: brand.dialect, languages: brand.languages, tone: brand.tone, products: brand.products.slice(0, 600), audience: brand.audience.slice(0, 400), offers: brand.offers, banned: brand.banned, preferred: brand.preferred })}\n\nITEMS\n${JSON.stringify(items.map((t) => ({ channel: t.channel, title: t.title, body: t.body.slice(0, 3500) })))}`,
    }],
  });
  await meter(email, res.model, "judge", res.usage);
  const raw = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const arr = JSON.parse(cleaned.slice(cleaned.indexOf("["), cleaned.lastIndexOf("]") + 1)) as Array<Record<string, unknown>>;
  return items.map((_, i) => {
    const v = arr[i] ?? {};
    const dims = { completeness: clamp(v.completeness), brand: clamp(v.brand), honesty: clamp(v.honesty), language: clamp(v.language), format: clamp(v.format) };
    const score = Math.round(Object.entries(WEIGHTS).reduce((s, [k, w]) => s + dims[k as keyof typeof dims] * w, 0));
    return { score, dims, notes: String(v.notes ?? "").slice(0, 200), model: res.model, at: new Date().toISOString() };
  });
}

export async function judgeTasks(scope: string, email: string, brand: Brand, tasks: Task[]): Promise<Quality[]> {
  if (!tasks.length) return [];
  const agent = agentForTask(tasks[0].type);
  const out = await scoreItems(email, brand, tasks[0].type, tasks);
  for (let i = 0; i < out.length; i++) {
    // Reload before saving: the owner may have approved or edited meanwhile.
    const fresh = (await getTask(scope, tasks[i].id)) ?? tasks[i];
    fresh.quality = out[i];
    await saveTask(scope, fresh);
  }
  const weak = out.filter((q) => q.score < 70).length;
  if (weak) {
    const lang = tasks[0].lang ?? "ar";
    await notifyItem(email, lang, { kind: "quality", agent: "dana", title: lang === "ar" ? `${weak} من ${tasks.length} عناصر ${agent.name.ar} بدرجة أقل من 70` : `${weak} of ${tasks.length} ${agent.name.en} item(s) scored below 70`, body: out.find((q) => q.score < 70)?.notes ?? "", href: "" }, `judge:${tasks[0].id}`, 7);
  }
  return out;
}

/** Fire-and-forget after the response is sent. Falls back to inline when no request scope. */
export function judgeLater(scope: string, email: string, brand: Brand, tasks: Task[]) {
  const run = () => judgeTasks(scope, email, brand, tasks).catch((e) => console.error("judge failed", e));
  try {
    after(run);
  } catch {
    void run();
  }
}
