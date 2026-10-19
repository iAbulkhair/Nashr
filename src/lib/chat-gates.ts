/**
 * The chat: the code-side checks a tool call passes before it acts (role, spend, agent cap, batch refusal) and the per-call context (`ToolCtx`).
 */
import { agentById, type AgentId } from "./agents";
import { ModelPaused } from "./model";
import { sc, type User } from "./auth";
import type { TaskType } from "./tasks";
import type { BatchRefusal } from "./generate-batch";
import type { BrandProposal } from "./brand-proposals";
import { byOf, type By } from "./actor";
import type { AwayProposal } from "./secretary-away";
import type { InstructionProposal } from "./instruction-proposals";
import type { FileProposal } from "./file-proposals";
import type { Action } from "./roles";
import { spendIntent } from "./spend-intent";
import { fairUseText } from "./fair-use";
import { SPEND_CARDS_PER_REPLY, proposeSpend, type SpendProposal } from "./spend-proposals";
import { AgentScopeRefused, logAgentScope, readAgentScopeModes, roleOwner, roleRefusalText, type AgentScopeModes } from "./agent-scope";
import { creditWord } from "./chat-tools";

/**
 * Layer 3, the role gate (rule 798; spec section 6): in a turn where an agent is talking, generate_content and draft_items for a
 * type another agent owns (`roleOwner`) are decided here, in code, before `generateBatch` is reached, so a refusal creates nothing and
 * charges nothing. Returns the tool result to hand the model, or null when the call goes ahead.
 * - Majed, the lead, is always refused, in every mode and without a switch card (R7): he proposes the work with propose_handoff.
 *   His rule is the product's, not the founder's layer, so it reads no mode and logs nothing.
 * - Every other agent follows the founder's `role` mode (the turn's copy in `ctx.modes`, else read once, and only when the type is
 *   somebody else's): `off` goes ahead; `shadow` writes one `wrong_agent` line (the owner's brief cut to the log's 200 characters)
 *   and goes ahead; `enforce` pushes `switch:{owner}` (the reply's button, `turnParts`) and answers with the refusal that tells the
 *   agent to name the owner of the work.
 */
export async function roleGate(user: User, ctx: ToolCtx, type: TaskType, notes: string, actions: string[]): Promise<string | null> {
  const agent = ctx.agent;
  const owner = roleOwner(agent, type);
  if (!agent || !owner) return null;
  if (agent === "majed") return roleRefusalText("majed", type);
  const mode = (ctx.modes ?? (await readAgentScopeModes())).role;
  if (mode === "off") return null;
  if (mode === "enforce") {
    actions.push(`switch:${owner}`);
    return roleRefusalText(agent, type);
  }
  await logAgentScope({ email: user.email, brandId: user.brandId ?? "default", agent, layer: "role", where: "tool", verdict: "wrong_agent", mode: "shadow", text: `${type}: ${notes}` });
  return null;
}
/** The turn's modes for the batch, when the turn has them: `generateBatch` then reads none of its own (the prompt flag, rule 797). */
export const scopeOf = (ctx: ToolCtx): { agentScope?: AgentScopeModes } => (ctx.modes ? { agentScope: ctx.modes } : {});

/**
 * The spend gate (rules 1510-1511): a tool that spends credits runs straight away only when the owner's own latest message
 * asked for paid work in words (`spendIntent`, src/lib/spend-intent.ts). That message is `ctx.ownerMsg`, the text chat()
 * saved for this turn: never a tool result, a file, a crawled page or the model's words, all of which reach the model.
 * Otherwise nothing runs and nothing is charged: in the app the spend is stored as a card the owner runs with one tap
 * (src/lib/spend-proposals.ts), at most `SPEND_CARDS_PER_REPLY` a reply; over MCP, where no card can be shown, it is
 * refused. A call outside a chat turn (no `ownerMsg`: tests, the onboarding run) keeps its answer. Null: run the tool.
 */
export async function spendGate(user: User, ctx: ToolCtx, actions: string[], p: Omit<SpendProposal, "id" | "at" | "by">): Promise<string | null> {
  if (ctx.ownerMsg === undefined || spendIntent(ctx.ownerMsg, p.kind === "image" ? "image" : "content")) return null;
  const what = p.kind === "image" ? `an image for "${p.title ?? ""}"` : p.kind === "draft" ? `${p.count ?? 1} ${p.type} draft(s)` : `a ${p.type} batch`;
  if (ctx.via === "mcp" || !ctx.spendProposed) return `Not done: this would spend about ${creditWord(p.credits)} on ${what}, and the person's latest message did not ask for paid work in words. Nothing was created and no credits were used. Politely ask them, in their language, to say plainly what to make (for example "write 3 posts about the new menu"), then call again.`;
  if (ctx.spendProposed.length >= SPEND_CARDS_PER_REPLY) return `Not done: this reply already carries ${SPEND_CARDS_PER_REPLY} cards waiting for the owner's Run. Nothing was created and no credits were used. Do not propose more paid work in this reply.`;
  const prop = await proposeSpend(sc(user), { ...p, by: ctx.by ?? byOf(user) });
  ctx.spendProposed.push(prop);
  actions.push(`spendprop:${prop.id}`);
  return `Not started: the owner's latest message did not ask for paid work in words, so nothing ran and no credits were used. A card under your reply offers ${what} for about ${creditWord(p.credits)}; the owner runs it with one tap, or dismisses it. Tell the owner politely, in their language and in one sentence, that the card is waiting for their Run, and do not call a paid tool again for this in this reply.`;
}

/** The tool result when an agent's monthly cap stops a charge: a plain sentence for the model to relay. */
export function capReached(r: { agent: AgentId; spent: number; cap: number }): string {
  return `Not done: ${agentById(r.agent).name.en} reached the monthly credit cap the owner set for this agent in Governance (${r.spent} of ${r.cap} credits this month), so nothing was created and no credits were used. Tell the owner plainly: they can raise the cap on the Governance page or wait for next month. Chat itself is not counted.`;
}

/**
 * A batch that did not run, as the tool result the model relays, with the `limit:*` action that raises the app's limit
 * dialog. A failed generation was already refunded; it is thrown into the turn, which hands the model the error. A batch
 * whose items the output check refused in `enforce` (rule 801, `AgentScopeRefused`) was refunded too, and is relayed as a
 * plain "not done" with the refusal the owner reads.
 */
export function batchRefused(r: BatchRefusal, actions: string[], lowCredits: (need: number, have: number) => string): string {
  switch (r.reason) {
    case "no_brand": return "No brand file yet. Ask the owner to run onboarding.";
    case "trial_over": actions.push("limit:trial"); return "Trial ended. Owner must subscribe from the Subscription page.";
    // The fair-use stop (rule 1723): nothing was made or charged; the app raises its dialog.
    case "fair_use": actions.push("limit:fair_use"); return fairUseText();
    case "missing_data": return "No abandoned-cart data yet, so nothing was created and no credits were used. Tell the owner to connect Salla or Shopify on the Integrations page and press Sync on the Reports page, then ask again.";
    case "agent_cap": actions.push("limit:agent_cap"); return capReached(r);
    case "no_credits": actions.push("limit:credits"); return lowCredits(r.need, r.credits);
    // Never answered to chat (its turn is the gate while paused); thrown as generate() would throw it.
    case "paused": throw new ModelPaused();
    case "failed":
      if (r.error instanceof AgentScopeRefused) return `Not done: ${r.error.reply} Nothing was saved and the credits were refunded.`;
      throw r.error;
  }
}

/**
 * Tools that change what the whole account publishes or knows, gated by the acting person's role exactly like the
 * route that does the same thing (src/lib/roles.ts): the brand form, the publish button, the catalog import. Checked
 * here in code, so asking Noor — in the app or over MCP — is never a way around the route's gate. A user with no actor
 * (nothing resolved who is acting) is refused, like every role check.
 */
export const TOOL_ACTION: Readonly<Record<string, Action>> = { update_brand: "brand.write", publish_item: "publish", import_catalog: "catalog.import", propose_meeting_tasks: "todo.write" };

/**
 * The turn a tool runs in: the talking agent, who is talking (for the activity log), whether the turn came over MCP
 * (`via: "mcp"`: publishing, core-memory writes and handoff and away proposals are refused), where a brand-change
 * proposal (`proposed`) and an away proposal (`awayProposed`, Reem's contact_away) are collected for the turn's reply
 * cards, and, for a handoff (src/lib/handoffs.ts), the turn's own message (`ownerMsg`) and its conversation (`conv`).
 */
export type ToolCtx = { lang?: "ar" | "en"; agent?: AgentId; by?: By; via?: "app" | "mcp"; proposed?: BrandProposal[]; awayProposed?: AwayProposal[]; instructionProposed?: InstructionProposal[]; /** core-file rewrites held for the owner's Apply this turn (rule 2306, src/lib/file-proposals.ts) */ fileProposed?: FileProposal[]; /** paid work proposed on a card this turn because the owner's message did not ask for it (rule 1511) */ spendProposed?: SpendProposal[]; ownerMsg?: string; conv?: string; /** the founder's agent-scope modes for this turn (the preflight's copy): the role layer and the prompt flag for the batch */ modes?: AgentScopeModes };
/** Brand-change cards one reply carries at most: update_brand refuses a further proposal rather than save one with no card. */
export const BRAND_CARDS_PER_REPLY = 5;
/** Away cards one reply carries at most: the turn's further contact_away calls are refused, not dropped from view. */
export const AWAY_CARDS_PER_REPLY = 5;
/** Instruction cards one reply carries at most (spec 7): a further propose_instruction is refused in its answer, with no card. */
export const INSTRUCTION_CARDS_PER_REPLY = 2;
/** Core-file cards one reply carries at most (rule 2306): a further rewrite of core memory is refused in its answer, with no card. */
export const FILE_CARDS_PER_REPLY = 2;

/** The refusal another agent's turn reads for one of Reem's own tools (rules 607 and 919); the same words as the tool's gate below. */
export const REEM_ONLY_REFUSAL: Readonly<Record<string, string>> = {
  free_slots: "Not done: only Reem looks up open meeting times. Ask Reem; nothing was read.",
  propose_meeting_tasks: "Not done: only Reem proposes a meeting's follow-up tasks. Nothing was stored.",
};
