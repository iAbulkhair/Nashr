/**
 * The prompt a render is made from. With Claude on, Sonnet writes it from the post; while paused, out of time or on any
 * failure, a fixed template built from the brand alone (spec 4.5, A12). The pause stops Claude, never the renderer, and
 * the credit buys the render, not the prompt.
 */
import { meter } from "../usage";
import { anthropic, modelState } from "../model";
import { agentForTask } from "../agents";
import { mediaModel, type Aspect, type ImageModelId, type VideoModelId } from "../media-catalog";
import type { Brand, Task } from "../brand";

export type PromptStyle = "photo" | "lifestyle" | "text" | "design";
export const IMAGE_STYLE: Record<ImageModelId, PromptStyle> = {
  "img-fast": "photo", "img-balanced": "photo", "img-premium": "photo", "img-text": "text", "img-lifestyle": "lifestyle", "img-design": "design",
};
/** Spec A12: one attempt of at most 20 s. The SDK's default maxRetries (2) would stretch that to about a minute. */
export const PROMPT_MAX_MS = 20_000;
/** Less time than this left: not worth a model call, the template goes out at once. */
const PROMPT_MIN_MS = 3_000;

const ratio = (aspect: Aspect) => (aspect === "portrait" ? "9:16" : "1:1");
const secondsOf = (model: VideoModelId) => mediaModel(model).seconds ?? 5;

const designTemplate = (b: Brand, aspect: Aspect) => `Minimal flat graphic for ${b.name} (${b.industry}), bold shapes, Gulf palette, no text or lettering, ${ratio(aspect)}`;
/**
 * Spec A27: the only words a paused text image may carry are the brand name, and only when it is plain Latin text. The
 * task is never read here: while paused every Arabic title would have been drawn as (broken) Arabic lettering.
 */
function textTemplate(b: Brand, aspect: Aspect): string {
  const name = b.name.trim();
  const headline = name.replace(/"/g, "").slice(0, 40).trim();
  if (!/^[\x20-\x7E]+$/.test(name) || !headline) return designTemplate(b, aspect);
  return `Clean ${b.industry} promotional poster for ${b.name} with the short English headline "${headline}", Gulf aesthetic, warm light, ${ratio(aspect)}`;
}

/** Built from the brand alone. `task` is part of the signature only: no template reads the post. */
export function fixedImagePrompt(brand: Brand, task: Task, model: ImageModelId, aspect: Aspect): string {
  switch (IMAGE_STYLE[model]) {
    case "lifestyle":
      return `Natural lifestyle photo for ${brand.name}, a ${brand.industry} business: its product or service in use in a modern Gulf setting, modest styling, no close-up faces, no text, ${ratio(aspect)}`;
    case "text":
      return textTemplate(brand, aspect);
    case "design":
      return designTemplate(brand, aspect);
    default:
      // The text used before the catalogue, with the aspect fixed. tests/model-pause.test.ts matches its start.
      return `Premium ${brand.industry} product photo for ${brand.name}, Gulf aesthetic, warm light, clean background, no text, ${ratio(aspect)}`;
  }
}

/** No provider documents the language of generated speech, so no video asks for any (spec 3.2). */
export function fixedVideoPrompt(brand: Brand, task: Task, model: VideoModelId, fromImage: boolean): string {
  if (fromImage) return "Animate this photo: slow camera push-in, gentle light movement, warm Gulf light, modest styling, no text on screen, no speech, no dialogue, no voice-over";
  return `${secondsOf(model)}-second vertical social video for ${brand.name}: a scene that represents a ${brand.industry} business, slow camera push-in, warm Gulf light, modest styling, no text on screen, no close-up faces, no speech, no dialogue, no voice-over`;
}

const IMAGE_SYSTEM: Record<PromptStyle, string> = {
  // The system prompt used before the catalogue, verbatim.
  photo: "You write one image-generation prompt (English, ≤ 60 words) for a social post. Photographic, specific subject, lighting, composition, Gulf/Saudi cultural fit (modest, no faces unless generic, no text or logos in image, no alcohol). Output the prompt only.",
  lifestyle: "You write one image-generation prompt (English, ≤ 60 words) for a social post. A natural lifestyle photo: the product or service in use in a modern Gulf setting. Specific subject, lighting, composition, Gulf/Saudi cultural fit (modest, no faces unless generic, no text or logos in image, no alcohol). Output the prompt only.",
  text: "You write one image-generation prompt (English, ≤ 60 words) for a social post. A clean promotional image: specific subject, lighting, composition, Gulf/Saudi cultural fit (modest, no faces unless generic, one short headline in English, at most 6 words, taken from the post; no Arabic lettering; no logos; no alcohol). Output the prompt only.",
  design: "You write one image-generation prompt (English, ≤ 60 words) for a social post. Flat graphic design: bold shapes, a Gulf palette, clear composition, Gulf/Saudi cultural fit (modest, no faces, no text or lettering, no logos, no alcohol). Output the prompt only.",
};
/** A photo-to-video clip keeps the photo's shape (vid-motion takes a square one too), so only text-to-video says vertical. */
const videoSystem = (seconds: number, fromImage: boolean) =>
  `You write one text-to-video prompt (English, ≤ 70 words) for a ${seconds}-second ${fromImage ? "" : "vertical "}clip for a social post: one continuous shot, camera movement, subject, light${fromImage ? "; describe only motion for the given photo" : ""}; no speech, no dialogue, no voice-over. Gulf/Saudi cultural fit (modest, no faces unless generic, no text or logos on screen, no alcohol). Output the prompt only.`;

const postOf = (b: Brand, t: Task) =>
  `Brand: ${b.name} (${b.industry}). Tone: ${b.tone}. Products: ${b.products.slice(0, 300)}.\nChannel: ${t.channel}\nPost:\n${(t.editedBody ?? t.body).slice(0, 1200)}`;

/** One Sonnet attempt inside the time left; anything short of a prompt gives the template (spec A12). */
async function write(system: string, brand: Brand, task: Task, fallback: string, email: string | undefined, timeoutMs: number): Promise<string> {
  // `!(>=)` also sends a NaN budget to the template.
  if (modelState() !== "on" || !(timeoutMs >= PROMPT_MIN_MS)) return fallback;
  try {
    const res = await anthropic({ timeoutMs: PROMPT_MAX_MS, maxRetries: 0 }).messages.create(
      { model: "claude-haiku-5-5", max_tokens: 400, thinking: { type: "adaptive" }, output_config: { effort: "low" }, system, messages: [{ role: "user", content: postOf(brand, task) }] },
      { timeout: Math.min(PROMPT_MAX_MS, timeoutMs), maxRetries: 0 },
    );
    // Spec A18: video prompts are metered as image_prompt too. The render is for the agent who owns the item, the same
    // agent its credit is charged to.
    await meter(email, res.model, "image_prompt", res.usage, agentForTask(task.type).id);
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
    if (text) return text;
    console.error("media prompt failed", "empty");
  } catch (e) {
    console.error("media prompt failed", e instanceof Error ? e.message : "unknown");
  }
  return fallback;
}

export async function imagePrompt(brand: Brand, task: Task, model: ImageModelId, aspect: Aspect, email?: string, timeoutMs = PROMPT_MAX_MS): Promise<string> {
  return write(IMAGE_SYSTEM[IMAGE_STYLE[model]], brand, task, fixedImagePrompt(brand, task, model, aspect), email, timeoutMs);
}

export async function videoPrompt(brand: Brand, task: Task, model: VideoModelId, fromImage: boolean, email?: string, timeoutMs = PROMPT_MAX_MS): Promise<string> {
  return write(videoSystem(secondsOf(model), fromImage), brand, task, fixedVideoPrompt(brand, task, model, fromImage), email, timeoutMs);
}
