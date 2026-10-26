import type Anthropic from "@anthropic-ai/sdk";
import { byOf } from "./actor";
import { agentById } from "./agents";
import { sc, type User } from "./auth";
import type { ToolCtx } from "./chat-gates";
import { allow, WINDOW } from "./rate";
import { wsKey } from "./keys";
import {
  createPlan,
  parsePlan,
  planAction,
  PLAN_AFTER_MAX,
  PLAN_APPROVE_DAYS,
  PLAN_BRIEF_MAX,
  PLAN_GOAL_MAX,
  PLAN_MAX_STEPS,
  PLAN_MIN_STEPS,
  PLAN_TYPES,
  PLANS_PER_DAY,
  type Plan,
  type PlanParseError,
} from "./plans";
import { v2On } from "./v2-switch";

/**
 * Majed's `make_plan` tool (Thakeen v2 phase 2, C3, rules 4623-4628). Offered only in Majed's turn and only while `PLANS`
 * is on (`toolsFor`, src/lib/chat-tools.ts), and refused here too when it is off. No separate planner model call: the plan
 * is the structured input of the lead's own chat turn, checked in code (`parsePlan`), and Thakeen sets every step's agent
 * and cost. It runs from the chat's tool call site (src/lib/chat.ts) beside `runRemember`, because `runTool` is at its size
 * limit (rule 2014); the gateway wraps both the same way.
 *
 * Code gates, not prompt rules: only Majed; never over MCP or for a token; one plan per reply (one card); at most
 * `PLANS_PER_DAY` proposals a workspace a day. It stores a proposal and nothing else: nothing runs and nothing is charged
 * until a login of the account presses Approve on the card (POST /api/plans/{id}).
 */
export const PLAN_TOOL: Anthropic.Tool = {
  name: "make_plan",
  description: `As the lead, turn a goal the owner states into a plan of ${PLAN_MIN_STEPS} to ${PLAN_MAX_STEPS} steps that run one after another once the owner approves it: each step a task type and a brief for the agent who owns it, and the earlier steps it waits for. Free, and proposing runs nothing: the owner sees a card with each step's agent and credit cost and the total, and presses Approve. Each step runs only after the steps it waits for are done and the owner approved their items. Use it for a goal that needs several connected pieces of work; for one to three independent items use propose_handoff. Never images or videos.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "steps"],
    properties: {
      goal: {
        type: "string",
        description: `The owner's goal in one line, in the owner's language, at most ${PLAN_GOAL_MAX} characters.`,
      },
      steps: {
        type: "array",
        description: `${PLAN_MIN_STEPS} to ${PLAN_MAX_STEPS} steps, in the order they should run.`,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "brief"],
          properties: {
            type: { type: "string", enum: [...PLAN_TYPES] },
            brief: {
              type: "string",
              description: `What this step should produce, in the owner's language, at most ${PLAN_BRIEF_MAX} characters. A request for work: no price, figure or claim the owner has not given.`,
            },
            after: {
              type: "array",
              items: { type: "integer", minimum: 0 },
              description: `The positions (0-based) of earlier steps this one waits for, at most ${PLAN_AFTER_MAX}. Leave out for a step that can start at once.`,
            },
          },
        },
      },
    },
  },
};

const PARSE_REFUSAL: Record<PlanParseError, string> = {
  no_goal: "Not saved: the plan needs the owner's goal in one line. Nothing was saved.",
  steps: `Not saved: a plan has ${PLAN_MIN_STEPS} to ${PLAN_MAX_STEPS} steps; for one to three independent items use propose_handoff. Nothing was saved.`,
  bad_type: "Not saved: a step's type is not one a plan can run. Nothing was saved.",
  own_type: "Not saved: a step's type is Reem's or a render, which a plan cannot run. Nothing was saved.",
  no_brief: "Not saved: every step needs a brief. Nothing was saved.",
  bad_after: `Not saved: a step may wait only for earlier steps, at most ${PLAN_AFTER_MAX}. Nothing was saved.`,
};

/** The tool result: what the card shows, so the reply states each step's agent and cost and that nothing runs before Approve. */
export function planText(p: Plan, credits: number): string {
  const lines = p.steps.map(
    (st, i) =>
      `${i + 1}. ${agentById(st.agent).name.en}: ${st.type}, ${st.cost} credits${st.after.length ? ` (after step ${st.after.map((a) => a + 1).join(", ")})` : ""}`,
  );
  return [
    `Not started: the plan is saved as a proposal and waits as a card under your reply for ${PLAN_APPROVE_DAYS} days.`,
    ...lines,
    `Total: ${p.total} credits; the balance is ${credits}. Nothing runs and nothing is charged until the owner presses Approve; each step is charged when it runs, and every item waits in the inbox for the owner.`,
    "Tell the owner plainly each step's agent and cost, the total, and that Approve starts it.",
  ].join("\n");
}

export async function runMakePlan(
  user: User,
  input: Record<string, unknown>,
  ctx: ToolCtx,
  actions: string[],
): Promise<string> {
  if (!v2On("PLANS")) return "Unknown tool.";
  if (ctx.agent !== "majed") return "Not done: only Majed, the lead, makes plans. Nothing was saved.";
  if (ctx.via === "mcp" || ctx.by?.kind === "token" || user.actor?.kind === "token")
    return "Not done: plans are made only in the app's chat. Nothing was saved.";
  if (actions.some((a) => a.startsWith("goalplan:")))
    return "Not done: this reply already carries a plan, and one reply carries one card. Nothing more was saved.";
  const d = parsePlan(input);
  if (!d.ok) return PARSE_REFUSAL[d.error];
  const s = sc(user);
  if (!(await allow(wsKey.goalPlanBucket(s), PLANS_PER_DAY, WINDOW.day)))
    return `Not saved: this workspace made ${PLANS_PER_DAY} plans today, the most a day. Nothing was saved.`;
  const p = await createPlan(s, d.draft, { requestedBy: ctx.by ?? byOf(user), conv: ctx.conv });
  actions.push(planAction(p.id));
  return planText(p, user.credits);
}
