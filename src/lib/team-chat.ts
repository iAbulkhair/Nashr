import type Anthropic from "@anthropic-ai/sdk";
import { AGENTS, agentById, isAgentId, type AgentId } from "./agents";
import type { User } from "./auth";
import type { ToolCtx } from "./chat-gates";
import { entitlements } from "./entitlements";
import { v2On } from "./v2-switch";

/**
 * Team chat and one task owner (Thakeen v2 phase 3, C4 + C12, rules 4730-4759). One thread, several agents: the thread's
 * owner answers unless the person writes @Name, and a named agent who is not the owner joins with notes only. Every gate
 * here is code, not prompt text: the agent is picked from the person's own message, the note-taker is offered no tool that
 * drafts, spends, publishes or changes the brand (and is refused one it names anyway), and ownership moves only through
 * PUT /api/conversations, which a person's press on the card sends. Off (`TEAM_CHAT`), nothing here changes a turn.
 */

/** A turn's place in a team thread: the agent who answers, the thread's owner and whether the answerer is that owner. */
export type TeamTurn = { agent: AgentId; owner: AgentId; role: "owner" | "note" };

/** How a name is compared: lower case, no Arabic diacritics or tatweel, alef forms folded. */
const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه");
const NAMES: ReadonlyMap<string, AgentId> = new Map(
  AGENTS.flatMap((a) => [a.id, a.name.ar, a.name.en].map((n) => [fold(n), a.id] as [string, AgentId])),
);

/**
 * The agent the person named with @: the first `@word` of the message that is an agent's id or its Arabic or English
 * name, or null. Read from the person's own message only; a tool result, file or crawled page never routes a turn.
 */
export function mentionOf(text: string): AgentId | null {
  for (const m of text.matchAll(/(?:^|[\s(])@([\p{L}\p{M}_]{2,20})/gu)) {
    const id = NAMES.get(fold(m[1]));
    if (id) return id;
  }
  return null;
}

/**
 * Who answers this turn (rule 4731). Off: the agent the page named, as before. On: the thread's stored owner (absent on
 * every thread before this release: the page's agent), or the agent the person named with @. The record is the caller's
 * own conversation, read under `sc(u)`; nothing in the request names the owner.
 */
export function teamRoute(text: string, requested: AgentId, record: { owner?: unknown } | null): TeamTurn {
  if (!v2On("TEAM_CHAT")) return { agent: requested, owner: requested, role: "owner" };
  const owner = isAgentId(record?.owner) ? record.owner : requested;
  const agent = mentionOf(text) ?? owner;
  return { agent, owner, role: agent === owner ? "owner" : "note" };
}

/**
 * The tools a note-taker keeps (rule 4734): reading only. Everything else (drafts, images, publishing, brand and file
 * changes, plans, handoffs, cards) belongs to the owner, so two agents never produce competing drafts of one request.
 */
export const NOTE_TOOLS: ReadonlySet<string> = new Set(["read_file", "list_inbox", "free_slots"]);

/** What a note-taker reads when it names a tool it was not offered (rule 4735). Nothing ran. */
export const noteRefusal = (owner: AgentId) =>
  `Not done: ${agentById(owner).name.en} owns this request in this thread, so you add notes only. Nothing ran.`;

/** Whether a turn may run this tool: always outside a team thread, and only `NOTE_TOOLS` for a note-taker. */
export const teamAllows = (team: TeamTurn | undefined, name: string): boolean =>
  !team || team.role === "owner" || NOTE_TOOLS.has(name);

/**
 * The owner's card tool (rules 4737-4741): propose bringing another agent in for a note, or handing them the request.
 * It calls no one and moves nothing: it puts one card under the reply, and only the person's press acts on it.
 */
export const TEAMMATE_TOOL: Anthropic.Tool = {
  name: "propose_teammate",
  description:
    "Propose that the person brings another agent into this thread. With hand_over false (the default) the card offers to ask that agent for a note; with hand_over true it offers to make that agent the owner of this request from now on. It runs nothing and moves nothing: the person presses the card. Use it when another agent's skill fits the request better or should check it. One card a reply. Free.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["agent"],
    properties: {
      agent: { type: "string", enum: AGENTS.map((a) => a.id), description: "The agent to bring in." },
      hand_over: { type: "boolean", description: "true to offer handing them the request; false to ask for a note." },
    },
  },
};

/** The tools of a team turn: the note-taker's reading tools, or the owner's list plus the card tool. Off: unchanged. */
export function teamTools(tools: Anthropic.Tool[], team: TeamTurn | undefined): Anthropic.Tool[] {
  if (!v2On("TEAM_CHAT") || !team) return tools;
  if (team.role === "note") return tools.filter((t) => NOTE_TOOLS.has(t.name));
  return [...tools, TEAMMATE_TOOL];
}

/**
 * `propose_teammate` (rules 4738-4741): checked in code, then one `team:ask:{id}` or `team:owner:{id}` action, which
 * `turnParts` turns into the card. Refused off, over MCP (no card can be shown), for the note-taker, for the owner
 * itself, for an agent the plan does not include, and after the reply's first card.
 */
export function runTeammate(user: User, input: Record<string, unknown>, ctx: ToolCtx, actions: string[]): string {
  if (!v2On("TEAM_CHAT") || !ctx.team) return "Not done: team chat is not available. Nothing was proposed.";
  if (ctx.via === "mcp") return "Not done: a teammate card can only be shown in the app. Nothing was proposed.";
  if (ctx.team.role !== "owner") return noteRefusal(ctx.team.owner);
  const id = input.agent;
  if (!isAgentId(id)) return "Not done: name one of the agents. Nothing was proposed.";
  if (id === ctx.team.owner) return "Not done: you already own this request. Nothing was proposed.";
  if (!entitlements(user).agents.includes(id)) return "Not done: that agent is not in this plan. Nothing was proposed.";
  if (actions.some((a) => a.startsWith("team:"))) return "Not done: one teammate card a reply. Nothing was proposed.";
  const hand = input.hand_over === true;
  actions.push("team:" + (hand ? "owner" : "ask") + ":" + id);
  return hand
    ? `A card asks the person whether ${agentById(id).name.en} should own this request. Nothing moved yet.`
    : `A card offers the person to ask ${agentById(id).name.en} for a note. No one was called.`;
}

/** The owner a team turn's reply carries (rule 4742): the thread's owner, shown beside the answering agent. Off: none. */
export const ownerOf = (team: TeamTurn | undefined): { owner?: AgentId } =>
  v2On("TEAM_CHAT") && team ? { owner: team.owner } : {};

/** The prompt line of a team turn (rule 4736): a guide for the model; the gates above are what hold. */
export function teamNote(team: TeamTurn | undefined, lang: "ar" | "en"): string {
  if (!v2On("TEAM_CHAT") || !team) return "";
  const owner = agentById(team.owner).name[lang];
  return team.role === "note"
    ? `\n\nTeam thread: the person named you in a thread that ${owner} owns. Give your notes on the request in a few lines, as a reviewer. Do not write the deliverable yourself and do not promise to; ${owner} drafts it.`
    : "\n\nTeam thread: you own the requests in this thread. Another agent may add notes when the person names them with @. When another agent's skill fits better, use propose_teammate; never hand work over on your own.";
}
