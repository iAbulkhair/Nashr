import { modelById } from "./catalog";
import { PRICED_AT, TIER_MULTIPLIER, type Surface, type Tier } from "./tiers";
import { CHAT_TURN_MAX_USD, chatOverflowHold, maxCostPerCreditUsd } from "../pricing";
import { TASK_MODELS } from "../task-models";
import type { TaskType } from "../tasks";

/**
 * Credits by model tier (spec 2026-10-08-straitly-model-routing, section 6). SERVER AND TEST ONLY (`SERVER_ONLY` in
 * tests/client-bundle.test.ts): it reads the catalog, which holds our rates. The browser shows the multipliers from
 * `tiers.ts`, the same table this file charges from.
 *
 * The multiplier is RELATIVE TO THE MODEL THAT RUNS BY DEFAULT: the automatic model is x1, so today's prices do not
 * move, and a cheaper tier costs proportionally less. Chat (default Sonnet 5.5, standard, `PRICED_AT.chat`): Opus 5.5 x2,
 * an economy model x0.6. Generation is priced per task type (rule 902, 2026-10-10, founder decision): x1 is that type's
 * writer in `TASK_MODELS` (rule 901), so on a type Opus 5.5 writes a standard model is x0.5 and an economy one x0.3,
 * and on a type Sonnet 5.5 writes Opus 5.5 is x2 and an economy model x0.6. Without a task, generation is priced at
 * `PRICED_AT.generate` (Opus 5.5).
 *
 * An id that is not exactly a catalog id is priced as the surface's default (x1): never cheaper, never NaN. It cannot
 * reach a charge anyway: `generateBatch` refuses an unknown model before it reads or charges anything, and the routing
 * (plan Tasks 5 and 6) validates a stored pick before it is used. A PRICED_AT model missing from the catalog, or a surface
 * that is not one of PRICED_AT's own keys, throws: there is no safe default to price against.
 */

/**
 * The model that is x1 on `surface`: for generation with a task type that is exactly one of `TASK_MODELS`' own keys,
 * that type's writer (rule 902); otherwise the surface's `PRICED_AT` model. A task on chat is ignored.
 */
export function pricedAt(surface: Surface, task?: TaskType): string {
  if (typeof surface !== "string" || !Object.prototype.hasOwnProperty.call(PRICED_AT, surface)) throw new Error(`unknown_surface:${String(surface)}`);
  if (surface === "generate" && typeof task === "string" && Object.hasOwn(TASK_MODELS, task)) return TASK_MODELS[task].write;
  return PRICED_AT[surface];
}

/** The tier that is x1 on `surface` (for `task`, on generation). */
function pricedTier(surface: Surface, task?: TaskType): Tier {
  const id = pricedAt(surface, task);
  const entry = modelById(id);
  if (!entry) throw new Error(`priced_at_not_in_catalog:${surface}:${id}`);
  return entry.tier;
}

/**
 * `model`'s tier multiplier on `surface`, relative to the model that runs there by default (on generation with `task`,
 * that type's writer). 1 for an id not in the catalog.
 */
export function tierMultiplier(model: string, surface: Surface, task?: TaskType): number {
  const base = pricedTier(surface, task);
  const tier = modelById(model)?.tier ?? base;
  return TIER_MULTIPLIER[tier] / TIER_MULTIPLIER[base];
}

/**
 * What `base` credits cost on `model` (on generation, for task type `task`; `generateBatch` always passes it): base times the multiplier, rounded up, never less than 1. The product is rounded to
 * six decimals before rounding up, so a floating-point excess (50 x 1.1 = 55.00000000000001) is never charged as a whole
 * extra credit. A base that is not a finite number of at least 0 throws (`invalid_cost`, as `charge` does): a bad cost
 * is never charged as 1.
 */
export function creditsFor(base: number, model: string, surface: Surface, task?: TaskType): number {
  if (typeof base !== "number" || !Number.isFinite(base) || base < 0) throw new Error(`invalid_cost:${String(base)}`);
  const exact = base * tierMultiplier(model, surface, task);
  return Math.max(1, Math.ceil(Math.round(exact * 1e6) / 1e6));
}

/** The most one chat message on `model` may cost us in USD: CHAT_TURN_MAX_USD (Sonnet 5.5's, $0.14) times its chat multiplier. */
export function chatTurnMaxUsd(model: string): number {
  return CHAT_TURN_MAX_USD * tierMultiplier(model, "chat");
}

/**
 * How many messages of the chat allowance one message on `model` counts (coordinator ruling 2026-10-08, option a): its
 * chat multiplier rounded up, at least 1 (Sonnet 5.5 counts 1, Opus 5.5 counts 2, an economy model 1). Each
 * unit then carries at most CHAT_TURN_MAX_USD, the ceiling the plans' allowances were priced at (docs/system/costs.md
 * section 4.1), whatever model the owner picks. The multiplier is rounded to six decimals before rounding up, as in
 * `creditsFor`. A multiplier that is not a finite number above 0 throws (`chat_allowance_unpriced`): a message is never
 * counted as 0 or NaN. `reserveChatTurn` computes it once per turn and the settle gives back that stored count.
 */
export function chatUnitsFor(model: string): number {
  const m = tierMultiplier(model, "chat");
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) throw new Error(`chat_allowance_unpriced:${String(model)}`);
  return Math.max(1, Math.ceil(Math.round(m * 1e6) / 1e6));
}

/**
 * The most a message past the allowance on `model` can cost the owner, in credits: its own ceiling at the floor rate,
 * rounded up (2 at x1, 4 on Opus 5.5). The balance must cover it before the turn, and the message is billed its metered
 * cost at the floor rate, never more than this (src/lib/credits.ts `settleChatOverflow`, rule 313).
 */
export function chatHoldFor(model: string): number {
  return chatOverflowHold(maxCostPerCreditUsd(), chatTurnMaxUsd(model));
}
