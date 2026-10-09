import { MODELS, modelAllowsTask, modelById, type ModelEntry } from "./catalog";
import type { TaskType } from "../tasks";

/**
 * The one place that decides which model a call runs on (spec 2026-10-08-straitly-model-routing, section 4). Every call
 * that reaches a model asks `route(purpose)` for its model; no other file names one (tests/model-route-calls.test.ts).
 * SERVER AND TEST ONLY (`SERVER_ONLY` in tests/client-bundle.test.ts): it reads the catalog, which holds our rates.
 *
 * The first release keeps today's models: every purpose resolves to the model its call site used to hard-code, so nothing
 * a customer pays or receives changes. A customer's stored pick (`Conversation.model` for chat, `Brand.model` for
 * generation, read by the callers under `sc(u)` and passed as `ctx.stored`, src/lib/models/overrides.ts) can change only
 * `chat` and `generate`, and only when it passes every check below. Every other purpose is ours alone.
 *
 * Synchronous and cheap on purpose: no store, no network. The caller that already holds the customer's record passes
 * what it read; routing never reads on its own.
 *
 * AUTOMATIC CHOICES ARE WEST-HOSTED AND `auto`, CHECKED HERE. A purpose's default, and the judge's alternative, must be a
 * catalog entry with `hosting === "west"` and `auto === true`. The catalog's own validation says a China-hosted entry is
 * never `auto` (`validateCatalog`), but a data slip there must not send a customer's text to a China-hosted model that
 * nobody confirmed, so this file checks again and refuses (a default) or skips (an alternative).
 *
 * ONE DECISION PER BATCH AND PER TURN. The model a call runs on and the model its credits or messages are priced for must
 * be one value. The callers resolve once and hand the same value to both: `generateBatch` to `creditsFor` and to
 * `generate()`; the chat routes to `reserveChatTurn` and to `chat()` (the gate carries it). Do not call `route()` twice
 * for one batch or one turn and use the two answers for the two jobs.
 */
export type Purpose = "chat" | "generate" | "review" | "xreview" | "judge" | "onboard" | "imagePrompt" | "tool";

/**
 * What each purpose runs on when nobody picked. Since 2026-10-09 (rules 809 and 900, founder: only the three current
 * models) these are Opus 5.5 for writing (generation, onboarding), Sonnet 5.5 for checking and talking (reviewer,
 * cross-agent review, judge, chat) and Haiku 5.5 for the short jobs (image/video prompts, free tools). A later step gives
 * `generate` a default per task type (`TASK_MODELS`, rule 901, after the golden set): `route("generate", { task })`
 * will then take its default from that table instead of this one value.
 * `DEFAULTS.chat` and `DEFAULTS.generate` are also the models the credit multipliers are relative to (`PRICED_AT` in
 * tiers.ts; tests/model-route.test.ts pins that they are equal), and `ESTIMATE_MODELS` (src/lib/task-costs.ts) prices
 * these same ids, so the margin floor test covers what is called.
 */
export const DEFAULTS: Readonly<Record<Purpose, string>> = Object.freeze({
  chat: "claude-sonnet-5-5",
  generate: "claude-opus-5-5",
  review: "claude-sonnet-5-5",
  xreview: "claude-sonnet-5-5",
  judge: "claude-sonnet-5-5",
  onboard: "claude-opus-5-5",
  imagePrompt: "claude-haiku-5-5",
  tool: "claude-haiku-5-5",
});

/** The purposes a customer's pick may change. Everything else ignores `ctx.stored` completely. */
export const OVERRIDABLE: readonly Purpose[] = Object.freeze<Purpose[]>(["chat", "generate"]);

/**
 * Why a stored pick was not used (the default ran instead): not a catalog id, not offered to customers, China-hosted
 * without the owner's confirmation, no tool use for chat, or a generation pick not allowed to run `ctx.task` (its `tasks`
 * allow-list, set where the type misses the margin floor at the model's tier).
 */
export type Rejected = "unknown" | "not_pickable" | "china_unconfirmed" | "needs_tools" | "task_not_allowed";
export type RouteContext = {
  /**
   * The customer's stored pick for this purpose, exactly as read: any value, validated here. `undefined` or `null`:
   * nothing stored (an override that was never set, or was cleared), the default with nothing rejected.
   */
  stored?: unknown;
  /** True only when the owner confirmed using a China-hosted model; anything else is not a confirmation. */
  confirmedChina?: boolean;
  /** The model that generated the batch being judged (`judge` only): the judge will not be that model when it can avoid it. */
  generatedBy?: string;
  /** The task type of the batch (`generate` only): a pick whose `tasks` allow-list leaves it out is `task_not_allowed`. */
  task?: TaskType;
};
export type Routed = { model: string; overridden: boolean; rejected?: Rejected };

/** What automatic routing may use: offered to routing (`auto`) and hosted in the west. Both checked here, never only in the data. */
const automatic = (m: ModelEntry | undefined): m is ModelEntry => m !== undefined && m.auto === true && m.hosting === "west";

/** The purpose's default, which must still be an automatic catalog entry: a default that is not is a bug, and throws before any call is made with it. */
function defaultFor(purpose: Purpose): string {
  const id = DEFAULTS[purpose];
  if (!automatic(modelById(id))) throw new Error(`default_model_not_auto:${purpose}:${id}`);
  return id;
}

/** The four rate buckets added up: a total order for choosing among alternatives that already cost no more on any single bucket. */
const rateTotal = (r: ModelEntry["rate"]) => r.in + r.out + r.cacheRead + r.cacheWrite;

/**
 * The judge, when the default judge is the model that generated the batch: another automatic model whose rate is no higher
 * than the default judge's on EVERY bucket (so the estimate priced at the default judge, `ESTIMATE_MODELS.judge`, stays an
 * upper bound for the margin floor). The lowest total rate wins, then the first in catalog order. None: the default stays.
 */
function judgeAlternative(def: string): string {
  const base = modelById(def)!.rate;
  let best: ModelEntry | undefined;
  for (const m of MODELS) {
    if (!automatic(m) || m.id === def) continue;
    const r = m.rate;
    if (r.in > base.in || r.out > base.out || r.cacheRead > base.cacheRead || r.cacheWrite > base.cacheWrite) continue;
    if (!best || rateTotal(r) < rateTotal(best.rate)) best = m;
  }
  return best ? best.id : def;
}

/**
 * The model for `purpose`.
 *
 * - `chat` and `generate`: `ctx.stored`, when there is one and it passes, in this order: it is exactly a catalog id (a
 *   string, found by an exact lookup: prototype names and anything else are `unknown`), the entry is offered to customers
 *   (`pick`, else `not_pickable`), a model not hosted in the west needs `ctx.confirmedChina === true` (else
 *   `china_unconfirmed`), chat needs tool use (else `needs_tools`; generation calls no tools), and generation with
 *   `ctx.task` needs the pick to be allowed that type (`modelAllowsTask`, else `task_not_allowed`). A rejected pick
 *   returns the default with `overridden: false` and says why in `rejected`; the caller tells the owner.
 *   `undefined` and `null` are nothing stored: the default, nothing rejected.
 * - `judge`: the default, or when that is `ctx.generatedBy`, an automatic alternative that costs no more (`judgeAlternative`).
 * - every other purpose: the default. `ctx` is ignored.
 *
 * Throws only for something that is not a normal call: a purpose that is not one of the eight, or a default that is no
 * longer an automatic catalog entry.
 */
export function route(purpose: Purpose, ctx: RouteContext = {}): Routed {
  if (typeof purpose !== "string" || !Object.hasOwn(DEFAULTS, purpose)) throw new Error(`unknown_purpose:${String(purpose)}`);
  const model = defaultFor(purpose);
  if (purpose === "judge") return { model: ctx.generatedBy === model ? judgeAlternative(model) : model, overridden: false };
  if (ctx.stored === undefined || ctx.stored === null || !OVERRIDABLE.includes(purpose)) return { model, overridden: false };
  const reject = (rejected: Rejected): Routed => ({ model, overridden: false, rejected });
  const pick = modelById(ctx.stored);
  if (!pick) return reject("unknown");
  if (!pick.pick) return reject("not_pickable");
  if (pick.hosting !== "west" && ctx.confirmedChina !== true) return reject("china_unconfirmed");
  if (purpose === "chat" && !pick.caps.tools) return reject("needs_tools");
  if (purpose === "generate" && ctx.task !== undefined && !modelAllowsTask(pick, ctx.task)) return reject("task_not_allowed");
  return { model: pick.id, overridden: true };
}
