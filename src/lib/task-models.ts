import type { TaskType } from "./tasks";

/**
 * Which model writes each task type and which reviews it (rule 901, 2026-10-09). Opus 5.5 writes what the owner decides
 * from, what touches money, and the customer-facing copy the product is sold on; Sonnet 5.5 writes the types that follow
 * a known shape or arrange what they are given. The reviewer (`critique` in noor.ts) is Sonnet 5.5 for every type today;
 * it has its own column so a type can move to an Opus reviewer by changing one cell, once the golden set shows a
 * Sonnet-written type needs it. Read by `generate` and `critique` in noor.ts and by `estimateBatch` in task-costs.ts, so
 * the margin floor test prices exactly what is called. Exhaustive: a new task type does not compile until it has a row.
 */
export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";

export type TaskModels = { readonly write: string; readonly review: string };
const opus: TaskModels = Object.freeze({ write: OPUS, review: SONNET });
const sonnet: TaskModels = Object.freeze({ write: SONNET, review: SONNET });

export const TASK_MODELS: Readonly<Record<TaskType, TaskModels>> = Object.freeze({
  // Noor: the posts and ads are the copy customers buy Thakeen for; the rest follow a known shape.
  social: opus, ads: opus,
  weekly_plan: sonnet, article: sonnet, whatsapp: sonnet, gbp: sonnet, cart_recovery: sonnet,
  // Sami
  sales_script: sonnet, lead_qualifier: sonnet, followup_seq: sonnet,
  // Razan: money and SAR/VAT arithmetic.
  pricing_review: opus, unit_economics: opus, cash_forecast: opus,
  // Faris: the go-to-market plan reasons across positioning, channels and seasons.
  gtm_plan: opus, growth_experiments: sonnet, retention_play: sonnet,
  // Dana: the board deck goes to investors; the report and the spec arrange the data they are given.
  board_deck: opus, weekly_report: sonnet, dashboard_spec: sonnet,
  // Majed: the owner decides from all three.
  strategy_review: opus, okrs: opus, decision_memo: opus,
  // Layan
  prd: sonnet, roadmap: sonnet, feedback_synthesis: sonnet, onboarding_flow: sonnet,
});
