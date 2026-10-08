import { modelById } from "./catalog";
import { PRICED_AT, TIER_MULTIPLIER, type Surface, type Tier } from "./tiers";
import { CHAT_TURN_MAX_USD, chatOverflowHold, maxCostPerCreditUsd } from "../pricing";

/**
 * Credits by model tier (spec 2026-10-08-straitly-model-routing, section 6). SERVER AND TEST ONLY (`SERVER_ONLY` in
 * tests/client-bundle.test.ts): it reads the catalog, which holds our rates. The browser shows the multipliers from
 * `tiers.ts`, the same table this file charges from.
 *
 * The multiplier is RELATIVE TO THE SURFACE'S DEFAULT MODEL (`PRICED_AT`): the model a surface runs by default is x1, so
 * today's prices do not move, and a cheaper tier costs proportionally less. Generation (default Opus 5, premium): a
 * standard model x0.5, an economy one x0.3. Chat (default Sonnet 5.5, standard): Opus 5 x2, an economy model x0.6.
 *
 * An id that is not exactly a catalog id is priced as the surface's default (x1): never cheaper, never NaN. It cannot
 * reach a charge anyway: `generateBatch` refuses an unknown model before it reads or charges anything, and the routing
 * (plan Tasks 5 and 6) validates a stored pick before it is used. A PRICED_AT model missing from the catalog, or a surface
 * that is not one of PRICED_AT's own keys, throws: there is no safe default to price against.
 */

/** The tier that is x1 on `surface`. */
function pricedTier(surface: Surface): Tier {
  if (typeof surface !== "string" || !Object.prototype.hasOwnProperty.call(PRICED_AT, surface)) throw new Error(`unknown_surface:${String(surface)}`);
  const entry = modelById(PRICED_AT[surface]);
  if (!entry) throw new Error(`priced_at_not_in_catalog:${surface}`);
  return entry.tier;
}

/** `model`'s tier multiplier on `surface`, relative to that surface's default model. 1 for an id not in the catalog. */
export function tierMultiplier(model: string, surface: Surface): number {
  const base = pricedTier(surface);
  const tier = modelById(model)?.tier ?? base;
  return TIER_MULTIPLIER[tier] / TIER_MULTIPLIER[base];
}

/**
 * What `base` credits cost on `model`: base times the multiplier, rounded up, never less than 1. The product is rounded to
 * six decimals before rounding up, so a floating-point excess (50 x 1.1 = 55.00000000000001) is never charged as a whole
 * extra credit. A base that is not a finite number of at least 0 throws (`invalid_cost`, as `charge` does): a bad cost
 * is never charged as 1.
 */
export function creditsFor(base: number, model: string, surface: Surface): number {
  if (typeof base !== "number" || !Number.isFinite(base) || base < 0) throw new Error(`invalid_cost:${String(base)}`);
  const exact = base * tierMultiplier(model, surface);
  return Math.max(1, Math.ceil(Math.round(exact * 1e6) / 1e6));
}

/** The most one chat message on `model` may cost us in USD: CHAT_TURN_MAX_USD (Sonnet 5.5's, $0.14) times its chat multiplier. */
export function chatTurnMaxUsd(model: string): number {
  return CHAT_TURN_MAX_USD * tierMultiplier(model, "chat");
}

/**
 * How many messages of the chat allowance one message on `model` counts (coordinator ruling 2026-10-08, option a): its
 * chat multiplier rounded up, at least 1 (Sonnet 5.5 and Sonnet 5 count 1, Opus 5 counts 2, an economy model 1). Each
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
 * rounded up (2 at x1, 4 on Opus 5). The balance must cover it before the turn, and the message is billed its metered
 * cost at the floor rate, never more than this (src/lib/credits.ts `settleChatOverflow`, rule 313).
 */
export function chatHoldFor(model: string): number {
  return chatOverflowHold(maxCostPerCreditUsd(), chatTurnMaxUsd(model));
}
