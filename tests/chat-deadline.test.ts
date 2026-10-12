import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageOutcome } from "@/lib/media/start";

/**
 * The chat tool generate_image (review findings). It used to start every render with `Date.now() + 100 s` whatever the
 * chat request had already used, so a render asked for late in a five-turn reply was budgeted past the platform's kill;
 * and every failure without a named case told the owner "the credit was returned", even when no refund had happened.
 */
const h = vi.hoisted(() => ({
  result: null as unknown,
  turns: [] as ((args: { messages: { role: string; content: unknown }[] }) => unknown)[],
  seen: [] as { messages: { role: string; content: unknown }[] }[],
}));
vi.mock("@/lib/media/start", async (orig) => ({
  ...(await orig<typeof import("@/lib/media/start")>()),
  renderImage: vi.fn(async () => h.result),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      stream: (args: { messages: { role: string; content: unknown }[] }) => ({
        finalMessage: async () => {
          h.seen.push(structuredClone(args));
          const next = h.turns.shift();
          if (!next) throw new Error("no scripted model turn left");
          return next(args);
        },
      }),
    };
  },
}));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));

import { saveBrand, saveTask, type Brand, type Task } from "@/lib/brand";
import { CHAT_MAX_DURATION_S, CHAT_RENDER_MIN_MS, chat, runTool } from "@/lib/chat";
import { renderImage } from "@/lib/media/start";
import { deadlineFor } from "@/lib/media/keys";
import { currentUser, type User } from "@/lib/auth";
import { newUser, signIn } from "./helpers/session";
import * as chatRoute from "@/app/api/chat/route";
import * as mcpRoute from "@/app/api/mcp/route";

const brand: Brand = { name: "Rose Coffee", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "coffee", audience: "Riyadh", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "Riyadh", updatedAt: new Date().toISOString() };
async function ownerWithTask(): Promise<{ u: User; t: Task }> {
  const u = await newUser("cd");
  await saveBrand(u.email, brand);
  const t: Task = { id: `cd${Date.now()}`, type: "social", channel: "instagram", title: "Weekend offer", body: "Two for one.", status: "pending", createdAt: new Date().toISOString(), lang: "ar" };
  await saveTask(u.email, t, true);
  // The owner signed in: the user a request resolves to carries its actor (`currentUser`), which says who asked.
  await signIn(u.email);
  return { u: (await currentUser())!, t };
}
const usage = { input_tokens: 1, output_tokens: 1 };

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  vi.mocked(renderImage).mockClear();
  h.turns = [];
  h.seen = [];
  h.result = { ok: false, status: 502, error: "media_failed" };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("generate_image works to the chat request's own deadline", () => {
  it("the render gets the deadline the turn was given", async () => {
    const { u, t } = await ownerWithTask();
    const deadline = Date.now() + 200_000;
    await runTool(u, "generate_image", { task_id: t.id }, [], [], deadline);
    expect(vi.mocked(renderImage)).toHaveBeenCalledTimes(1);
    // With who asked and from where, for the render's activity rows (rule 232).
    expect(vi.mocked(renderImage).mock.calls[0][4]).toEqual({ deadline, by: { kind: "owner", email: u.email }, from: "chat" });
  });

  it("with less than a minute left nothing is started or charged", async () => {
    const { u, t } = await ownerWithTask();
    const out = await runTool(u, "generate_image", { task_id: t.id }, [], [], Date.now() + CHAT_RENDER_MIN_MS - 1_000);
    expect(out).toMatch(/^Not started: .*No credit was used\./);
    expect(vi.mocked(renderImage)).not.toHaveBeenCalled();
  });

  it("chat() counts from its own start: a render asked for 250 s into a reply is not started", async () => {
    const { u, t } = await ownerWithTask();
    const t0 = Date.now();
    const realNow = Date.now.bind(Date);
    h.turns = [
      () => {
        // The first model turn took 250 s (up to five Opus turns share the route's 300 s).
        vi.spyOn(Date, "now").mockImplementation(() => realNow() + 250_000);
        return { model: "claude-opus-5-5", stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "tu1", name: "generate_image", input: { task_id: t.id } }] };
      },
      () => ({ model: "claude-opus-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text: "Done." }] }),
    ];
    await chat(u, "draw it", undefined, "noor", { lang: "en" });
    expect(vi.mocked(renderImage)).not.toHaveBeenCalled();
    const results = h.seen[1].messages.at(-1)!.content as { type: string; content: string }[];
    expect(results[0].content).toMatch(/^Not started/);
    // And a turn given the route's deadline passes it through unchanged.
    vi.mocked(Date.now).mockRestore();
    h.result = { ok: false, status: 429, error: "busy" };
    h.turns = [
      () => ({ model: "claude-opus-5-5", stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "tu2", name: "generate_image", input: { task_id: t.id } }] }),
      () => ({ model: "claude-opus-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text: "Done." }] }),
    ];
    const deadline = deadlineFor(CHAT_MAX_DURATION_S, t0);
    await chat(u, "draw it", undefined, "noor", { lang: "en", deadline });
    expect(vi.mocked(renderImage).mock.calls[0][4]).toEqual({ deadline, by: { kind: "owner", email: u.email }, from: "chat" });
  });

  it("the ceiling chat() assumes is the one both routes that call it declare", () => {
    expect([chatRoute.maxDuration, mcpRoute.maxDuration]).toEqual([CHAT_MAX_DURATION_S, CHAT_MAX_DURATION_S]);
  });
});

describe("generate_image says the credit came back only when it did", () => {
  const reply = async (result: ImageOutcome) => {
    h.result = result;
    const { u, t } = await ownerWithTask();
    return runTool(u, "generate_image", { task_id: t.id }, []);
  };

  it("a failure without a refund (the refund failed and the job will return it) claims none", async () => {
    const out = await reply({ ok: false, status: 502, error: "media_failed" });
    expect(out).not.toMatch(/credit was returned/);
    expect(out).toMatch(/returned on its own within a few minutes/);
  });

  it("a failure with the refund made says so, with the balance the ledger reported", async () => {
    expect(await reply({ ok: false, status: 502, error: "media_failed", credits: 50 })).toBe("The image could not be generated; the credit was returned.");
    expect(await reply({ ok: false, status: 422, error: "nsfw", credits: 50 })).toMatch(/content rules; the credit was returned\.$/);
    expect(await reply({ ok: false, status: 422, error: "nsfw" })).not.toMatch(/returned/);
  });

  it("no image model and artwork on the item: the image stays and nothing was charged, so nothing is said to come back", async () => {
    const out = await reply({ ok: false, status: 409, error: "model_unavailable" });
    expect(out).toMatch(/keeps its current image\. No credit was used/);
    expect(out).not.toMatch(/returned|could not be generated/);
  });

  it("the placeholder reply says the service is unavailable now, not that it is not configured (the breaker may have it off)", async () => {
    const { u, t } = await ownerWithTask();
    h.result = { ok: true, placeholder: true, task: t, credits: u.credits };
    const out = await runTool(u, "generate_image", { task_id: t.id }, []);
    expect(out).toMatch(/not available right now/);
    expect(out).not.toMatch(/not configured/);
  });
});
