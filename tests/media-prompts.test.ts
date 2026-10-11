import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeOn } from "./helpers/model";
import { noNetwork } from "./helpers/media";
import { db } from "@/lib/db";
import { monthKey } from "@/lib/credits";
import type { Brand, Task } from "@/lib/brand";
import type { ImageModelId, VideoModelId } from "@/lib/media-catalog";

/**
 * Every render starts from a prompt. While Claude is paused (src/lib/model.ts) it is a fixed template built from the
 * brand alone, and that template must never draw the post's Arabic title as lettering (spec A27) nor ask a video for
 * speech in a language no provider documents. With Claude on, one Sonnet call inside the time left, no SDK retries
 * (spec A12), and anything short of a prompt falls back to the template: the credit buys the render, not the prompt.
 */
type Create = (body: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>;
const sdk = { made: 0, calls: [] as { body: Record<string, unknown>; opts: Record<string, unknown> }[] };
const reply = (text: string) => async () => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text }] });

/** A fresh prompts module with Claude in `state` and a counting SDK whose `create` answers with `create`. */
async function load(state: "on" | "paused", create: Create = reply("A model-written prompt")) {
  vi.resetModules();
  if (state === "on") claudeOn();
  else vi.doMock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "paused" as const }));
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      constructor() { sdk.made++; }
      messages = { create: async (body: Record<string, unknown>, opts: Record<string, unknown>) => { sdk.calls.push({ body, opts }); return create(body, opts); }, stream(p: unknown, o?: unknown) { return { finalMessage: async () => (this.create as (...a: unknown[]) => unknown)(p, o) }; } };
    },
  }));
  return import("@/lib/media/prompts");
}

const brand = (over: Partial<Brand> = {}): Brand => ({ name: "محمصة", website: "", industry: "قهوة", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z", ...over });
const TITLE = "خصم نهاية الأسبوع على القهوة";
const task: Task = { id: "p1", type: "social", channel: "instagram", title: TITLE, body: "قهوة مختصة محمصة اليوم", status: "pending", createdAt: "2026-09-29T00:00:00.000Z", lang: "ar" };
const IMAGE: ImageModelId[] = ["img-fast", "img-balanced", "img-premium", "img-text", "img-lifestyle", "img-design"];
const VIDEO: VideoModelId[] = ["vid-quick", "vid-sound", "vid-premium", "vid-cinematic", "vid-motion"];
const NO_SPEECH = "no speech, no dialogue, no voice-over";

let net: ReturnType<typeof noNetwork>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { sdk.made = 0; sdk.calls = []; net = noNetwork(); errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => {
  net.restore();
  expect(net.hosts, "no network from a prompt test").toEqual([]);
  vi.doUnmock("@anthropic-ai/sdk"); vi.doUnmock("@/lib/model"); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe("while Claude is paused: the fixed templates", () => {
  it("each image style and each video model returns its template, and the SDK is never constructed", async () => {
    const p = await load("paused");
    for (const m of IMAGE) for (const a of ["square", "portrait"] as const) expect(await p.imagePrompt(brand(), task, m, a, "o@test.example"), `${m} ${a}`).toBe(p.fixedImagePrompt(brand(), task, m, a));
    for (const m of VIDEO) for (const f of [false, true]) expect(await p.videoPrompt(brand(), task, m, f, "o@test.example"), `${m} ${f}`).toBe(p.fixedVideoPrompt(brand(), task, m, f));
    expect(sdk.made).toBe(0);
  });

  it("the photo template keeps today's start and ends with the ratio of the aspect", async () => {
    const p = await load("paused");
    for (const m of ["img-fast", "img-balanced", "img-premium"] as const) {
      expect(p.IMAGE_STYLE[m]).toBe("photo");
      const sq = await p.imagePrompt(brand(), task, m, "square"), pt = await p.imagePrompt(brand(), task, m, "portrait");
      expect(sq).toMatch(/^Premium قهوة product photo/);
      expect([sq.endsWith("1:1"), pt.endsWith("9:16")]).toEqual([true, true]);
    }
    expect(sdk.made).toBe(0);
  });

  it("lifestyle and design have their own templates, and design asks for no lettering", async () => {
    const p = await load("paused");
    const photo = p.fixedImagePrompt(brand(), task, "img-fast", "square");
    const life = p.fixedImagePrompt(brand(), task, "img-lifestyle", "square");
    const design = p.fixedImagePrompt(brand(), task, "img-design", "portrait");
    expect(life).not.toBe(photo);
    expect(life).toMatch(/^Natural lifestyle photo for محمصة, a قهوة business: .*no close-up faces, no text, 1:1$/);
    expect(design).toBe("Minimal flat graphic for محمصة (قهوة), bold shapes, Gulf palette, no text or lettering, 9:16");
  });

  it("the text image quotes a Latin brand name only, never the task title (spec A27)", async () => {
    const p = await load("paused");
    const arabic = brand({ name: "قهوة الورد" });
    const out = await p.imagePrompt(arabic, task, "img-text", "square");
    expect(out, "an Arabic name gets the no-lettering design template").toBe(p.fixedImagePrompt(arabic, task, "img-design", "square"));
    expect(out).not.toMatch(/headline/);
    expect(out).not.toContain(TITLE);

    const latin = await p.imagePrompt(brand({ name: "Rose Coffee" }), task, "img-text", "portrait");
    expect(latin).toContain(`"Rose Coffee"`);
    expect(latin).toMatch(/English headline/);
    expect(latin).not.toContain(TITLE);
    expect(latin.endsWith("9:16")).toBe(true);

    const quoted = await p.imagePrompt(brand({ name: `  Say "Hi" ${"x".repeat(60)} ` }), task, "img-text", "square");
    const headline = quoted.match(/headline "([^"]*)"/)![1];
    expect(headline.length, "no quote inside the headline, at most 40 characters").toBeLessThanOrEqual(40);
    expect(headline.startsWith("Say Hi")).toBe(true);
    expect(sdk.made).toBe(0);
  });

  it("every video template forbids speech and is a scene of the business, not a product shot", async () => {
    const p = await load("paused");
    for (const m of VIDEO) {
      for (const f of [false, true]) {
        const v = await p.videoPrompt(brand(), task, m, f);
        expect(v, `${m} ${f}`).toContain(NO_SPEECH);
        expect(v).not.toContain("the product");
        expect(v).not.toContain(TITLE);
      }
    }
    expect(await p.videoPrompt(brand(), task, "vid-premium", false)).toMatch(/^10-second vertical social video for محمصة: a scene that represents a قهوة business/);
    expect(await p.videoPrompt(brand(), task, "vid-motion", true)).toMatch(/^Animate this photo: /);
    expect(sdk.made).toBe(0);
  });
});

describe("with Claude on", () => {
  it("one Haiku 5.5 call, 20 s and no retries, and the model's text is the prompt", async () => {
    // A still clock: the deadline is built and then read a moment later, so a slow runner could see 19999.
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const p = await load("on");
    expect(await p.imagePrompt(brand(), task, "img-fast", "square", "o@test.example")).toBe("A model-written prompt");
    expect(sdk.calls).toHaveLength(1);
    const { body, opts } = sdk.calls[0];
    // A stream's timeout covers only the wait for its headers, so the signal (rule 980) bounds the whole reply.
    expect(opts).toEqual({ timeout: 20000, maxRetries: 0, signal: expect.any(AbortSignal) });
    expect([body.model, body.max_tokens]).toEqual(["claude-haiku-5-5", 400]);
    expect(JSON.stringify(body.messages), "the post itself goes to the model").toContain("قهوة مختصة محمصة اليوم");
  });

  it("rule 1206: the timeout equals the budget exactly, even when the clock ticks between reads", async () => {
    const p = await load("on");
    // 1 ms on every read: reading the clock twice for one deadline gave 19999 (CI run 38160469570).
    let t = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t++);
    await p.imagePrompt(brand(), task, "img-fast", "square");
    await p.imagePrompt(brand(), task, "img-design", "square", undefined, 5000);
    expect(sdk.calls.map((c) => c.opts.timeout)).toEqual([20000, 5000]);
  });

  it("the timeout is the time left when that is shorter", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const p = await load("on");
    await p.imagePrompt(brand(), task, "img-design", "square", undefined, 5000);
    await p.videoPrompt(brand(), task, "vid-quick", false, undefined, 60_000);
    expect(sdk.calls.map((c) => c.opts)).toEqual([{ timeout: 5000, maxRetries: 0, signal: expect.any(AbortSignal) }, { timeout: 20000, maxRetries: 0, signal: expect.any(AbortSignal) }]);
  });

  it("the text style asks for an English headline and the video style for no speech", async () => {
    const p = await load("on");
    await p.imagePrompt(brand(), task, "img-text", "square");
    await p.imagePrompt(brand(), task, "img-fast", "square");
    await p.videoPrompt(brand(), task, "vid-sound", false);
    await p.videoPrompt(brand(), task, "vid-motion", true);
    const [text, photo, video, motion] = sdk.calls.map((c) => String(c.body.system));
    expect(text).toMatch(/headline in English, at most 6 words/);
    expect(text).toMatch(/no Arabic lettering/);
    expect(photo, "today's system prompt, verbatim").toBe("You write one image-generation prompt (English, ≤ 60 words) for a social post. Photographic, specific subject, lighting, composition, Gulf/Saudi cultural fit (modest, no faces unless generic, no text or logos in image, no alcohol). Output the prompt only.");
    expect(video).toContain("English");
    expect(video).toContain(NO_SPEECH);
    expect(video).toMatch(/8-second vertical clip/);
    expect(motion).toMatch(/describe only motion for the given photo/);
    expect(motion).toContain(NO_SPEECH);
  });

  it("video prompts are metered as image_prompt (spec A18)", async () => {
    const p = await load("on");
    const email = `meter-${Date.now()}@test.example`;
    await p.videoPrompt(brand(), task, "vid-quick", false, email);
    expect(await db.get<number>(`usage:${email}:${monthKey()}:kind:image_prompt`)).toBe(1);
  });

  it("a timeout is tried once, logged without detail, and the template goes out", async () => {
    const p = await load("on", async () => { throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }); });
    expect(await p.imagePrompt(brand(), task, "img-lifestyle", "portrait")).toBe(p.fixedImagePrompt(brand(), task, "img-lifestyle", "portrait"));
    expect(sdk.calls).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith("media prompt failed", "Request timed out.");
  });

  it("an empty reply gives the template", async () => {
    const p = await load("on", reply("   "));
    expect(await p.videoPrompt(brand(), task, "vid-cinematic", false)).toBe(p.fixedVideoPrompt(brand(), task, "vid-cinematic", false));
    expect(sdk.calls).toHaveLength(1);
  });

  it("with under 3 s left, the template at once and no SDK at all", async () => {
    const p = await load("on");
    expect(await p.imagePrompt(brand(), task, "img-fast", "square", undefined, 2000)).toBe(p.fixedImagePrompt(brand(), task, "img-fast", "square"));
    expect(await p.videoPrompt(brand(), task, "vid-quick", false, undefined, 2000)).toBe(p.fixedVideoPrompt(brand(), task, "vid-quick", false));
    expect([sdk.made, sdk.calls.length]).toEqual([0, 0]);
  });
});
