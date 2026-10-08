import { db } from "./db";
import { monthKey } from "./credits";
import { AGENT_IDS, isAgentId, type AgentId } from "./agents";
import { MODELS, modelById } from "./models/catalog";
import type { Rejected } from "./models/route";
import { effectiveProvider, type LlmProvider } from "./model";

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

/**
 * USD per million tokens: Anthropic list prices, checked 2026-09-27 (Sonnet 5.5 added 2026-10-02). Since 2026-10-08 the
 * model catalog (`models/catalog.ts`) is the source of rates and this table is only the fallback behind it: `knownRate`
 * asks the catalog first. The three models here are in the catalog with the same numbers, so nothing is priced differently;
 * the table goes in a later release, once nothing reads it (expand, then contract: rule 679). Until then a change of an
 * Anthropic price is made in both places.
 */
const RATES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  /** The chat model since 2026-10-02 (`CHAT_MODEL`, src/lib/chat.ts). */
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
const DEFAULT_RATE = RATES["claude-opus-5"];
const hasOldRate = (model: string): boolean => Object.prototype.hasOwnProperty.call(RATES, model);
/** The catalog's rate for `model`, else the old table's, else undefined. Own keys only: "constructor" has no rate. */
const knownRate = (model: string) => modelById(model)?.rate ?? (hasOldRate(model) ? RATES[model] : undefined);
/**
 * True when `model` has a rate of its own, in the catalog or in the old table. `costUsd` prices an unknown id as Opus, so
 * the floor test (tests/pricing-floor.test.ts) asks this for every model the estimates assume. The tables stay private.
 */
export const hasRate = (model: string): boolean => knownRate(model) !== undefined;

/**
 * `xreview` is the cross-agent review (`crossReview` in noor.ts): Razan's and Majed's notes on another agent's batch. It
 * is metered to the REVIEWING agent, not to the batch's owner, so it reads as what their review work costs.
 */
export const KINDS = ["generate", "review", "chat", "onboard", "image_prompt", "tool", "judge", "xreview"] as const;
export type Kind = (typeof KINDS)[number];

export function costUsd(model: string, u: TokenUsage): number {
  const r = knownRate(model) ?? DEFAULT_RATE;
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
    ...["in", "out", "calls", "usd_micro", "cache_read", "cache_write", "chat_msgs", "chat_over", "chat_cred"].map((p) => `${k}:${p}`),
    ...KINDS.flatMap((kind) => [`${k}:kind:${kind}`, `${k}:kind:${kind}:in`, `${k}:kind:${kind}:out`, `${k}:kind:${kind}:usd_micro`]),
    ...AGENT_IDS.flatMap((id) => [`${k}:agent:${id}:calls`, `${k}:agent:${id}:usd_micro`]),
  ];
}

/** The providers a call can be metered under: the two `LlmProvider` values, a fixed list so no input becomes part of a key. */
const PROVIDERS: readonly LlmProvider[] = ["anthropic", "straitly"];
/** The key part for models the catalog does not know (a dated alias, a gateway form, a hostile id): one bucket, never the id. */
export const OTHER_MODEL = "other";

/**
 * Per-model and per-provider cost counters are GLOBAL ONLY, under `usage:_all:{YYYY-MM}:model:{modelKey}:calls|usd_micro`
 * and `usage:_all:{YYYY-MM}:provider:{provider}:calls|usd_micro`: the founder's view of what each model and each provider
 * costs, never a per-account figure. They have no account in the name, so `wipeAccount` has nothing to miss, and they are
 * not in `usageMonthKeys`. The key space is closed: `modelKey` is a catalog id or "other", the provider is one of two.
 * Counted from the day this ships; earlier months read as zero (no backfill). `costUsd` and the rates are unchanged.
 */
const modelKeyOf = (model: string): string => modelById(model)?.id ?? OTHER_MODEL;

/**
 * Record one model call. `email` undefined = anonymous (free tools); still counted globally. `agent` is the agent the
 * call worked for (the owner of the task type; the chat agent for a chat turn; Noor for onboarding), computed in code.
 * `provider` is the provider the call went to; left out, it is the one the client really uses (`effectiveProvider()`: the
 * gateway only with `LLM_PROVIDER=straitly` and its key), and a value that is not one of the two is ignored the same way. The model and the provider also count in the two global families above.
 */
export async function meter(email: string | undefined, model: string, kind: Kind, usage?: TokenUsage | null, agent?: AgentId, provider?: LlmProvider) {
  if (!usage) return;
  const m = monthKey();
  const inp = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const out = usage.output_tokens ?? 0;
  const micro = Math.round(costUsd(model, usage) * 1e6);
  const targets = [`usage:_all:${m}`, ...(email ? [`usage:${email}:${m}`] : [])];
  const mk = `usage:_all:${m}:model:${modelKeyOf(model)}`;
  const pk = `usage:_all:${m}:provider:${PROVIDERS.includes(provider as LlmProvider) ? provider : effectiveProvider()}`;
  try {
    await Promise.all([
      ...targets.flatMap((k) => [
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
      // Global only (see above): what each model and each provider costs us, for the founder console.
      db.incrby(`${mk}:calls`, 1),
      db.incrby(`${mk}:usd_micro`, micro),
      db.incrby(`${pk}:calls`, 1),
      db.incrby(`${pk}:usd_micro`, micro),
    ]);
  } catch (e) {
    console.error("meter failed", e);
  }
}

/** Where a pick can be rejected: the chat route and a generation batch (the only two purposes a customer's pick changes). */
export const PICK_PURPOSES = ["chat", "generate"] as const;
export type PickPurpose = (typeof PICK_PURPOSES)[number];
/** Every `Rejected` reason; a `Record` so a reason added to the router without a line here fails the type-check. */
const REJECT_REASONS_MAP: Record<Rejected, true> = { unknown: true, not_pickable: true, china_unconfirmed: true, needs_tools: true, task_not_allowed: true };
export const PICK_REJECT_REASONS = Object.keys(REJECT_REASONS_MAP) as Rejected[];

/**
 * Counts one customer pick the router refused (`routed.rejected`), in the founder's global counter
 * `usage:_all:{YYYY-MM}:pickreject:{purpose}:{reason}`, so a pick that keeps failing shows in the console. Global, no
 * account in the name. Purpose and reason are checked against the fixed lists, so no input is ever part of a key. Best
 * effort: it never throws and never changes what the caller does; on a store error it logs one fixed line (no id, no
 * email, no error text).
 */
export async function noteRejectedPick(purpose: PickPurpose, reason: Rejected): Promise<void> {
  if (!PICK_PURPOSES.includes(purpose) || !PICK_REJECT_REASONS.includes(reason)) return;
  try {
    await db.incrby(`usage:_all:${monthKey()}:pickreject:${purpose}:${reason}`, 1);
  } catch {
    console.error("pick_reject_counter_failed");
  }
}

/**
 * Chat messages (owner turns, not model calls: `kind:chat` counts calls) per account per month, under the same
 * `usage:{email}:{YYYY-MM}` prefix so `usageMonthKeys` and `wipeAccount` cover them (src/lib/chat-allowance.ts).
 * `chat_msgs` counts the messages inside the plan's allowance, `chat_over` the ones continued on credits and
 * `chat_cred` the credits those were billed (so a pace of credit use counts them).
 */
export const chatMsgKey = (email: string, month = monthKey()) => `usage:${email}:${month}:chat_msgs`;
export const chatOverKey = (email: string, month = monthKey()) => `usage:${email}:${month}:chat_over`;
export const chatCredKey = (email: string, month = monthKey()) => `usage:${email}:${month}:chat_cred`;
/** The trial's messages are granted once for the whole trial, not per month. Deleted with the account (`wipeAccount`). */
export const chatTrialKey = (email: string) => `chatm:${email}:trial`;

/** Tokens and money for one kind of model call. */
export type KindUsage = { calls: number; in: number; out: number; usd: number };
/** Calls and money for one agent. */
export type AgentUsage = { calls: number; usd: number };
/** Calls and money for one model, or one provider (`getUsage("_all")`). */
export type ModelUsage = { calls: number; usd: number };
export type UsageSummary = { month: string; in: number; out: number; calls: number; usd: number; kinds: Record<string, number>; /** tokens and cost per kind; the average of one request of that kind is usd / calls */ byKind: Record<string, KindUsage>; /** calls and cost per agent (only agents with calls) */ byAgent: Partial<Record<AgentId, AgentUsage>>; /** input tokens served from the prompt cache / written to it */ cacheRead: number; cacheWrite: number; /** chat messages this month inside the plan's allowance / continued on credits (a trial's are under `chatTrialKey`), and the credits the latter were billed */ chatMessages: number; chatOverflow: number; chatCredits: number; /** `getUsage("_all")` only, empty for an account: calls and cost per catalog model ("other" for any id outside it) and per provider (only entries with calls) */ models: Record<string, ModelUsage>; providers: Record<string, ModelUsage>; /** `_all` only: requests the gateway failed that were re-sent to Anthropic (model.ts) */ fallbacks: number; /** `_all` only: picks the router refused, keyed "{purpose}:{reason}" (only non-zero) */ rejectedPicks: Record<string, number> };

/**
 * The global model, provider, fallback and rejected-pick counters of one month, in ONE `mget`. `ids` are the catalog's ids
 * plus "other", the providers are the two fixed ones; a counter that does not exist (a month before this shipped) is zero.
 */
async function globalModelUsage(month: string): Promise<Pick<UsageSummary, "models" | "providers" | "fallbacks" | "rejectedPicks">> {
  const k = `usage:_all:${month}`;
  const ids = [...MODELS.map((x) => x.id), OTHER_MODEL];
  const picks = PICK_PURPOSES.flatMap((p) => PICK_REJECT_REASONS.map((r) => `${p}:${r}`));
  const keys = [
    ...ids.flatMap((id) => [`${k}:model:${id}:calls`, `${k}:model:${id}:usd_micro`]),
    ...PROVIDERS.flatMap((p) => [`${k}:provider:${p}:calls`, `${k}:provider:${p}:usd_micro`]),
    `${k}:provider:fallback`,
    ...picks.map((x) => `${k}:pickreject:${x}`),
  ];
  const v = (await db.mget<number>(keys)).map((x) => Number(x ?? 0));
  let i = 0;
  const pair = (): ModelUsage => {
    const calls = v[i++], micro = v[i++];
    return { calls, usd: Math.round(micro / 100) / 1e4 };
  };
  const models: Record<string, ModelUsage> = {};
  for (const id of ids) {
    const u = pair();
    if (u.calls) models[id] = u;
  }
  const providers: Record<string, ModelUsage> = {};
  for (const p of PROVIDERS) {
    const u = pair();
    if (u.calls) providers[p] = u;
  }
  const fallbacks = v[i++];
  const rejectedPicks: Record<string, number> = {};
  for (const x of picks) {
    const c = v[i++];
    if (c) rejectedPicks[x] = c;
  }
  return { models, providers, fallbacks, rejectedPicks };
}

export async function getUsage(email: string | "_all", month = monthKey()): Promise<UsageSummary> {
  const k = `usage:${email}:${month}`;
  const n = async (s: string) => Number((await db.get<number>(`${k}:${s}`)) ?? 0);
  const [inp, out, calls, micro, cacheRead, cacheWrite, chatMessages, chatOverflow, chatCredits] = await Promise.all([n("in"), n("out"), n("calls"), n("usd_micro"), n("cache_read"), n("cache_write"), n("chat_msgs"), n("chat_over"), n("chat_cred")]);
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
  // Per model and per provider exist for `_all` only (no per-account counters): an account's summary has them empty, with no extra read.
  const g = email === "_all" ? await globalModelUsage(month) : { models: {}, providers: {}, fallbacks: 0, rejectedPicks: {} };
  return { month, in: inp, out, calls, usd: Math.round(micro / 1e4) / 100, kinds, byKind, byAgent, cacheRead, cacheWrite, chatMessages, chatOverflow, chatCredits, ...g };
}
