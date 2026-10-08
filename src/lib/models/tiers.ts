/**
 * The three price tiers of a model (spec 2026-10-08-straitly-model-routing, section 3) and what each does to the credits
 * a task costs. Import-free on purpose (pinned in tests/client-bundle.test.ts): the model picker is a client component
 * and shows the multiplier, and the server computes the charge from this same table, so the two cannot disagree.
 * The catalog next to it (`catalog.ts`) holds our per-model rates and stays server-only.
 */
export const TIERS = ["economy", "standard", "premium"] as const;
export type Tier = (typeof TIERS)[number];

/** Credits a task costs on a model of this tier, as a multiple of the task's base credits. Standard is today's price. */
export const TIER_MULTIPLIER: Readonly<Record<Tier, number>> = Object.freeze({ economy: 0.6, standard: 1, premium: 2 });

/** True for exactly the three tier names (an own key: "constructor" and "__proto__" are not tiers). */
export const isTier = (x: unknown): x is Tier => typeof x === "string" && Object.prototype.hasOwnProperty.call(TIER_MULTIPLIER, x);
