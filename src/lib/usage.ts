import { db } from "./db";
import { monthKey } from "./credits";
import { AGENT_IDS, isAgentId, type AgentId } from "./agents";
import { MODELS, modelById } from "./models/catalog";
import type { Rejected } from "./models/route";
import { effectiveProvider, type LlmProvider } from "./model";
import { log } from "./log";
import { accountKey, globalKey } from "./keys";
import { brandOfScope } from "./account-id";
import { byOf } from "./actor";
import type { User } from "./auth";

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
 * USD per million tokens come from the model catalog (`models/catalog.ts`), the only rate table since 2026-10-10 (rule
 * 970: the old `RATES` table here and the pre-5.5 models were removed). An id outside the catalog (an old id in stored
 * data, a dated alias, a gateway form) is priced at the HIGHEST catalog rate of each bucket, so a cost is never under-
 * reported; `hasRate` tells the floor test which ids have a rate of their own.
 */
const UNKNOWN_RATE = Object.freeze({
  in: Math.max(...MODELS.map((m) => m.rate.in)),
  out: Math.max(...MODELS.map((m) => m.rate.out)),
  cacheRead: Math.max(...MODELS.map((m) => m.rate.cacheRead)),
  cacheWrite: Math.max(...MODELS.map((m) => m.rate.cacheWrite)),
});
/** The catalog's rate for `model`, else undefined. An exact lookup: "constructor" has no rate. */
const knownRate = (model: string) => modelById(model)?.rate;
/**
 * True when `model` has a rate of its own in the catalog. `costUsd` prices an unknown id at the highest rates, so
 * the floor test (tests/pricing-floor.test.ts) asks this for every model the estimates assume. The tables stay private.
 */
export const hasRate = (model: string): boolean => knownRate(model) !== undefined;

/**
 * `xreview` is the cross-agent review (`crossReview` in noor.ts): Razan's and Majed's notes on another agent's batch. It
 * is metered to the REVIEWING agent, not to the batch's owner, so it reads as what their review work costs.
 * `agent_scope` is the agent-scope classifier (rule 790): it is metered to the global counters only (`meter(undefined, ...)`),
 * never to an account, so the founder's monthly total includes it and no owner is charged for it. `compact` is the thread
 * summary (Thakeen v2 C11, src/lib/compaction.ts), metered the same way: global counters only.
 */
export const KINDS = ["generate", "review", "chat", "onboard", "image_prompt", "tool", "judge", "xreview", "agent_scope", "compact"] as const;
export type Kind = (typeof KINDS)[number];

export function costUsd(model: string, u: TokenUsage): number {
  const r = knownRate(model) ?? UNKNOWN_RATE;
  const inp = u.input_tokens ?? 0, out = u.output_tokens ?? 0, cr = u.cache_read_input_tokens ?? 0, cw = u.cache_creation_input_tokens ?? 0;
  return (inp * r.in + out * r.out + cr * r.cacheRead + cw * r.cacheWrite) / 1e6;
}

/**
 * The per-account breakdowns (rules 2900-2909): one month of an account's model calls split by who ran them, which brand
 * they were for, which model answered and which UTC day, as two hashes per dimension, `usage:{account}:{YYYY-MM}:by:{dim}:calls`
 * and `...:usd_micro`, one field per value. A hash per account-month keeps the key list closed (`usageMonthKeys` names all
 * eight, so `wipeAccount` deletes them) however many members, brands or days there are. The field values are worked out in
 * code: a person from the session's `u.actor` (`usageWho`), a brand from the caller's own scope, a catalog model id or
 * "other", a day from the clock; never a value taken from a request.
 */
export const USAGE_DIMS = ["person", "brand", "model", "day"] as const;
export type UsageDim = (typeof USAGE_DIMS)[number];
const dimKey = (k: string, dim: UsageDim, p: "calls" | "usd_micro") => `${k}:by:${dim}:${p}`;

/**
 * Every counter one account (or `_all`) can have in one month, under `usage:{email}:{YYYY-MM}`. Built from KINDS,
 * AGENT_IDS and USAGE_DIMS, so `wipeAccount` cannot miss a counter that a new kind, agent or breakdown adds.
 */
export function usageMonthKeys(email: string, month: string): string[] {
  const k = accountKey.usage(email, month);
  return [
    ...["in", "out", "calls", "usd_micro", "cache_read", "cache_write", "chat_msgs", "chat_over", "chat_cred", "media_usd_micro"].map((p) => `${k}:${p}`),
    ...KINDS.flatMap((kind) => [`${k}:kind:${kind}`, `${k}:kind:${kind}:in`, `${k}:kind:${kind}:out`, `${k}:kind:${kind}:usd_micro`]),
    ...AGENT_IDS.flatMap((id) => [`${k}:agent:${id}:calls`, `${k}:agent:${id}:usd_micro`]),
    ...USAGE_DIMS.flatMap((d) => [dimKey(k, d, "calls"), dimKey(k, d, "usd_micro")]),
  ];
}

/**
 * The founder's ranking of accounts by what they cost this month (rule 2905): a sorted set `usage:_all:{YYYY-MM}:rank`,
 * member = account id, score = model plus render cost in micro-dollars. Global, so it is not in `usageMonthKeys`;
 * `wipeAccount` removes the account from the months it can have been in.
 */
export const usageRankKey = (month: string) => `${globalKey.usageAll(month)}:rank`;

/**
 * Who a call worked for inside its account (rule 2901). `person` is "owner", "member:{login}", "support" (a founder acting
 * through support access), "app" (a connected app's MCP token) or "system" (a cron, a routine, a script); `brand` is the
 * brand id of the caller's scope ("default" for the account's own). Both come from `usageWho`, never from a request.
 */
export type UsageWho = { person?: string; brand?: string };

/** A person or brand value as a hash field: a bounded string with no control characters, else nothing. */
const field = (v: unknown): string | undefined => (typeof v === "string" && v && v.length <= 200 && !/[\u0000-\u001f]/.test(v) ? v : undefined);

/**
 * The `UsageWho` of a call made for `u` in `scope`, from the session's actor alone (`byOf`, src/lib/actor.ts): the same
 * person an activity row names, in a form that can be a hash field. `scope` must be the caller's own (`sc(u)` or a scope from
 * our records); the brand is the part after `#`.
 */
export function usageWho(u: Pick<User, "email" | "actor">, scope?: string): UsageWho {
  const by = byOf(u as User);
  const person =
    by.kind === "member" ? (by.email ? "member:" + by.email.toLowerCase() : "member")
    : by.kind === "founder" ? "support"
    : by.kind === "token" ? "app"
    : by.kind === "owner" ? "owner"
    : "system";
  return { person, ...(scope ? { brand: brandOfScope(scope) } : {}) };
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
export async function meter(email: string | undefined, model: string, kind: Kind, usage?: TokenUsage | null, agent?: AgentId, provider?: LlmProvider, who?: UsageWho) {
  return record(email, model, kind, usage, agent, provider, true, who);
}

/**
 * One entry of `usage.iterations` (beta responses): one sampling attempt inside a single request, at its own model.
 * `model` null means the model the caller asked for. `type` is "message", "fallback_message", "advisor_message" or
 * "compaction"; every one of them is billed.
 */
export type IterationUsage = TokenUsage & { type?: string; model?: string | null };
/** A response's usage as the API bills it: the top-level counts, and with some betas every attempt in `iterations`. */
export type BilledUsage = TokenUsage & { iterations?: IterationUsage[] | null };

/**
 * What one response cost, split per model (rule 981). With `iterations` (the server-side fallback beta; also server tool
 * loops, compaction and the advisor), the top-level usage covers only the attempt that produced the message, while every
 * attempt in `iterations` is billed at its own model's rate: a declined Opus attempt and the Sonnet that answered are two
 * parts. Each part sums the iterations of one model, in order of first appearance; an entry with no model is the one the
 * request asked for (`requested`, else the reply's `model`). Without iterations (every other call) it is the top-level
 * usage at the reply's `model`, as `meter` always priced it.
 */
export function billedParts(model: string, usage: BilledUsage, requested: string = model): { model: string; usage: TokenUsage }[] {
  const it = Array.isArray(usage.iterations) ? usage.iterations.filter((x) => x && typeof x === "object") : [];
  if (!it.length) return [{ model, usage }];
  const by = new Map<string, { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>();
  for (const x of it) {
    const m = typeof x.model === "string" && x.model ? x.model : requested;
    const s = by.get(m) ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    s.input_tokens += x.input_tokens ?? 0;
    s.output_tokens += x.output_tokens ?? 0;
    s.cache_read_input_tokens += x.cache_read_input_tokens ?? 0;
    s.cache_creation_input_tokens += x.cache_creation_input_tokens ?? 0;
    by.set(m, s);
  }
  return [...by].map(([model, u]) => ({ model, usage: u }));
}

/**
 * Meters one response as billed: every part of `billedParts` at its own model's rate. The request counts as ONE call for
 * the account, the kind, the agent and the provider (the first part); each model that ran counts one call in its own
 * global model counter. Callers go through `metered` (src/lib/metered.ts), which also meters an aborted stream.
 */
export async function meterBilled(email: string | undefined, model: string, kind: Kind, usage?: BilledUsage | null, agent?: AgentId, requested?: string, who?: UsageWho) {
  if (!usage) return;
  const parts = billedParts(model, usage, requested);
  await Promise.all(parts.map((p, i) => record(email, p.model, kind, p.usage, agent, undefined, i === 0, who)));
}

/** `countCall` false: the tokens and cost of a further model in the same request, so only that model's call counter moves. */
async function record(email: string | undefined, model: string, kind: Kind, usage: TokenUsage | null | undefined, agent: AgentId | undefined, provider: LlmProvider | undefined, countCall: boolean, who?: UsageWho) {
  if (!usage) return;
  const now = new Date();
  const m = monthKey(now);
  const inp = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const out = usage.output_tokens ?? 0;
  const micro = Math.round(costUsd(model, usage) * 1e6);
  const targets = [globalKey.usageAll(m), ...(email ? [accountKey.usage(email, m)] : [])];
  const mk = `usage:_all:${m}:model:${modelKeyOf(model)}`;
  const pk = `usage:_all:${m}:provider:${PROVIDERS.includes(provider as LlmProvider) ? provider : effectiveProvider()}`;
  try {
    await Promise.all([
      ...targets.flatMap((k) => [
        db.incrby(`${k}:in`, inp),
        db.incrby(`${k}:out`, out),
        ...(countCall ? [db.incrby(`${k}:calls`, 1)] : []),
        db.incrby(`${k}:usd_micro`, micro),
        ...(countCall ? [db.incrby(`${k}:kind:${kind}`, 1)] : []),
        // Same three numbers per kind, so cost per request type per account is a read, not an estimate.
        db.incrby(`${k}:kind:${kind}:in`, inp),
        db.incrby(`${k}:kind:${kind}:out`, out),
        db.incrby(`${k}:kind:${kind}:usd_micro`, micro),
        // Prompt caching is only worth its write premium when reads follow; these two counters show whether they do.
        ...(usage.cache_read_input_tokens ? [db.incrby(`${k}:cache_read`, usage.cache_read_input_tokens)] : []),
        ...(usage.cache_creation_input_tokens ? [db.incrby(`${k}:cache_write`, usage.cache_creation_input_tokens)] : []),
        // Calls and cost per agent, so what each agent costs to run is a read, not an estimate from task counts.
        ...(isAgentId(agent) ? [...(countCall ? [db.incrby(`${k}:agent:${agent}:calls`, 1)] : []), db.incrby(`${k}:agent:${agent}:usd_micro`, micro)] : []),
      ]),
      // Global only (see above): what each model and each provider costs us, for the founder console. A model that ran
      // counts its call even when it was not the request's first part.
      db.incrby(`${mk}:calls`, 1),
      db.incrby(`${mk}:usd_micro`, micro),
      ...(countCall ? [db.incrby(`${pk}:calls`, 1)] : []),
      db.incrby(`${pk}:usd_micro`, micro),
      ...(email ? breakdownWrites(accountKey.usage(email, m), email, m, now, model, micro, countCall, who) : []),
    ]);
  } catch (e) {
    log.error("meter failed", e);
  }
}

/**
 * The account's breakdown writes for one model call (rules 2902-2905): calls and cost per person, brand, model and UTC
 * day, and the account's place in the month's cost ranking. A person or brand that is missing or malformed counts as
 * "unknown" so the four breakdowns always add up to the account's own totals. Only a call that counts (`countCall`)
 * moves the call counters, as in `record`.
 */
function breakdownWrites(k: string, account: string, m: string, now: Date, model: string, micro: number, countCall: boolean, who: UsageWho | undefined): Promise<unknown>[] {
  const fields: Record<UsageDim, string> = {
    person: field(who?.person) ?? "unknown",
    brand: field(who?.brand) ?? "unknown",
    model: modelKeyOf(model),
    day: now.toISOString().slice(0, 10),
  };
  return [
    ...USAGE_DIMS.flatMap((d) => [...(countCall ? [db.hincrby(dimKey(k, d, "calls"), fields[d], 1)] : []), db.hincrby(dimKey(k, d, "usd_micro"), fields[d], micro)]),
    ...(micro > 0 ? [db.zincrby(usageRankKey(m), micro, account)] : []),
  ];
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
    log.error("pick_reject_counter_failed");
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
/**
 * What the account's image and video renders cost us this month, in micro-dollars (rule 1531): `costUsd` of every render
 * the provider billed (a done job, and a `store_failed` one), added by `meterRender` from src/lib/media/jobs.ts. Under the
 * `usage:{email}:{YYYY-MM}` prefix, so `usageMonthKeys` and `wipeAccount` cover it; the global render counters
 * (`render:_all:*`, spec A19) are unchanged. Counted from the day this shipped: earlier months read as zero.
 */
export const mediaCostKey = (email: string, month = monthKey()) => `usage:${email}:${month}:media_usd_micro`;
/** Adds one render's cost to the account's month (whole micro-dollars, as INCRBY needs). Nothing for 0 or a bad number. */
export async function meterRender(email: string, usd: number | undefined): Promise<void> {
  if (!email || typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return;
  const micro = Math.round(usd * 1e6);
  // The render's cost also counts in the founder's ranking (rule 2905), so a media-heavy account ranks by what it costs.
  await Promise.all([db.incrby(mediaCostKey(email), micro), db.zincrby(usageRankKey(monthKey()), micro, email)]);
}
/** The trial's messages are granted once for the whole trial, not per month. Deleted with the account (`wipeAccount`). */
export const chatTrialKey = (email: string) => accountKey.chatTrial(email);

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
  const k = globalKey.usageAll(month);
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
  const k = accountKey.usage(email, month);
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

/** Calls and cost under one value of a breakdown: a member, a brand, a model id or a day. */
export type UsageSlice = { calls: number; usd: number };
export type UsageBreakdown = { month: string } & Record<UsageDim, Record<string, UsageSlice>>;

/**
 * One account's month split four ways (rule 2906): eight `hgetall` in one `Promise.all`. `account` is the caller's own
 * (`acct(u)`) or, in the founder console, an account from our records; never a value from a request. A month before this
 * shipped reads as empty.
 */
export async function getUsageBreakdown(account: string, month = monthKey()): Promise<UsageBreakdown> {
  const k = accountKey.usage(account, month);
  const raw = await Promise.all(USAGE_DIMS.flatMap((d) => [db.hgetall<number>(dimKey(k, d, "calls")), db.hgetall<number>(dimKey(k, d, "usd_micro"))]));
  const out = { month } as UsageBreakdown;
  USAGE_DIMS.forEach((d, i) => {
    const calls = raw[2 * i] ?? {}, micro = raw[2 * i + 1] ?? {};
    const slices: Record<string, UsageSlice> = {};
    for (const f of new Set([...Object.keys(calls), ...Object.keys(micro)])) slices[f] = { calls: Number(calls[f] ?? 0), usd: Number(micro[f] ?? 0) / 1e6 };
    out[d] = slices;
  });
  return out;
}

/** The month's accounts by what they cost us (model plus render), highest first, at most `limit` (rule 2905). */
export async function rankAccounts(month = monthKey(), limit = 100): Promise<{ account: string; usd: number }[]> {
  const all = await db.zrangeWithScores(usageRankKey(month));
  return all
    .sort((a, b) => b.score - a.score || a.member.localeCompare(b.member))
    .slice(0, Math.max(0, Math.min(limit, 500)))
    .map((x) => ({ account: x.member, usd: x.score / 1e6 }));
}
