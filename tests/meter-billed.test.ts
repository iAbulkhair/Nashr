import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Rules 980-986: the founder console counts every model call Anthropic bills (src/lib/metered.ts). Before, a call was
 * metered only when it returned a message, so a stream cut by its deadline, a non-streamed call that timed out (and its
 * SDK retry) and the declined attempt of a server-side fallback were billed by Anthropic and missing from Thakeen's cost
 * figures. Now every call is a stream wrapped by `metered`, which meters a failed stream from its snapshot, and a reply's
 * `usage.iterations` is metered per model.
 */
type Reply = { model: string; stop_reason?: string; usage: Record<string, unknown>; content: unknown[] };
type Opts = { signal?: AbortSignal; timeout?: number } | undefined;
const sdk = vi.hoisted(() => ({
  mode: "ok" as "ok" | "hang",
  reply: undefined as Reply | undefined,
  snapshot: undefined as Reply | undefined,
  calls: [] as { params: Record<string, unknown>; opts: Opts }[],
}));
vi.mock("@anthropic-ai/sdk", () => {
  /** A stream as the SDK's: `currentMessage` is what has arrived; in "hang" mode it rejects only when its signal aborts. */
  const stream = (params: Record<string, unknown>, opts: Opts) => {
    sdk.calls.push({ params, opts });
    return {
      currentMessage: sdk.snapshot,
      finalMessage: () =>
        sdk.mode === "ok"
          ? Promise.resolve(sdk.reply)
          : new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")))),
    };
  };
  return {
    default: class {
      static BadRequestError = class extends Error {};
      beta = { messages: { stream } };
      messages = { stream };
    },
  };
});
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));

import { db } from "@/lib/db";
import { monthKey } from "@/lib/credits";
import { acct, currentUser } from "@/lib/auth";
import type { Brand } from "@/lib/brand";
import { MODEL_BUDGET } from "@/lib/model";
import { route } from "@/lib/models/route";
import { billedParts, costUsd, meterBilled } from "@/lib/usage";
import { metered, partialUsage, streamedTokens } from "@/lib/metered";
import { chat, OUT_OF_TIME_REPLY } from "@/lib/chat";
import { generate } from "@/lib/noor";
import { scoreItems } from "@/lib/judge";
import { newUser, settle, signIn } from "./helpers/session";

const OPUS55 = "claude-opus-5-5";
const SONNET55 = "claude-sonnet-5-5";
const brand: Brand = { name: "مقهى", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const micro = (model: string, u: Parameters<typeof costUsd>[1]) => Math.round(costUsd(model, u) * 1e6);
const n = async (key: string) => Number((await db.get<number>(key)) ?? 0);
/** One account's counters this month. */
const usageOf = (id: string) => {
  const k = `usage:${id}:${monthKey()}`;
  return { calls: () => n(`${k}:calls`), usd: () => n(`${k}:usd_micro`), in: () => n(`${k}:in`), out: () => n(`${k}:out`), kind: (kind: string) => n(`${k}:kind:${kind}`), agent: (id: string) => n(`${k}:agent:${id}:calls`) };
};
const pin = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
/** Source without comments, so a comment that names `messages.create` is not a call. "https://" keeps its colon. */
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

beforeEach(() => {
  sdk.mode = "ok"; sdk.reply = undefined; sdk.snapshot = undefined; sdk.calls = [];
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  vi.stubEnv("LLM_PROVIDER", "");
  vi.stubEnv("STRAITLY_API_KEY", "");
});
afterEach(async () => {
  vi.useRealTimers();
  await settle();
  vi.unstubAllEnvs();
});

describe("every model call is a metered stream (rule 980)", () => {
  const files = walk("src").map((f) => ({ f, src: code(f) }));

  it("no file in src calls messages.create: a non-streamed call that times out was billed and could not be metered", () => {
    expect(files.filter(({ src }) => /messages\s*\.\s*create\s*\(/.test(src)).map(({ f }) => f)).toEqual([]);
  });

  it("every messages.stream call is wrapped by metered(), and only metered.ts waits for a final message", () => {
    const streams = files.filter(({ src }) => /messages\s*\.\s*stream\s*\(/.test(src));
    // The scan must keep finding the call sites it exists to check.
    expect(streams.length).toBeGreaterThanOrEqual(7);
    for (const { f, src } of streams) {
      const calls = src.match(/messages\s*\.\s*stream\s*\(/g)!.length;
      expect((src.match(/\bmetered\s*\(/g) ?? []).length, f).toBeGreaterThanOrEqual(calls);
    }
    expect(files.filter(({ src }) => /\.finalMessage\s*\(/.test(src)).map(({ f }) => f)).toEqual([join("src", "lib", "metered.ts")]);
  });
});

describe("a reply's iterations are metered per model, as one call (rule 981)", () => {
  const declined = { type: "message", model: null, input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const served = { type: "fallback_message", model: SONNET55, input_tokens: 1200, output_tokens: 900, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 };

  it("billedParts: no iterations is the top-level usage at the reply's model; iterations are summed per model, a model-less one at the requested model", () => {
    expect(billedParts(SONNET55, { input_tokens: 10, output_tokens: 5 }, OPUS55)).toEqual([{ model: SONNET55, usage: { input_tokens: 10, output_tokens: 5 } }]);
    expect(billedParts(OPUS55, { input_tokens: 10, output_tokens: 5, iterations: [] })).toEqual([{ model: OPUS55, usage: { input_tokens: 10, output_tokens: 5, iterations: [] } }]);
    // The top-level usage (the serving attempt only) is ignored when iterations are there: they hold every billed attempt.
    const parts = billedParts(SONNET55, { input_tokens: 1200, output_tokens: 900, iterations: [declined, served, { ...declined, type: "compaction", model: undefined }] }, OPUS55);
    expect(parts).toEqual([
      { model: OPUS55, usage: { input_tokens: 2400, output_tokens: 600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { model: SONNET55, usage: { input_tokens: 1200, output_tokens: 900, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 } },
    ]);
  });

  it("meterBilled: the account, kind, agent and provider count one call; each model's own counter counts its attempt; the cost is the sum at each model's rate", async () => {
    pin("2032-03-10T12:00:00Z");
    const u = await newUser("mb-iter");
    await meterBilled(acct(u), SONNET55, "generate", { input_tokens: 1200, output_tokens: 900, iterations: [declined, served] }, "noor", OPUS55);
    const want = micro(OPUS55, declined) + micro(SONNET55, served);
    expect(want).toBeGreaterThan(micro(SONNET55, served));
    const k = `usage:${acct(u)}:2032-03`;
    expect([await n(`${k}:calls`), await n(`${k}:kind:generate`), await n(`${k}:agent:noor:calls`)]).toEqual([1, 1, 1]);
    // Each part's micro-dollars are rounded on their own, the same arithmetic `meter` uses.
    expect(await n(`${k}:usd_micro`)).toBe(want);
    expect(await n(`${k}:in`)).toBe(1200 + 1200 + 400);
    expect(await n(`${k}:out`)).toBe(300 + 900);
    expect(await n(`usage:_all:2032-03:model:${OPUS55}:calls`)).toBe(1);
    expect(await n(`usage:_all:2032-03:model:${OPUS55}:usd_micro`)).toBe(micro(OPUS55, declined));
    expect(await n(`usage:_all:2032-03:model:${SONNET55}:calls`)).toBe(1);
    expect(await n(`usage:_all:2032-03:provider:anthropic:calls`)).toBe(1);
    expect(await n(`usage:_all:2032-03:provider:anthropic:usd_micro`)).toBe(want);
  });

  it("generate(): a batch answered by the server-side fallback meters the declined attempt at the requested model", async () => {
    const u = await newUser("mb-gen");
    const requested = route("generate", { task: "social" }).model;
    sdk.reply = {
      model: SONNET55,
      stop_reason: "end_turn",
      usage: { input_tokens: 1200, output_tokens: 900, iterations: [declined, served] },
      content: [{ type: "text", text: JSON.stringify([{ channel: "instagram", title: "t", body: "نص تجريبي للعنصر يكفي للمراجعة" }]) }],
    };
    await generate("social", brand, [], "", { meter: acct(u), reviewer: false, crossReview: false });
    expect(sdk.calls[0].params.fallbacks).toBe("default");
    const a = usageOf(acct(u));
    expect([await a.calls(), await a.kind("generate"), await a.agent("noor")]).toEqual([1, 1, 1]);
    expect(await a.usd()).toBe(micro(requested, declined) + micro(SONNET55, served));
  });
});

describe("a stream that fails after it started is metered from its snapshot (rules 982-984)", () => {
  const snap = (content: unknown[]): Reply => ({ model: OPUS55, usage: { input_tokens: 2000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 }, content });

  it("rule 982: input and cache exact, output raised to what had streamed, the same error rethrown", async () => {
    const u = await newUser("mb-abort");
    const err = new Error("model_deadline");
    const s = { currentMessage: snap([{ type: "text", text: "a".repeat(400) }]), finalMessage: () => Promise.reject(err) };
    await expect(metered(s, { email: acct(u), kind: "chat", agent: "sami" })).rejects.toBe(err);
    const a = usageOf(acct(u));
    expect([await a.calls(), await a.kind("chat"), await a.agent("sami")]).toEqual([1, 1, 1]);
    expect(await a.in()).toBe(3000);
    expect(await a.out()).toBe(100);
    expect(await a.usd()).toBe(micro(OPUS55, { input_tokens: 2000, cache_read_input_tokens: 1000, output_tokens: 100 }));
  });

  it("rule 982: a message the stream had completed before the error is metered whole (the SDK clears the snapshot then)", async () => {
    const u = await newUser("mb-done");
    const done: Reply = { model: OPUS55, usage: { input_tokens: 50, output_tokens: 70 }, content: [] };
    const s = { currentMessage: undefined, receivedMessages: [done], finalMessage: () => Promise.reject(new Error("late")) };
    await expect(metered(s, { email: acct(u), kind: "review" })).rejects.toThrow("late");
    expect(await usageOf(acct(u)).out()).toBe(70);
    expect(await usageOf(acct(u)).usd()).toBe(micro(OPUS55, { input_tokens: 50, output_tokens: 70 }));
  });

  it("rule 983: the estimate counts text, thinking and tool input, about 4 ASCII or 2 other characters a token, and never lowers a reported count", () => {
    expect(streamedTokens([{ type: "text", text: "abcdefgh" }])).toBe(2);
    expect(streamedTokens([{ type: "text", text: "مرحبابكمفي" }])).toBe(5);
    expect(streamedTokens([{ type: "thinking", thinking: "abcd" }, { type: "tool_use", input: { a: 1 } }])).toBe(Math.ceil(4 / 4 + '{"a":1}'.length / 4));
    expect(streamedTokens([{ type: "redacted_thinking", data: "x".repeat(400) }, null, "text"])).toBe(0);
    expect(streamedTokens(undefined as unknown as unknown[])).toBe(0);
    expect(partialUsage({ model: OPUS55, usage: { input_tokens: 5, output_tokens: 900 }, content: [{ type: "text", text: "abcd" }] }).output_tokens).toBe(900);
  });

  it("rule 984: a failure before the first event (no snapshot: a 4xx, 429, 5xx, connection error or timeout before headers) meters nothing", async () => {
    const u = await newUser("mb-none");
    const err = new Error("529 overloaded");
    await expect(metered({ finalMessage: () => Promise.reject(err) }, { email: acct(u), kind: "generate" })).rejects.toBe(err);
    expect([await usageOf(acct(u)).calls(), await usageOf(acct(u)).usd()]).toEqual([0, 0]);
  });
});

describe("callers meter what was billed (rules 985-986)", () => {
  it("rule 985: chat(): a turn cut by the request's deadline is metered for what it had streamed, and the owner still gets the out-of-time reply", async () => {
    const u = await newUser("mb-chat");
    sdk.mode = "hang";
    sdk.snapshot = { model: SONNET55, usage: { input_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, content: [{ type: "text", text: "x".repeat(800) }] };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await signIn(u.email);
    const pending = chat((await currentUser())!, "hello", undefined, "noor", { lang: "en", deadline: Date.now() + 60_000 });
    await vi.waitFor(() => { if (!sdk.calls.length) throw new Error("not called yet"); }, { timeout: 5_000, interval: 5 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).content).toBe(OUT_OF_TIME_REPLY.en);
    const a = usageOf(acct(u));
    expect([await a.kind("chat"), await a.in(), await a.out()]).toEqual([1, 5000, 200]);
    expect(await a.usd()).toBe(micro(SONNET55, { input_tokens: 5000, output_tokens: 200 }));
  });

  it("rule 986: the judge's whole reply is bounded by JUDGE_MS through a signal (a stream's timeout covers only its headers)", async () => {
    const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };
    sdk.reply = { model: SONNET55, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify([verdict]) }] };
    // Rule 1206: a clock that ticks 1 ms on every read still gives the whole budget, because the deadline reads it once.
    let t = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => t++);
    try {
      await scoreItems(undefined, brand, "social", [{ channel: "instagram", title: "t", body: "b" }], 1);
    } finally {
      clock.mockRestore();
    }
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].opts?.signal).toBeInstanceOf(AbortSignal);
    expect(sdk.calls[0].opts!.timeout).toBe(MODEL_BUDGET.JUDGE_MS);
  });
});
