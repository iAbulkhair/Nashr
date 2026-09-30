import { db } from "./db";
import { monthKey } from "./credits";
import { AGENT_IDS, isAgentId, type AgentId } from "./agents";

/**
 * Model token metering per account per month. Credits are what users pay;
 * this is what the models actually cost us, so margins are visible in the
 * admin console. Counters are Redis integers (INCRBY), cost stored in
 * micro-dollars to stay integer.
 */
export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** USD per million tokens: Anthropic list prices, checked 2026-09-27. Update when Anthropic changes them. */
const RATES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
const DEFAULT_RATE = RATES["claude-opus-5"];

/**
 * `xreview` is the cross-agent review (`crossReview` in noor.ts): Razan's and Majed's notes on another agent's batch. It
 * is metered to the REVIEWING agent, not to the batch's owner, so it reads as what their review work costs.
 */
export const KINDS = ["generate", "review", "chat", "onboard", "image_prompt", "tool", "judge", "xreview"] as const;
export type Kind = (typeof KINDS)[number];

export function costUsd(model: string, u: TokenUsage): number {
  const r = RATES[model] ?? DEFAULT_RATE;
  const inp = u.input_tokens ?? 0, out = u.output_tokens ?? 0, cr = u.cache_read_input_tokens ?? 0, cw = u.cache_creation_input_tokens ?? 0;
  return (inp * r.in + out * r.out + cr * r.cacheRead + cw * r.cacheWrite) / 1e6;
}

/**
 * Every counter one account (or `_all`) can have in one month, under `usage:{email}:{YYYY-MM}`. Built from KINDS and
 * AGENT_IDS, so `wipeAccount` cannot miss a counter that a new kind or a new agent adds.
 */
export function usageMonthKeys(email: string, month: string): string[] {
  const k = `usage:${email}:${month}`;
  return [
    ...["in", "out", "calls", "usd_micro", "cache_read", "cache_write"].map((p) => `${k}:${p}`),
    ...KINDS.flatMap((kind) => [`${k}:kind:${kind}`, `${k}:kind:${kind}:in`, `${k}:kind:${kind}:out`, `${k}:kind:${kind}:usd_micro`]),
    ...AGENT_IDS.flatMap((id) => [`${k}:agent:${id}:calls`, `${k}:agent:${id}:usd_micro`]),
  ];
}

/**
 * Record one model call. `email` undefined = anonymous (free tools); still counted globally. `agent` is the agent the
 * call worked for (the owner of the task type; the chat agent for a chat turn; Noor for onboarding), computed in code.
 */
export async function meter(email: string | undefined, model: string, kind: Kind, usage?: TokenUsage | null, agent?: AgentId) {
  if (!usage) return;
  const m = monthKey();
  const inp = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const out = usage.output_tokens ?? 0;
  const micro = Math.round(costUsd(model, usage) * 1e6);
  const targets = [`usage:_all:${m}`, ...(email ? [`usage:${email}:${m}`] : [])];
  try {
    await Promise.all(
      targets.flatMap((k) => [
        db.incrby(`${k}:in`, inp),
        db.incrby(`${k}:out`, out),
        db.incrby(`${k}:calls`, 1),
        db.incrby(`${k}:usd_micro`, micro),
        db.incrby(`${k}:kind:${kind}`, 1),
        // Same three numbers per kind, so cost per request type per account is a read, not an estimate.
        db.incrby(`${k}:kind:${kind}:in`, inp),
        db.incrby(`${k}:kind:${kind}:out`, out),
        db.incrby(`${k}:kind:${kind}:usd_micro`, micro),
        // Prompt caching is only worth its write premium when reads follow; these two counters show whether they do.
        ...(usage.cache_read_input_tokens ? [db.incrby(`${k}:cache_read`, usage.cache_read_input_tokens)] : []),
        ...(usage.cache_creation_input_tokens ? [db.incrby(`${k}:cache_write`, usage.cache_creation_input_tokens)] : []),
        // Calls and cost per agent, so what each agent costs to run is a read, not an estimate from task counts.
        ...(isAgentId(agent) ? [db.incrby(`${k}:agent:${agent}:calls`, 1), db.incrby(`${k}:agent:${agent}:usd_micro`, micro)] : []),
      ]),
    );
  } catch (e) {
    console.error("meter failed", e);
  }
}

/** Tokens and money for one kind of model call. */
export type KindUsage = { calls: number; in: number; out: number; usd: number };
/** Calls and money for one agent. */
export type AgentUsage = { calls: number; usd: number };
export type UsageSummary = { month: string; in: number; out: number; calls: number; usd: number; kinds: Record<string, number>; /** tokens and cost per kind; the average of one request of that kind is usd / calls */ byKind: Record<string, KindUsage>; /** calls and cost per agent (only agents with calls) */ byAgent: Partial<Record<AgentId, AgentUsage>>; /** input tokens served from the prompt cache / written to it */ cacheRead: number; cacheWrite: number };

export async function getUsage(email: string | "_all", month = monthKey()): Promise<UsageSummary> {
  const k = `usage:${email}:${month}`;
  const n = async (s: string) => Number((await db.get<number>(`${k}:${s}`)) ?? 0);
  const [inp, out, calls, micro, cacheRead, cacheWrite] = await Promise.all([n("in"), n("out"), n("calls"), n("usd_micro"), n("cache_read"), n("cache_write")]);
  const kinds: Record<string, number> = {};
  const byKind: Record<string, KindUsage> = {};
  const [per, perAgent] = await Promise.all([
    Promise.all(KINDS.map((kind) => Promise.all([n(`kind:${kind}`), n(`kind:${kind}:in`), n(`kind:${kind}:out`), n(`kind:${kind}:usd_micro`)]))),
    Promise.all(AGENT_IDS.map((id) => Promise.all([n(`agent:${id}:calls`), n(`agent:${id}:usd_micro`)]))),
  ]);
  KINDS.forEach((kind, i) => {
    const [c, ki, ko, km] = per[i];
    if (!c) return;
    kinds[kind] = c;
    byKind[kind] = { calls: c, in: ki, out: ko, usd: Math.round(km / 100) / 1e4 };
  });
  const byAgent: Partial<Record<AgentId, AgentUsage>> = {};
  AGENT_IDS.forEach((id, i) => {
    const [c, m] = perAgent[i];
    if (c) byAgent[id] = { calls: c, usd: Math.round(m / 100) / 1e4 };
  });
  return { month, in: inp, out, calls, usd: Math.round(micro / 1e4) / 100, kinds, byKind, byAgent, cacheRead, cacheWrite };
}
