/**
 * What one batch of each task type costs us in model calls, estimated from token assumptions. Server and test only:
 * it imports usage.ts (and through it the store), and the numbers are our margins, so it never reaches a browser
 * (tests/client-bundle.test.ts lists it in SERVER_ONLY).
 *
 * The table holds TOKENS, never dollars. Every dollar comes from `costUsd` in src/lib/usage.ts, so a change to the
 * Anthropic rates there moves every estimate, and tests/pricing-floor.test.ts (rule 213) fails the build when a task's
 * cost per credit crosses the margin floor in src/lib/pricing.ts.
 *
 * Calibrated to docs/system/costs.md §3 (2026-09-27): the generation call is Opus with a cached workspace block, a
 * fresh brief and adaptive thinking; the reviewer and the judge are Sonnet. The review and judge constants are fitted
 * to reproduce that table within $0.001; they were not measured. Replace them with the founder console's `byKind`
 * averages (generate / review / judge, src/lib/usage.ts `getUsage`) after a month of real traffic.
 */
import { costUsd } from "./usage";
import { TASK_COST, TASK_COUNT, type TaskType } from "./tasks";

/** The model each call is priced at. tests/pricing-floor.test.ts checks these literals are the ones the code calls. */
export const ESTIMATE_MODELS = {
  /** src/lib/noor.ts `generate` */
  generate: "claude-opus-5",
  /** src/lib/noor.ts `critique` */
  review: "claude-sonnet-5",
  /** src/lib/judge.ts */
  judge: "claude-sonnet-5",
  /** src/lib/onboard.ts */
  onboard: "claude-opus-5",
  /** src/lib/media/prompts.ts: the prompt a render is made from */
  mediaPrompt: "claude-sonnet-5",
} as const;

export type ItemSize = "short" | "medium" | "long";
/** Output tokens per item, from the "Output tok" column of costs.md §3. */
export const ITEM_OUT_TOKENS: Readonly<Record<ItemSize, number>> = { short: 350, medium: 900, long: 2500 };

/** How long one item of each type runs. Exhaustive: a new task type does not compile until it has a size. */
export const ITEM_SIZE: Readonly<Record<TaskType, ItemSize>> = {
  social: "short", whatsapp: "short", ads: "short", gbp: "short", cart_recovery: "short",
  weekly_plan: "medium", sales_script: "medium", lead_qualifier: "medium", followup_seq: "medium",
  growth_experiments: "medium", retention_play: "medium", dashboard_spec: "medium", okrs: "medium", roadmap: "medium",
  article: "long", pricing_review: "long", unit_economics: "long", cash_forecast: "long", gtm_plan: "long",
  weekly_report: "long", board_deck: "long", strategy_review: "long", decision_memo: "long", prd: "long",
  feedback_synthesis: "long", onboarding_flow: "long",
};

/** Token assumptions per call. Tokens only; `costUsd` prices them. */
export const ASSUME = {
  /** The workspace block the generation call caches: read on a hit, written on a cold cache (a cron run, usually). */
  cachedIn: 7500,
  /** The uncached part of the generation prompt: brief, preferences, feedback. */
  freshIn: 1200,
  /** Adaptive thinking on the generation call, billed as output. */
  thinking: 1200,
  /** Reviewer: `in` + the items as input; `out` + `outShare` of the items as output. */
  review: { in: 2250, out: 500, outShare: 0.3 },
  /** Judge: `in` + the items as input; `out` + `outPerItem` per item as output. */
  judge: { in: 3000, out: 450, outPerItem: 70 },
  /** One onboarding run: three Opus calls between them (costs.md §3, ≈ $0.57). */
  onboard: { in: 13500, out: 20000 },
  /** One media prompt: a Sonnet call capped at 400 output tokens (src/lib/media/prompts.ts). */
  mediaPrompt: { in: 500, out: 400 },
} as const;

export type BatchEstimate = {
  type: TaskType;
  items: number;
  credits: number;
  /** Generation output: thinking plus the items. */
  outTokens: number;
  generateUsd: number;
  reviewUsd: number;
  judgeUsd: number;
  totalUsd: number;
  usdPerCredit: number;
};

/**
 * One batch: the generation call (fresh input, the cached block read on a hit or written when cold, thinking plus the
 * items as output), the reviewer and the judge. `items` and `credits` default to TASK_COUNT and TASK_COST; `cache`
 * defaults to "hit" (an owner working in the app). Cron-driven types are checked "cold".
 */
export function estimateBatch(type: TaskType, opts: { items?: number; credits?: number; cache?: "hit" | "cold" } = {}): BatchEstimate {
  const size = Object.prototype.hasOwnProperty.call(ITEM_SIZE, type) ? ITEM_SIZE[type] : undefined;
  const items = opts.items ?? TASK_COUNT[type];
  const credits = opts.credits ?? TASK_COST[type];
  if (!size || !Number.isInteger(items) || items < 1 || !Number.isFinite(credits) || credits <= 0) {
    throw new Error(`bad_estimate:${String(type)}:${String(items)}:${String(credits)}`);
  }
  const itemsOut = items * ITEM_OUT_TOKENS[size];
  const outTokens = ASSUME.thinking + itemsOut;
  const cached = opts.cache === "cold" ? { cache_creation_input_tokens: ASSUME.cachedIn } : { cache_read_input_tokens: ASSUME.cachedIn };
  const generateUsd = costUsd(ESTIMATE_MODELS.generate, { input_tokens: ASSUME.freshIn, output_tokens: outTokens, ...cached });
  const reviewUsd = costUsd(ESTIMATE_MODELS.review, { input_tokens: ASSUME.review.in + itemsOut, output_tokens: ASSUME.review.out + ASSUME.review.outShare * itemsOut });
  const judgeUsd = costUsd(ESTIMATE_MODELS.judge, { input_tokens: ASSUME.judge.in + itemsOut, output_tokens: ASSUME.judge.out + ASSUME.judge.outPerItem * items });
  const totalUsd = generateUsd + reviewUsd + judgeUsd;
  return { type, items, credits, outTokens, generateUsd, reviewUsd, judgeUsd, totalUsd, usdPerCredit: totalUsd / credits };
}

/** Credits a chat draft of `count` items costs: the batch price pro rata, at least 1 (the formula in src/lib/chat.ts `draft_items`). */
export const draftCredits = (type: TaskType, count: number): number => Math.max(1, Math.ceil((TASK_COST[type] / (TASK_COUNT[type] || 1)) * count));

/** A chat draft of 1-3 items (`draft_items`): the owner is in the app, so the cache is warm. */
export function estimateDraft(type: TaskType, count: 1 | 2 | 3): BatchEstimate {
  return estimateBatch(type, { items: count, credits: draftCredits(type, count), cache: "hit" });
}

/** One onboarding run in USD (≈ $0.57): what ONBOARD_EXTRA_BRAND_COST (src/lib/pricing.ts) must cover at the floor. */
export function onboardEstimateUsd(): number {
  return costUsd(ESTIMATE_MODELS.onboard, { input_tokens: ASSUME.onboard.in, output_tokens: ASSUME.onboard.out });
}

/** The Sonnet prompt a media render adds (≈ $0.005). Zero while Claude is paused; this is the upper case. */
export function mediaPromptUsd(): number {
  return costUsd(ESTIMATE_MODELS.mediaPrompt, { input_tokens: ASSUME.mediaPrompt.in, output_tokens: ASSUME.mediaPrompt.out });
}
