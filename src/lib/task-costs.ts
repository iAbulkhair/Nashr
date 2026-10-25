/**
 * What one batch of each task type costs us in model calls, estimated from token assumptions. Server and test only:
 * it imports usage.ts (and through it the store), and the numbers are our margins, so it never reaches a browser
 * (tests/client-bundle.test.ts lists it in SERVER_ONLY).
 *
 * The table holds TOKENS, never dollars. Every dollar comes from `costUsd` in src/lib/usage.ts, so a change to the
 * Anthropic rates there moves every estimate, and tests/pricing-floor.test.ts (rule 241) fails the build when a task's
 * cost per credit crosses the margin floor in src/lib/pricing.ts. One app reader: Majed's auto-run starts only the
 * types whose cold-cache estimate keeps that floor (`autoUnderFloor`, src/lib/handoffs.ts, rule 296).
 *
 * Calibrated to docs/system/costs.md §3 (2026-09-27): the generation call is Opus with a cached workspace block, a
 * fresh brief and adaptive thinking; the reviewer and the judge are Sonnet. Since 2026-10-09 the calls are Opus 5.5,
 * Sonnet 5.5 and Haiku 5.5; since rule 901 the writer and the reviewer of each type come from TASK_MODELS
 * (task-models.ts, through `automaticFor` in src/lib/models/route.ts), the rest from ESTIMATE_MODELS. The token counts
 * were kept. The review and judge constants are fitted to reproduce that table within $0.001; they were not measured.
 * Replace them with the founder console's `byKind` averages (generate / review / judge, src/lib/usage.ts `getUsage`)
 * after a month of real traffic.
 */
import { costUsd } from "./usage";
import { TASK_COST, TASK_COUNT, type TaskType } from "./tasks";
import { modelById } from "./models/catalog";
import { creditsFor } from "./models/credits";
import { DEFAULTS, automaticFor } from "./models/route";

/**
 * The model each call outside the batch's writer and reviewer is priced at: what `route()` runs each purpose on by
 * default (src/lib/models/route.ts `DEFAULTS`). The writer and the reviewer are per task type (`TASK_MODELS`, rule 901,
 * read through `automaticFor`), so the estimates and the calls read one table. tests/pricing-floor.test.ts checks each
 * call site asks `route()` for its purpose, and that no model the routing can pick for the judge costs more than the one
 * priced here.
 */
export const ESTIMATE_MODELS = {
  /** src/lib/judge.ts */
  judge: DEFAULTS.judge,
  /** src/lib/onboard.ts */
  onboard: DEFAULTS.onboard,
  /** src/lib/media/prompts.ts: the prompt a render is made from */
  mediaPrompt: DEFAULTS.imagePrompt,
  /** src/lib/secretary-meeting.ts `proposeFromText`: tasks from a meeting transcript (Reem B2b) */
  meetingExtract: DEFAULTS.meeting,
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
  /**
   * One transcript extraction (rule 605): the longest allowed text, MEETING_TEXT_MAX = 40,000 Arabic characters at about 2
   * characters a token, plus the instruction and the tool schema; the answer is capped at 1,500 tokens. ESTIMATED, not
   * measured: replace with the founder console's per-kind averages after the first production runs (docs/system/costs.md).
   */
  meetingExtract: { in: 20_500, out: 1_500 },
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
 * defaults to "hit" (an owner working in the app). Cron-driven types are checked "cold". `model` is the generation
 * call's model, priced at its catalog rate: left out or undefined, the type's automatic writer (`TASK_MODELS`, the same
 * rule as `generateBatch`'s `model`); anything else must be exactly a catalog id (`bad_estimate_model`), or `costUsd`
 * would price it as Opus without saying so. The reviewer (the type's, `TASK_MODELS`) and the judge keep their own models.
 */
export function estimateBatch(type: TaskType, opts: { items?: number; credits?: number; cache?: "hit" | "cold"; model?: string } = {}): BatchEstimate {
  const size = Object.prototype.hasOwnProperty.call(ITEM_SIZE, type) ? ITEM_SIZE[type] : undefined;
  const items = opts.items ?? TASK_COUNT[type];
  const credits = opts.credits ?? TASK_COST[type];
  if (!size || !Number.isInteger(items) || items < 1 || !Number.isFinite(credits) || credits <= 0) {
    throw new Error(`bad_estimate:${String(type)}:${String(items)}:${String(credits)}`);
  }
  // Left out or undefined: the default, as `generateBatch`'s `model`; anything else must be exactly a catalog id.
  const model = opts.model === undefined ? automaticFor("generate", type) : opts.model;
  if (!modelById(model)) throw new Error(`bad_estimate_model:${String(model)}`);
  const itemsOut = items * ITEM_OUT_TOKENS[size];
  const outTokens = ASSUME.thinking + itemsOut;
  const cached = opts.cache === "cold" ? { cache_creation_input_tokens: ASSUME.cachedIn } : { cache_read_input_tokens: ASSUME.cachedIn };
  const generateUsd = costUsd(model, { input_tokens: ASSUME.freshIn, output_tokens: outTokens, ...cached });
  const reviewUsd = costUsd(automaticFor("review", type), { input_tokens: ASSUME.review.in + itemsOut, output_tokens: ASSUME.review.out + ASSUME.review.outShare * itemsOut });
  const judgeUsd = costUsd(ESTIMATE_MODELS.judge, { input_tokens: ASSUME.judge.in + itemsOut, output_tokens: ASSUME.judge.out + ASSUME.judge.outPerItem * items });
  const totalUsd = generateUsd + reviewUsd + judgeUsd;
  return { type, items, credits, outTokens, generateUsd, reviewUsd, judgeUsd, totalUsd, usdPerCredit: totalUsd / credits };
}

/**
 * One batch of `type` generated on `model`, in USD, on a COLD cache (the dearest case: a cron run, or the first ask after
 * the five-minute cache expired), at that model's catalog rate. On the default model it is exactly today's cold estimate.
 * tests/pricing-floor.test.ts divides it by the credits the model is charged (`creditsFor`, src/lib/models/credits.ts)
 * for every catalog model and every type it allows (rule 241 by tier). `undefined` is the default model; any other value
 * that is not exactly a catalog id throws.
 */
export function estimateFor(type: TaskType, model: string): number {
  return estimateBatch(type, { cache: "cold", model }).totalUsd;
}

/**
 * Credits a chat draft of `count` items costs: the batch price pro rata, at least 1. The same formula as `countCost` in
 * src/lib/generate-batch.ts, which charges the chat's `draft_items` (tests/pricing-floor.test.ts pins them equal).
 */
export const draftCredits = (type: TaskType, count: number): number => Math.max(1, Math.ceil((TASK_COST[type] / (TASK_COUNT[type] || 1)) * count));

/**
 * The fewest credits a chat draft of a type is charged, on any model (founder decision 2026-10-24, rules 4030-4034). With
 * yearly billing at 2 months free the cheapest credit is Business yearly's $0.148 and the ceiling $0.0592 ($0.0515 with
 * VAT): a one-item social or ads draft on Opus 5.5 costs $0.0605 and broke it at 1 credit, so did a one- or two-item draft
 * of those types on Sonnet 5.5 at x0.5. Two credits keep them all under it. Other types keep the pro rata price.
 */
export const DRAFT_MIN_CREDITS: Readonly<Partial<Record<TaskType, number>>> = Object.freeze({ social: 2, ads: 2 });

/**
 * What a chat draft of `count` items is charged on `model`: `draftCredits` at the model's tier (`creditsFor`, rule 902),
 * never less than the type's `DRAFT_MIN_CREDITS`. Without a model, the type's own writer (x1). The chat's `draft_items`
 * (src/lib/generate-batch.ts), a revision (src/lib/revise.ts) and an instructions test (src/lib/instructions-test.ts)
 * all charge this.
 */
export const draftCharge = (type: TaskType, count: number, model?: string): number =>
  Math.max(DRAFT_MIN_CREDITS[type] ?? 1, model ? creditsFor(draftCredits(type, count), model, "generate", type) : draftCredits(type, count));

/** A chat draft of 1-3 items (`draft_items`): the owner is in the app, so the cache is warm. */
export function estimateDraft(type: TaskType, count: 1 | 2 | 3): BatchEstimate {
  return estimateBatch(type, { items: count, credits: draftCharge(type, count), cache: "hit" });
}

/** One onboarding run in USD (≈ $0.57): what ONBOARD_EXTRA_BRAND_COST (src/lib/pricing.ts) must cover at the floor. */
export function onboardEstimateUsd(): number {
  return costUsd(ESTIMATE_MODELS.onboard, { input_tokens: ASSUME.onboard.in, output_tokens: ASSUME.onboard.out });
}

/** The Sonnet prompt a media render adds (≈ $0.005). Zero while Claude is paused; this is the upper case. */
export function mediaPromptUsd(): number {
  return costUsd(ESTIMATE_MODELS.mediaPrompt, { input_tokens: ASSUME.mediaPrompt.in, output_tokens: ASSUME.mediaPrompt.out });
}

/** The most one transcript extraction costs (≈ $0.056): what MEETING_TRANSCRIPT_COST must cover at the floor. */
export function meetingExtractUsd(): number {
  return costUsd(ESTIMATE_MODELS.meetingExtract, { input_tokens: ASSUME.meetingExtract.in, output_tokens: ASSUME.meetingExtract.out });
}
