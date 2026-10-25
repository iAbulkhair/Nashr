import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rules 4760-4769 (docs/system/tests/4720-v2-team.md): Thakeen v2 phase 3, the context meter (C13). It reads the run log,
 * so it follows `RUN_LOG`, and its trigger needs `COMPACTION`; both ship off (src/lib/v2-flags.ts). This file switches them
 * on through the flags module, so a real chat turn reads the meter, compacts under pressure and records its own run.
 */
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/v2-flags", () => ({
  GATEWAY_MODE: "off",
  get RUN_LOG() {
    return flag.on;
  },
  MEMORY_V2: false,
  get COMPACTION() {
    return flag.on;
  },
  PLANS: false,
  QUEUE: false,
  SELF_CHECK: false,
  TEAM_CHAT: false,
}));

import { json, newUser, signIn } from "./helpers/session";
import { claudeOn } from "./helpers/model";
import { acct, getUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { wsKey, type Scope } from "@/lib/keys";
import { push } from "@/lib/chat-history";
import { createConversation } from "@/lib/conversations";
import { listRuns, type Run } from "@/lib/runs";
import { chatTurnMaxUsd } from "@/lib/models/credits";
import { costUsd } from "@/lib/usage";
import { CHAT_FIRST_MIN_OUT } from "@/lib/chat-budget";
import type { ThreadSummary } from "@/lib/compaction";
import {
  CONTEXT_KEEP,
  METER_PRESSURE,
  contextBudget,
  coveredTail,
  keptFor,
  metersOf,
  runConv,
  underPressure,
} from "@/lib/context-meter";

const SONNET = "claude-sonnet-5-5";
const src = (p: string) => readFileSync(p, "utf8");
async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await signIn(u.email);
  return (await getUser(acct(u)))!;
}
const at = (i: number) => new Date(Date.UTC(2026, 9, 25, 10, i)).toISOString();
const run = (over: Partial<Run> & { inTokens?: number; model?: string } = {}): Run => {
  const { inTokens = 1000, model = SONNET, ...rest } = over;
  const agent = rest.agent ?? "noor";
  return {
    v: 1,
    id: "r-" + Math.random().toString(36).slice(2),
    kind: "chat",
    agent: "noor",
    via: "app",
    startedAt: at(0),
    ms: 10,
    ok: true,
    events: [
      { t: "model", at: 1, model: "claude-haiku-5-5", kind: "compact", agent, in: 99_999, out: 10, ok: true },
      { t: "model", at: 2, model, kind: "chat", agent, in: inTokens, out: 100, ok: true },
      { t: "model", at: 3, model, kind: "chat", agent, in: inTokens * 3, out: 100, ok: true },
    ],
    dropped: 0,
    ...rest,
  };
};
async function seedRun(s: Scope, r: Run) {
  await Promise.all([db.set(wsKey.run(s, r.id), r), db.lpush(wsKey.runs(s), r.id)]);
}

type Params = { messages: { role: string; content: unknown }[]; tool_choice?: { name?: string } };
const reply = (text: string) => ({
  model: SONNET,
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 100 },
  content: [{ type: "text", text }],
});
/** The SDK, replaced: chat calls go to `chats`, summary calls to `summaries`; any other classifier call passes. */
function sdk() {
  vi.resetModules();
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  claudeOn();
  const seen = { chats: [] as Params[], summaries: [] as Params[] };
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      beta = { messages: { stream: () => ({ finalMessage: async () => reply("[]") }) } };
      messages = {
        create: async () => reply(JSON.stringify([{ ok: true }])),
        stream: (p: Params & { output_config?: { format?: unknown } }) => ({
          finalMessage: async () => {
            if (p.tool_choice?.name === "summary") {
              seen.summaries.push(p);
              return {
                model: "claude-haiku-5-5",
                stop_reason: "tool_use",
                usage: { input_tokens: 50, output_tokens: 20 },
                content: [{ type: "tool_use", id: "s1", name: "summary", input: { summary: "ملخص قديم" } }],
              };
            }
            if (p.output_config?.format) return reply("{}");
            if (p.tool_choice) return reply(JSON.stringify([{ ok: true }]));
            // A copy: the turn appends the reply to the same array after the call.
            seen.chats.push({ ...p, messages: [...p.messages] });
            return reply("تمام");
          },
        }),
      };
    },
  }));
  return seen;
}
async function say(text: string, conv: string): Promise<{ ok: boolean }> {
  const route = await import("@/app/api/chat/route");
  return (await (await route.POST(json("/api/chat", "POST", { text, conv, agent: "noor" }))).json()) as { ok: boolean };
}
/** A thread of `n` short messages a minute apart, owner and team in turn. */
async function thread(u: User, conv: string, n: number) {
  for (let i = 0; i < n; i++)
    await push(acct(u), { role: i % 2 ? "assistant" : "user", content: "رسالة " + i, at: at(i) }, conv);
}

afterEach(() => {
  flag.on = true;
  vi.doUnmock("@anthropic-ai/sdk");
  vi.doUnmock("@/lib/model");
  vi.unstubAllEnvs();
});

describe("rule 4760: the meter follows the run log and adds no storage", () => {
  it("chat reads it only with COMPACTION and RUN_LOG on, from the run log, failing open", () => {
    const chat = src("src/lib/chat.ts");
    expect(chat).toMatch(
      /COMPACTION && RUN_LOG \? readMeters\(sc\(user\), conv\)\.catch\(\(e\): ContextMeter\[\] => \{/,
    );
    expect(chat).toMatch(/: \(\[\] as ContextMeter\[\]\)\]\);/);
    const meter = src("src/lib/context-meter.ts");
    expect(meter).not.toMatch(/db\.(set|get|lpush|del|mget)/);
    expect(meter).not.toMatch(/wsKey\./);
    expect(src("src/lib/keys.ts")).not.toMatch(/contextMeter|ctxmeter/);
  });
});

describe("rule 4761: the budget is the first call's room before the history guard drops messages", () => {
  it("the per-message ceiling less a full first answer, at the model's plain input rate", () => {
    const room = chatTurnMaxUsd(SONNET) - costUsd(SONNET, { output_tokens: CHAT_FIRST_MIN_OUT });
    expect(contextBudget(SONNET)).toBe(Math.floor(room / costUsd(SONNET, { input_tokens: 1 })));
    expect(contextBudget(SONNET)).toBeGreaterThan(10_000);
    expect(contextBudget("claude-opus-5-5")).toBeGreaterThan(0);
  });
});

describe("rule 4762: one meter per agent per thread, from its newest turn's first chat call", () => {
  it("picks the newest chat run of the thread per agent and its first chat call; other threads and kinds are ignored", () => {
    const runs: Run[] = [
      run({ conv: "c1", inTokens: 5000 }),
      run({ conv: "c1", inTokens: 100 }),
      run({ conv: "c1", agent: "faris", inTokens: 2000 }),
      run({ conv: "c2", agent: "dana", inTokens: 4000 }),
      run({ kind: "batch", conv: "c1", agent: "layan", inTokens: 4000 }),
    ];
    const m = metersOf(runs, "c1");
    expect(m.map((x) => x.agent)).toEqual(["noor", "faris"]);
    expect(m[0].used).toBe(5000);
    expect(m[0].budget).toBe(contextBudget(SONNET));
    expect(m[0].pct).toBeCloseTo(5000 / contextBudget(SONNET));
    expect(metersOf(runs, "c2").map((x) => x.agent)).toEqual(["dana"]);
    expect(metersOf(runs, undefined)).toEqual([]);
    expect(metersOf([run({ inTokens: 10_000_000 })], undefined)[0].pct).toBe(1);
  });
  it("the default thread is a run with no conv; a malformed id is never kept on a run", () => {
    expect(runConv(undefined)).toEqual({});
    expect(runConv("default")).toEqual({});
    expect(runConv("abc_DEF-1")).toEqual({ conv: "abc_DEF-1" });
    expect(runConv("a:b")).toEqual({});
    expect(runConv("x".repeat(65))).toEqual({});
    expect(src("src/lib/chat.ts")).toMatch(
      /kind: "chat", agent: agentId, via: opts\.via \?\? "app", \.\.\.runConv\(conv\), onStep: opts\.onStep \}/,
    );
  });
});

describe("rules 4763-4764: at 80% the next turn compacts first and sends only the newest messages", () => {
  it("pressure at METER_PRESSURE for that agent only", () => {
    const b = contextBudget(SONNET);
    const at80 = metersOf([run({ inTokens: Math.ceil(b * METER_PRESSURE) })], undefined);
    const at79 = metersOf([run({ inTokens: Math.floor(b * 0.79) })], undefined);
    expect(underPressure(at80, "noor")).toBe(true);
    expect(underPressure(at80, "faris")).toBe(false);
    expect(underPressure(at79, "noor")).toBe(false);
    expect(underPressure([], "noor")).toBe(false);
  });
  it("keptFor and coveredTail: the newest CONTEXT_KEEP once the summary covers the rest, else unchanged", () => {
    expect(keptFor(false, 13)).toBe(13);
    expect(keptFor(true, 13)).toBe(CONTEXT_KEEP);
    expect(keptFor(true, 3)).toBe(3);
    const th = Array.from({ length: 10 }, (_, i) => ({ at: at(i) }));
    const tr = th.map((_, i) => i);
    const sum = (upTo: string): ThreadSummary => ({ v: 1, text: "s", upTo, count: 4, at: at(20) });
    expect(coveredTail(tr, th, 6, sum(at(3)))).toEqual([4, 5, 6, 7, 8, 9]);
    expect(coveredTail(tr, th, 6, sum(at(2)))).toEqual(tr);
    expect(coveredTail(tr, th, 6, null)).toEqual(tr);
    expect(coveredTail(tr, th, 10, sum(at(9)))).toEqual(tr);
  });
  it("a real turn at 90%: one summary call of the older messages, and the model gets the newest six", async () => {
    const seen = sdk();
    const u = await owner("meter-hot");
    const c = await createConversation(sc(u), "…", "noor");
    await thread(u, c.id, 12);
    await seedRun(sc(u), run({ conv: c.id, inTokens: Math.ceil(contextBudget(SONNET) * 0.9) }));
    expect((await say("وش آخر شي؟", c.id)).ok).toBe(true);
    expect(seen.summaries).toHaveLength(1);
    expect(String(seen.summaries[0].messages[0].content)).toContain("رسالة 6");
    expect(String(seen.summaries[0].messages[0].content)).not.toContain("رسالة 7");
    expect(seen.chats[0].messages).toHaveLength(CONTEXT_KEEP);
    expect(seen.chats[0].messages.at(-1)).toEqual({ role: "user", content: "وش آخر شي؟" });
    // The turn's own run carries the thread and its first chat call: the next turn reads it, now far below the mark.
    const [mine] = await listRuns(sc(u), 1);
    expect(mine.conv).toBe(c.id);
    expect(underPressure(metersOf([mine], c.id), "noor")).toBe(false);
  });
  it("a real turn at 50%: no summary call (nothing dropped) and the whole thread is sent", async () => {
    const seen = sdk();
    const u = await owner("meter-cool");
    const c = await createConversation(sc(u), "…", "noor");
    await thread(u, c.id, 12);
    await seedRun(sc(u), run({ conv: c.id, inTokens: Math.ceil(contextBudget(SONNET) * 0.5) }));
    expect((await say("وش آخر شي؟", c.id)).ok).toBe(true);
    expect(seen.summaries).toHaveLength(0);
    expect(seen.chats[0].messages).toHaveLength(13);
  });
  it("off: no meter read, no summary call, and the run log keeps nothing", async () => {
    flag.on = false;
    const seen = sdk();
    const u = await owner("meter-off");
    const c = await createConversation(sc(u), "…", "noor");
    await thread(u, c.id, 12);
    await seedRun(sc(u), run({ conv: c.id, inTokens: contextBudget(SONNET) }));
    expect((await say("وش آخر شي؟", c.id)).ok).toBe(true);
    expect(seen.summaries).toHaveLength(0);
    expect(seen.chats[0].messages).toHaveLength(13);
    expect(await listRuns(sc(u), 5)).toHaveLength(1);
  });
});

describe("rule 4765: another workspace's runs never move this thread's meter", () => {
  it("the meter reads the caller's own run list only", async () => {
    const seen = sdk();
    const a = await owner("meter-a");
    const b = await newUser("meter-b");
    const c = await createConversation(sc(a), "…", "noor");
    await thread(a, c.id, 12);
    await seedRun(sc(b), run({ conv: c.id, inTokens: contextBudget(SONNET) }));
    expect((await say("وش آخر شي؟", c.id)).ok).toBe(true);
    expect(seen.summaries).toHaveLength(0);
    expect(seen.chats[0].messages).toHaveLength(13);
  });
});
