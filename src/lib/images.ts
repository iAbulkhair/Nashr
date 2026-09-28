import { meter } from "./usage";
import Anthropic from "@anthropic-ai/sdk";
import { modelState } from "./model";
import type { Brand, Task } from "./brand";

/**
 * Image generation for posts. Provider: fal.ai FLUX (FAL_KEY). Without a key,
 * returns a branded placeholder so the flow still works in dev.
 */
export type ImageResult = { url: string; prompt: string; provider: "fal" | "placeholder" };

async function imagePrompt(brand: Brand, task: Task, email?: string): Promise<string> {
  const fallback = `Premium ${brand.industry} product photo for ${brand.name}, Gulf aesthetic, warm light, clean background, no text, 1:1`;
  // Paused or no key: the fixed prompt. The picture itself comes from fal.ai, which the pause does not touch.
  if (modelState() !== "on") return fallback;
  const client = new Anthropic();
  const res = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 400,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: "You write one image-generation prompt (English, ≤ 60 words) for a social post. Photographic, specific subject, lighting, composition, Gulf/Saudi cultural fit (modest, no faces unless generic, no text or logos in image, no alcohol). Output the prompt only.",
    messages: [{ role: "user", content: `Brand: ${brand.name} (${brand.industry}). Tone: ${brand.tone}. Products: ${brand.products.slice(0, 300)}.\nChannel: ${task.channel}\nPost:\n${(task.editedBody ?? task.body).slice(0, 1200)}` }],
  });
  await meter(email, res.model, "image_prompt", res.usage);
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(" ").trim();
  return text || fallback;
}

export async function generateImage(brand: Brand, task: Task, email?: string): Promise<ImageResult> {
  const prompt = await imagePrompt(brand, task, email);
  const key = process.env.FAL_KEY;
  if (!key) {
    return { url: `https://placehold.co/1024x1024/0f3d3a/f2b33d.png?text=${encodeURIComponent(brand.name.slice(0, 24))}`, prompt, provider: "placeholder" };
  }
  // The route charges the credit BEFORE this call and its ceiling is 120s. A provider that accepts the connection and
  // then stalls would run past that ceiling, the platform would terminate the invocation, and the route catch — with
  // its refund — would never run. Fail here first, with room to spare.
  const res = await fetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, image_size: task.channel === "tiktok" || task.channel === "snapchat" ? "portrait_16_9" : "square_hd", num_images: 1, enable_safety_checker: true }),
  });
  if (!res.ok) throw new Error(`fal ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { images?: { url: string }[] };
  const url = j.images?.[0]?.url;
  if (!url) throw new Error("fal: no image");
  return { url, prompt, provider: "fal" };
}
