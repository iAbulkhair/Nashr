import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Rules 809 and 900 (2026-10-09, founder: "use the last 3 models right now only"). The product calls only the three
 * current models: Opus 5.5 writes (generation, onboarding), Sonnet 5.5 checks and talks (reviewer, cross-agent review,
 * judge, chat), Haiku 5.5 does the short jobs (the image/video prompt writer, the free tools). Haiku 5.5 has no
 * server-side refusal fallback, so a declined free-tool request comes back with no text: the route says it failed
 * instead of showing an empty result, and the use is not counted.
 *
 * Rule 901 (the same day): each task type has its own writer and reviewer (TASK_MODELS in src/lib/task-models.ts). Opus
 * 5.5 writes what the owner decides from, what touches money, and the posts and ads; Sonnet 5.5 writes the rest. The
 * reviewer is Sonnet 5.5 for every type.
 */
type Reply = { model: string; stop_reason: string; usage: { input_tokens: number; output_tokens: number }; content: { type: string; text?: string }[] };
const sdk = vi.hoisted(() => ({ sent: [] as { model: string }[], streamed: [] as { model: string }[], reply: null as Reply | null }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    static BadRequestError = class extends Error {};
    messages = { create: async (p: { model: string }) => { sdk.sent.push(p); return sdk.reply; } };
    beta = { messages: { stream: (p: { model: string }) => { sdk.streamed.push(p); return { finalMessage: async () => sdk.reply }; } } };
  },
}));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));

import { ESTIMATE_MODELS } from "@/lib/task-costs";
import { TASK_MODELS } from "@/lib/task-models";
import { TASK_TYPES, type TaskType } from "@/lib/tasks";
import { generate } from "@/lib/noor";
import type { Brand } from "@/lib/brand";
import { CHAT_MODEL } from "@/lib/chat";
import { hasRate } from "@/lib/usage";
import { db } from "@/lib/db";
import { TOOLS } from "@/lib/tools";
import * as toolRoute from "@/app/api/tools/[tool]/route";
import { json, settle } from "./helpers/session";

const CURRENT = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
const src = (p: string) => readFileSync(p, "utf8");

beforeEach(() => { sdk.sent = []; sdk.streamed = []; sdk.reply = null; vi.stubEnv("ANTHROPIC_API_KEY", "test"); });
afterEach(async () => { await settle(); vi.unstubAllEnvs(); });

describe("only the three current models are called (rule 809)", () => {
  it("every model id a call names in src is Opus 5.5, Sonnet 5.5 or Haiku 5.5", () => {
    const named = walk("src").flatMap((f) => [...src(f).matchAll(/(?:model:\s*|_MODEL\s*=\s*)"(claude-[a-z0-9-]+)"/g)].map((m) => `${f}: ${m[1]}`));
    expect(named.length).toBeGreaterThanOrEqual(4);
    expect(named.filter((n) => !CURRENT.some((id) => n.endsWith(`: ${id}`)))).toEqual([]);
    // The per-type writers and reviewers are named once, in task-models.ts.
    const constants = [...src("src/lib/task-models.ts").matchAll(/export const [A-Z]+ = "(claude-[a-z0-9-]+)";/g)].map((m) => m[1]);
    expect(constants).toEqual([...CURRENT]);
    for (const [type, m] of Object.entries(TASK_MODELS)) for (const id of [m.write, m.review]) expect(CURRENT, type).toContain(id);
  });

  it("each job has its model: Sonnet 5.5 checks and talks, Haiku 5.5 does the short jobs, Opus 5.5 onboards", () => {
    expect(ESTIMATE_MODELS).toEqual({ judge: "claude-sonnet-5-5", onboard: "claude-opus-5-5", mediaPrompt: "claude-haiku-5-5", meetingExtract: "claude-sonnet-5-5" });
    expect(CHAT_MODEL).toBe("claude-sonnet-5-5");
    expect(src("src/app/api/tools/[tool]/route.ts")).toContain('model: "claude-haiku-5-5"');
  });

  it("all three have their own rate, so costUsd never prices one as Opus 5 by default", () => {
    for (const id of CURRENT) expect(hasRate(id), id).toBe(true);
  });
});

describe("each task type has its own writer and reviewer (rule 901)", () => {
  const OPUS_TYPES: TaskType[] = ["social", "ads", "pricing_review", "unit_economics", "cash_forecast", "gtm_plan", "board_deck", "strategy_review", "okrs", "decision_memo"];

  it("Opus 5.5 writes decisions, money, the investor deck and the posts and ads; Sonnet 5.5 writes the rest and reviews all", () => {
    expect(Object.keys(TASK_MODELS).sort()).toEqual([...TASK_TYPES].sort());
    for (const t of TASK_TYPES) {
      expect(TASK_MODELS[t].write, t).toBe(OPUS_TYPES.includes(t) ? "claude-opus-5-5" : "claude-sonnet-5-5");
      expect(TASK_MODELS[t].review, t).toBe("claude-sonnet-5-5");
    }
  });

  const brand: Brand = { name: "متجر العود", website: "", industry: "متجر إلكتروني", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "عود وبخور", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
  it.each(["article", "social"] as TaskType[])("generate(%s) is written and reviewed by its own models", async (type) => {
    const items = JSON.stringify([{ channel: "instagram", title: "t", body: "b" }]);
    sdk.reply = { model: TASK_MODELS[type].write, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: items }] };
    await generate(type, brand, [], undefined, { count: 1, crossReview: false, deadline: Date.now() + 120_000 });
    expect(sdk.streamed.map((p) => p.model)).toEqual([TASK_MODELS[type].write]);
    expect(sdk.sent.map((p) => p.model)).toEqual([TASK_MODELS[type].review]);
  });
});

describe("a free tool with no text says it failed (rule 900)", () => {
  const TOOL = TOOLS[0].slug;
  const call = () => toolRoute.POST(json("/api/tools/x", "POST", { lang: "ar" }), { params: Promise.resolve({ tool: TOOL }) });
  const usage = async () => Number((await db.get(`toolusage:${TOOL}`)) ?? 0);

  it("a refusal (no text) is a 502 and is not counted as a use", async () => {
    sdk.reply = { model: "claude-haiku-5-5", stop_reason: "refusal", usage: { input_tokens: 10, output_tokens: 0 }, content: [] };
    const before = await usage();
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "failed" });
    expect(await usage()).toBe(before);
    expect(sdk.sent.map((p) => p.model)).toEqual(["claude-haiku-5-5"]);
  });

  it("text comes back as before, and the use is counted", async () => {
    sdk.reply = { model: "claude-haiku-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "  نص الأداة  " }] };
    const before = await usage();
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, output: "نص الأداة" });
    expect(await usage()).toBe(before + 1);
  });
});
