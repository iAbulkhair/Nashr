/**
 * The task catalogue: which kinds of work the agents produce, what each batch costs and how many items it yields.
 *
 * This module imports NOTHING on purpose. The values live here rather than in `brand.ts` because the approval inbox,
 * the generate page, the governance page, the profile page and the reports page are client components that need them,
 * and `brand.ts` opens with `import { db } from "./db"` — so importing a price from there used to pull the Upstash
 * Redis client into five browser bundles. Keep this file free of imports and the cost stays where it belongs.
 */
export type TaskType =
  | "weekly_plan" | "social" | "article" | "whatsapp" | "ads" | "gbp" | "cart_recovery"
  | "sales_script" | "lead_qualifier" | "followup_seq"
  | "pricing_review" | "unit_economics" | "cash_forecast"
  | "gtm_plan" | "growth_experiments" | "retention_play"
  | "weekly_report" | "board_deck" | "dashboard_spec"
  | "strategy_review" | "okrs" | "decision_memo"
  | "prd" | "roadmap" | "feedback_synthesis" | "onboarding_flow";

/** Credits per batch. */
export const TASK_COST: Record<TaskType, number> = {
  weekly_plan: 1, social: 10, article: 2, whatsapp: 3, ads: 5, gbp: 3, cart_recovery: 3,
  sales_script: 4, lead_qualifier: 2, followup_seq: 3,
  pricing_review: 4, unit_economics: 3, cash_forecast: 4,
  gtm_plan: 5, growth_experiments: 4, retention_play: 4,
  weekly_report: 2, board_deck: 5, dashboard_spec: 2,
  strategy_review: 5, okrs: 3, decision_memo: 3,
  prd: 4, roadmap: 4, feedback_synthesis: 3, onboarding_flow: 3,
};
/** Items produced per batch. */
export const TASK_COUNT: Record<TaskType, number> = {
  weekly_plan: 1, social: 10, article: 1, whatsapp: 3, ads: 5, gbp: 3, cart_recovery: 5,
  sales_script: 3, lead_qualifier: 1, followup_seq: 7,
  pricing_review: 1, unit_economics: 1, cash_forecast: 1,
  gtm_plan: 1, growth_experiments: 5, retention_play: 3,
  weekly_report: 1, board_deck: 1, dashboard_spec: 1,
  strategy_review: 1, okrs: 1, decision_memo: 1,
  prd: 1, roadmap: 1, feedback_synthesis: 1, onboarding_flow: 1,
};
/** Types that get a generated image button in the inbox. */
export const IMAGE_TYPES: TaskType[] = ["social", "ads", "gbp", "whatsapp", "cart_recovery"];
/** Types that get a video button in the inbox, checked again on the server. */
export const VIDEO_TYPES: TaskType[] = ["social", "ads"];

/** Credits charged for one generated image. */
export const IMAGE_COST = 1;

/**
 * Membership test for a task type taken from a request body or from model output.
 *
 * `type in TASK_COST` is NOT this test: `in` walks the prototype chain, so "constructor", "toString", "valueOf" and
 * "__proto__" all pass it, and `TASK_COST["constructor"]` is a function rather than a number. A cost that is not a
 * number defeats every downstream comparison — `credits < cost` is false for any operand once one side is NaN — so the
 * credit gate opens at a zero balance and the balance itself is written as NaN. Same shape as `isAgentId` in ./agents.
 */
export const TASK_TYPES = Object.keys(TASK_COST) as TaskType[];
export const isTaskType = (v: unknown): v is TaskType => typeof v === "string" && (TASK_TYPES as string[]).includes(v);
