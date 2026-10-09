import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Rules 809 and 900 (2026-10-09, founder: "use the last 3 models right now only"). The product calls only the three
 * current models: Opus 5.5 writes (generation, onboarding), Sonnet 5.5 checks and talks (reviewer, cross-agent review,
 * judge, chat), Haiku 5.5 does the short jobs (the image/video prompt writer, the free tools). Haiku 5.5 has no
 * server-side refusal fallback, so a declined free-tool request comes back with no text: the route says it failed
 * instead of showing an empty result, and the use is not counted.
 */
type Reply = { model: string; stop_reason: string; usage: { input_tokens: number; output_tokens: number }; content: { type: string; text?: string }[] };
const sdk = vi.hoisted(() => ({ sent: [] as { model: string }[], reply: null as Reply | null }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    static BadRequestError = class extends Error {};
    messages = { create: async (p: { model: string }) => { sdk.sent.push(p); return sdk.reply; } };
  },
}));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));

import { ESTIMATE_MODELS } from "@/lib/task-costs";
import { CHAT_MODEL } from "@/lib/chat";
import { hasRate } from "@/lib/usage";
import { db } from "@/lib/db";
import { TOOLS } from "@/lib/tools";
import * as toolRoute from "@/app/api/tools/[tool]/route";
import { json, settle } from "./helpers/session";

const CURRENT = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
const src = (p: string) => readFileSync(p, "utf8");

beforeEach(() => { sdk.sent = []; sdk.reply = null; vi.stubEnv("ANTHROPIC_API_KEY", "test"); });
afterEach(async () => { await settle(); vi.unstubAllEnvs(); });

describe("only the three current models are called (rule 809)", () => {
  it("every model id a call names in src is Opus 5.5, Sonnet 5.5 or Haiku 5.5", () => {
    const named = walk("src").flatMap((f) => [...src(f).matchAll(/(?:model:\s*|_MODEL\s*=\s*)"(claude-[a-z0-9-]+)"/g)].map((m) => `${f}: ${m[1]}`));
    expect(named.length).toBeGreaterThanOrEqual(6);
    expect(named.filter((n) => !CURRENT.some((id) => n.endsWith(`: ${id}`)))).toEqual([]);
  });

  it("each job has its model: Opus 5.5 writes, Sonnet 5.5 checks and talks, Haiku 5.5 does the short jobs", () => {
    expect(ESTIMATE_MODELS).toEqual({ generate: "claude-opus-5-5", review: "claude-sonnet-5-5", judge: "claude-sonnet-5-5", onboard: "claude-opus-5-5", mediaPrompt: "claude-haiku-5-5" });
    expect(CHAT_MODEL).toBe("claude-sonnet-5-5");
    expect(src("src/app/api/tools/[tool]/route.ts")).toContain('model: "claude-haiku-5-5"');
  });

  it("all three have their own rate, so costUsd never prices one as Opus 5 by default", () => {
    for (const id of CURRENT) expect(hasRate(id), id).toBe(true);
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
