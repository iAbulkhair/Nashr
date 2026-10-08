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

/**
 * The model whose tier defines x1 on each surface: a task or a message on another model costs its base credits times
 * `TIER_MULTIPLIER[its tier] / TIER_MULTIPLIER[this model's tier]` (src/lib/models/credits.ts), so the model each surface
 * runs by default keeps today's prices. Generation is priced at Opus 5 (premium), so a standard model is x0.5 there; chat
 * at Sonnet 5.5 (standard), so Opus 5 is x2 there. These are the models the code calls today (tests/model-credits.test.ts
 * pins them against `CHAT_MODEL` and `ESTIMATE_MODELS.generate`); Task 5 asserts that the `route()` defaults equal them.
 * Ids only, no rates: the browser may read this file.
 */
export const PRICED_AT = Object.freeze({ chat: "claude-sonnet-5-5", generate: "claude-opus-5" } as const);
export type Surface = keyof typeof PRICED_AT;
