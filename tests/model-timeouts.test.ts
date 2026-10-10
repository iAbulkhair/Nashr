import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Rules 335-336 (issue #28). Every model client was `new Anthropic()` with the SDK's defaults, a 10-minute timeout and two
 * retries, and no call passed an abort signal. A slow model ran past the route's maxDuration, the platform killed the
 * function, and a killed function runs no catch: the credits charged before the call were never refunded. Now one
 * factory makes every client with an explicit timeout and retry count, and every charged call ends by its caller's
 * deadline, a stream's body included.
 */
type Opts = { signal?: AbortSignal; timeout?: number } | undefined;
const sdk = vi.hoisted(() => ({ ctor: [] as unknown[], calls: [] as { kind: string; opts: Opts }[], mode: "hang" as "hang" | "ok" }));
vi.mock("@anthropic-ai/sdk", () => {
  const reply = (text: string) => ({ model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text }] });
  /** Never answers in "hang" mode: it only rejects when the call's abort signal fires, as the real SDK does. */
  const answer = (kind: string, opts: Opts, text: string) => {
    sdk.calls.push({ kind, opts });
    if (sdk.mode === "ok") return Promise.resolve(reply(text));
    return new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("Request was aborted."))));
  };
  const items = JSON.stringify([{ channel: "instagram", title: "t", body: "نص تجريبي للعنصر يكفي للمراجعة" }]);
  return {
    default: class {
      static BadRequestError = class extends Error {};
      constructor(o: unknown) { sdk.ctor.push(o); }
      beta = { messages: { stream: (_p: unknown, opts: Opts) => ({ finalMessage: () => answer("generate", opts, items) }) } };
      messages = {
        stream: (_p: unknown, opts: Opts) => ({ finalMessage: () => answer("stream", opts, "أهلاً") }),
        create: (_p: unknown, opts: Opts) => answer("create", opts, JSON.stringify([{ ok: true }])),
      };
    },
  };
});
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));

import { MODEL_BUDGET, anthropic, until } from "@/lib/model";
import { getUser, saveUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { history, chat, OUT_OF_TIME_REPLY, CHAT_MAX_DURATION_S } from "@/lib/chat";
import { generate } from "@/lib/noor";
import { generateBatch } from "@/lib/generate-batch";
import { buildFromSite } from "@/lib/onboard";
import { deadlineFor } from "@/lib/media/keys";
import { TASK_COST } from "@/lib/tasks";
import type { Brand } from "@/lib/brand";
import { json, newUser, settle, signIn } from "./helpers/session";
import * as generateRoute from "@/app/api/generate/route";
import * as toolRoute from "@/app/api/tools/[tool]/route";
import { TOOLS } from "@/lib/tools";

const TOOL = TOOLS[0].slug;

const brand: Brand = { name: "مقهى", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
const credits = async (email: string) => (await getUser(email))!.credits;

beforeEach(() => { sdk.ctor = []; sdk.calls = []; sdk.mode = "hang"; vi.stubEnv("ANTHROPIC_API_KEY", "test"); });
afterEach(async () => { vi.useRealTimers(); await settle(); vi.unstubAllEnvs(); });

describe("one factory makes every model client, with a timeout and a retry count (rule 335)", () => {
  it("anthropic() hands the SDK exactly the numbers it was given, and refuses nonsense", () => {
    anthropic({ timeoutMs: 1234.9, maxRetries: 1 });
    anthropic({ timeoutMs: 45_000, maxRetries: 0 });
    expect(sdk.ctor).toEqual([{ timeout: 1234, maxRetries: 1 }, { timeout: 45_000, maxRetries: 0 }]);
    for (const timeoutMs of [0, -1, NaN, Infinity]) expect(() => anthropic({ timeoutMs, maxRetries: 0 }), String(timeoutMs)).toThrow(/invalid_model_timeout/);
    for (const maxRetries of [-1, 1.5, 3, NaN]) expect(() => anthropic({ timeoutMs: 1000, maxRetries }), String(maxRetries)).toThrow(/invalid_model_retries/);
  });

  it("no file in src makes a client any other way", () => {
    const direct = walk("src").filter((f) => /new\s+Anthropic\s*\(/.test(readFileSync(f, "utf8").replace(/^\s*\*.*$/gm, "")));
    expect(direct).toEqual([join("src", "lib", "model.ts")]);
  });

  it("provider switch: STRAITLY_API_KEY is read in src/lib/model.ts and nowhere else", () => {
    // A read, not a mention: a message that names the variable is fine, `process.env.STRAITLY_API_KEY` is not.
    const reads = (code: string) => /\benv\s*(\.\s*STRAITLY_API_KEY\b|\[\s*["'`]STRAITLY_API_KEY["'`]\s*\])/.test(code) || /\{[^}]*\bSTRAITLY_API_KEY\b[^}]*\}\s*=\s*(?:globalThis\.)?process\.env\b/.test(code);
    // The scan itself must keep seeing what it exists to find.
    expect(reads("const k = process.env.STRAITLY_API_KEY;")).toBe(true);
    expect(reads('const k = process.env["STRAITLY_API_KEY"];')).toBe(true);
    expect(reads("const { STRAITLY_API_KEY: k } = process.env;")).toBe(true);
    expect(reads('const note = "STRAITLY_API_KEY is not set";')).toBe(false);
    const code = (f: string) => readFileSync(f, "utf8").replace(/^\s*(\*|\/\/).*$/gm, "");
    expect(reads(code(join("src", "lib", "model.ts"))), "model.ts is where it is read").toBe(true);
    expect(walk("src").filter((f) => f !== join("src", "lib", "model.ts") && reads(code(f)))).toEqual([]);
  });

  it("every budget sits inside its route's maxDuration", () => {
    expect(MODEL_BUDGET.GEN_MS).toBeLessThan(300_000);
    expect(MODEL_BUDGET.ONBOARD_MS).toBeLessThan(300_000);
    expect(MODEL_BUDGET.CHAT_MS).toBeLessThan(CHAT_MAX_DURATION_S * 1000);
    expect(MODEL_BUDGET.TOOL_MS).toBeLessThan(60_000);
    expect(MODEL_BUDGET.REVIEW_MS + MODEL_BUDGET.REVIEW_MIN_MS).toBeLessThan(MODEL_BUDGET.GEN_MS);
  });

  it("until(): aborts at the deadline on the clock the caller runs on; a past or broken deadline aborts at once", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const a = until(now + 10_000, { now });
    expect(a.timeout).toBe(10_000);
    vi.advanceTimersByTime(9_999);
    expect(a.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(a.signal.aborted).toBe(true);
    for (const d of [now - 5_000, NaN]) {
      const b = until(d, { now });
      expect(b.timeout).toBe(1);
      vi.advanceTimersByTime(1);
      expect(b.signal.aborted).toBe(true);
    }
  });

  it("until(): each attempt's timeout is the smaller of the time left and the caller's per-attempt cap", () => {
    vi.useFakeTimers();
    const now = Date.now();
    // The SDK's per-request timeout replaces the client's: without the cap one attempt could wait the whole time left.
    const far = until(now + 280_000, { cap: MODEL_BUDGET.CHAT_MS, now });
    expect(far.timeout).toBe(MODEL_BUDGET.CHAT_MS);
    vi.advanceTimersByTime(MODEL_BUDGET.CHAT_MS);
    expect(far.signal.aborted, "the signal still fires at the deadline, not at the cap").toBe(false);
    vi.advanceTimersByTime(280_000 - MODEL_BUDGET.CHAT_MS);
    expect(far.signal.aborted).toBe(true);
    expect(until(now + 5_000, { cap: MODEL_BUDGET.CHAT_MS, now }).timeout).toBe(5_000);
    for (const cap of [0, -1, NaN, Infinity]) expect(until(now + 5_000, { cap, now }).timeout, String(cap)).toBe(5_000);
  });
});

describe("every charged model call ends by its caller's deadline, so the refund runs (rule 336)", () => {
  it("generate(): the batch's calls carry the deadline; a model that never answers throws when it passes", async () => {
    const t0 = Date.now();
    await expect(generate("social", brand, [], "", { deadline: t0 + 150 })).rejects.toThrow("aborted");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(sdk.ctor).toEqual([{ timeout: MODEL_BUDGET.GEN_MS, maxRetries: 1 }]);
    expect(sdk.calls[0].kind).toBe("generate");
    expect(sdk.calls[0].opts!.timeout).toBeLessThanOrEqual(150);
  });

  it("without a caller's deadline, GEN_MS from now; the reviewer is skipped with too little left and bounded otherwise", async () => {
    sdk.mode = "ok";
    await generate("social", brand, [], "", { crossReview: false });
    const [gen, review] = sdk.calls;
    expect(gen.opts!.timeout).toBeGreaterThan(MODEL_BUDGET.GEN_MS - 1_000);
    expect(gen.opts!.timeout).toBeLessThanOrEqual(MODEL_BUDGET.GEN_MS);
    expect(review.kind).toBe("create");
    expect(review.opts!.timeout).toBeLessThanOrEqual(MODEL_BUDGET.REVIEW_MS);
    sdk.calls = [];
    await generate("social", brand, [], "", { crossReview: false, deadline: Date.now() + MODEL_BUDGET.REVIEW_MIN_MS - 1_000 });
    expect(sdk.calls.map((c) => c.kind), "the first pass ships without a review").toEqual(["generate"]);
  });

  it("generateBatch: a batch whose model passes the deadline is refunded in full", async () => {
    const u = await newUser("mt-batch");
    await db.set(`brand:${u.email}`, brand);
    const r = await generateBatch((await getUser(u.email))!, u.email, { type: "social", source: "manual", via: "app", deadline: Date.now() + 150 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("failed");
    expect(await credits(u.email)).toBe(50);
  });

  it("POST /api/generate: a model that never answers ends in 502 with the credits back, inside 300 s", async () => {
    const u = await newUser("mt-route");
    await saveUser({ ...u, credits: 20 });
    await db.set(`brand:${u.email}`, brand);
    await signIn(u.email);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = generateRoute.POST(json("/api/generate", "POST", { type: "social" }));
    await vi.waitFor(() => { if (!sdk.calls.length) throw new Error("not called yet"); }, { timeout: 5_000, interval: 5 });
    // The call's budget is the request's deadline: 15 s under the 300 s the platform allows.
    expect(sdk.calls[0].opts!.timeout).toBeLessThanOrEqual(300_000 - 15_000);
    expect(await credits(u.email)).toBe(20 - TASK_COST.social);
    await vi.advanceTimersByTimeAsync(300_000 - 15_000);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("generation_failed");
    expect(await credits(u.email)).toBe(20);
  });

  it("chat(): a turn whose model never answers ends by the request's deadline with a saved reply, not a hang", async () => {
    const u = await newUser("mt-chat");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const deadline = Date.now() + 60_000;
    const pending = chat((await getUser(u.email))!, "hello", undefined, "noor", { lang: "en", deadline });
    await vi.waitFor(() => { if (!sdk.calls.length) throw new Error("not called yet"); }, { timeout: 5_000, interval: 5 });
    expect(sdk.ctor).toEqual([{ timeout: MODEL_BUDGET.CHAT_MS, maxRetries: 1 }]);
    // The stream ends CHAT_REPLY_MS before the deadline, leaving time to save the reply and answer.
    expect(sdk.calls[0].opts!.timeout).toBeLessThanOrEqual(60_000 - MODEL_BUDGET.CHAT_REPLY_MS);
    await vi.advanceTimersByTimeAsync(60_000);
    const m = await pending;
    expect(m.content).toBe(OUT_OF_TIME_REPLY.en);
    expect((await history(u.email)).at(-1)!.content).toBe(OUT_OF_TIME_REPLY.en);
  });

  it("a far deadline: every charged call's attempt is still capped by its own budget", async () => {
    sdk.mode = "ok";
    await generate("social", brand, [], "", { crossReview: false, deadline: Date.now() + 285_000 });
    const [gen, review] = sdk.calls;
    expect(gen.opts!.timeout).toBe(MODEL_BUDGET.GEN_MS);
    expect(review.opts!.timeout).toBeLessThanOrEqual(MODEL_BUDGET.REVIEW_MS);
    sdk.calls = [];
    const u = await newUser("mt-chat-far");
    await chat((await getUser(u.email))!, "hello", undefined, "noor", { lang: "en", deadline: Date.now() + 285_000 });
    expect(sdk.calls[0].opts!.timeout).toBe(MODEL_BUDGET.CHAT_MS);
    sdk.calls = [];
    const site = { url: "https://example.test", ok: true, platform: "unknown", title: "t", description: "d", links: [], text: "x" } as unknown as Parameters<typeof buildFromSite>[0];
    await buildFromSite(site, "ar", undefined, undefined, undefined, Date.now() + 285_000).catch(() => null);
    // The mock's reply is not a part's JSON, so each part is tried twice: every attempt is capped all the same.
    expect(sdk.calls.length).toBeGreaterThanOrEqual(3);
    for (const c of sdk.calls) expect(c.opts!.timeout).toBe(MODEL_BUDGET.ONBOARD_MS);
  });

  it("free tools: one retry, and both attempts end by the route's deadline", async () => {
    sdk.mode = "ok";
    const res = await toolRoute.POST(json("/api/tools/x", "POST", { lang: "ar" }), { params: Promise.resolve({ tool: TOOL }) });
    expect(res.status).toBe(200);
    expect(sdk.ctor).toEqual([{ timeout: MODEL_BUDGET.TOOL_MS, maxRetries: 1 }]);
    expect(sdk.calls[0].opts!.signal).toBeInstanceOf(AbortSignal);
    expect(sdk.calls[0].opts!.timeout).toBeLessThanOrEqual(Math.min(MODEL_BUDGET.TOOL_MS, (60 - 15) * 1000));
  });

  it("chat(): no model turn starts with less than CHAT_TURN_MIN_MS left", async () => {
    const u = await newUser("mt-chat-late");
    const m = await chat((await getUser(u.email))!, "hello", undefined, "noor", { lang: "ar", deadline: Date.now() + MODEL_BUDGET.CHAT_TURN_MIN_MS - 1_000 });
    expect(m.content).toBe(OUT_OF_TIME_REPLY.ar);
    expect(sdk.calls).toEqual([]);
  });

  it("onboarding: the three parts end by the request's deadline, and a part is not retried without time for it", async () => {
    const site = { url: "https://example.test", ok: true, platform: "unknown", title: "t", description: "d", links: [], text: "x" } as unknown as Parameters<typeof buildFromSite>[0];
    await expect(buildFromSite(site, "ar", undefined, undefined, undefined, Date.now() + 150)).rejects.toThrow("aborted");
    expect(sdk.ctor).toEqual([{ timeout: MODEL_BUDGET.ONBOARD_MS, maxRetries: 1 }]);
    expect(sdk.calls.map((c) => c.kind)).toEqual(["stream", "stream", "stream"]);
  });

  it("every route that starts a charged model call hands its own deadline on", () => {
    const src = (f: string) => readFileSync(f, "utf8");
    for (const f of ["src/app/api/chat/route.ts", "src/app/api/onboard/route.ts", "src/app/api/cron/weekly/route.ts", "src/app/api/schedule/route.ts", "src/app/api/cron/routines/route.ts", "src/app/api/generate/route.ts", "src/app/api/mcp/route.ts"]) {
      expect(src(f), f).toMatch(/const deadline = deadlineFor\(maxDuration\);/);
    }
    // Since pricing phase 2 (#237) a turn runs inside `runChatTurn(…, () => chat(…))`, so the calls read `=> chat(`.
    const chatCalls = (f: string) => src(f).split("\n").filter((l) => /(await|=>) chat\(/.test(l));
    expect(chatCalls("src/app/api/chat/route.ts")).toHaveLength(2);
    expect(chatCalls("src/app/api/mcp/route.ts")).toHaveLength(1);
    for (const f of ["src/app/api/chat/route.ts", "src/app/api/mcp/route.ts"]) for (const l of chatCalls(f)) expect(l, f).toMatch(/\bdeadline\b/);
    expect(src("src/app/api/onboard/route.ts")).toMatch(/buildFromSite\([\s\S]*?, deadline\);/);
    expect(src("src/app/api/cron/weekly/route.ts")).toMatch(/runWeekly\(u, systemBy\("cron"\), \{ deadline \}\)/);
    expect(src("src/app/api/schedule/route.ts")).toMatch(/runWeekly\(u, await byOf\(u\), \{ deadline \}\)/);
    // deadlineFor keeps 15 s for the refund and the answer.
    const t0 = Date.now();
    expect(deadlineFor(300, t0) - t0).toBe(285_000);
  });
});
