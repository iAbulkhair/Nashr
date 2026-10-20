import { AGENT_IDS, isAgentId, type AgentId } from "./agents";

/**
 * Agent tool authority (rules 2430-2439): what each agent may do from a conversation, set by the owner on the Governance
 * page and enforced in code. The idea is OpenDots' per-agent tool switches ("Enabled" and "Ask first", CopilotKit/OpenDots
 * src/client/ConnectionsSection.tsx), fitted to Thakeen: the switches group the chat tools that act into five
 * capabilities, and "ask" reuses the spend card (src/lib/spend-proposals.ts) instead of a second approval system.
 *
 * - `on` (the default, and the only value never stored): the tool runs under its usual gates.
 * - `ask`: the tool never runs from the model's call. It leaves a card the owner runs or dismisses, whatever the
 *   owner's message said; over MCP, where no card shows, it is refused. Only for the paid capabilities.
 * - `off`: the tool is not offered in that agent's turn (`toolsFor`), and a call that names it anyway is refused in
 *   `runTool` from the setting read at the moment of the call, so a change saved mid-turn holds for the next call.
 *
 * Reading tools (files, the inbox, the to-do list), proposals that already wait for a person's Save (brand, instruction,
 * away, handoff) and the secretary's tools are not here: none of them acts on the account by itself. The setting is
 * keyed by the agent who is talking, never by a request field: `ctx.agent` is set by chat() from the route's checked id.
 */
export const TOOL_CAPS = ["produce", "images", "files", "publish", "catalog"] as const;
export type ToolCap = (typeof TOOL_CAPS)[number];
export type AuthorityMode = "on" | "ask" | "off";
/** The value a stored policy may hold for one capability: `on` is the absence of a value. */
export type StoredMode = Exclude<AuthorityMode, "on">;
export type ToolPolicy = Partial<Record<AgentId, Partial<Record<ToolCap, StoredMode>>>>;

/** The chat tools each capability governs. Pinned in tests/tool-authority.test.ts against the tools that exist. */
export const CAP_TOOLS: Readonly<Record<ToolCap, readonly string[]>> = {
  produce: ["generate_content", "draft_items"],
  images: ["generate_image"],
  files: ["write_file"],
  publish: ["publish_item"],
  catalog: ["import_catalog"],
};
/** The capabilities that may be set to `ask`: the ones with a card that runs exactly the stored request (the spend card). */
export const ASKABLE: readonly ToolCap[] = ["produce", "images"];

const TOOL_CAP: Readonly<Record<string, ToolCap>> = Object.fromEntries(TOOL_CAPS.flatMap((c) => CAP_TOOLS[c].map((t) => [t, c])));
/** The capability a chat tool belongs to, or null for a tool the policy does not govern. */
export const capOfTool = (tool: string): ToolCap | null => (Object.hasOwn(TOOL_CAP, tool) ? TOOL_CAP[tool] : null);
export const isToolCap = (v: unknown): v is ToolCap => typeof v === "string" && (TOOL_CAPS as readonly string[]).includes(v);

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** One agent's mode for one capability. A missing, malformed or no-longer-allowed value reads as `on`, today's behaviour. */
export function authorityOf(policy: unknown, agent: AgentId, cap: ToolCap): AuthorityMode {
  const row = isObj(policy) ? policy[agent] : undefined;
  const v = isObj(row) ? row[cap] : undefined;
  if (v === "off") return "off";
  if (v === "ask" && ASKABLE.includes(cap)) return "ask";
  return "on";
}

/**
 * A policy from storage or a request, checked: agent ids and capabilities only, `ask` only where it is allowed, `on`
 * dropped (it is the default). `patch` entries win over `cur`; a patch value of `on`, `null` or "" puts that
 * capability back to the default. Anything else is dropped, never guessed at.
 */
export function mergePolicy(cur: unknown, patch: unknown): ToolPolicy {
  const out: ToolPolicy = {};
  const put = (agent: AgentId, cap: ToolCap, v: unknown) => {
    const row = (out[agent] ??= {});
    if (v === "off" || (v === "ask" && ASKABLE.includes(cap))) row[cap] = v;
    else delete row[cap];
  };
  for (const src of [cur, patch]) {
    if (!isObj(src)) continue;
    for (const [a, row] of Object.entries(src)) {
      if (!isAgentId(a) || !isObj(row)) continue;
      for (const [c, v] of Object.entries(row)) if (isToolCap(c) && (src === cur ? v === "ask" || v === "off" : v === "on" || v === null || v === "" || v === "ask" || v === "off")) put(a, c, v);
    }
  }
  for (const a of Object.keys(out) as AgentId[]) if (!Object.keys(out[a] ?? {}).length) delete out[a];
  return out;
}

/** Every agent and capability with its mode, `on` included: what a restore sends so nothing set since is left behind. */
export const fullPolicy = (policy: unknown): Record<AgentId, Record<ToolCap, AuthorityMode>> =>
  Object.fromEntries(AGENT_IDS.map((a) => [a, Object.fromEntries(TOOL_CAPS.map((c) => [c, authorityOf(policy, a, c)]))])) as Record<AgentId, Record<ToolCap, AuthorityMode>>;

/** The tool result when the owner switched a capability off for the talking agent. Nothing ran before it. */
export const offRefusal = (agentName: string, tool: string) =>
  `Not done: the owner switched off ${tool} for ${agentName} in Governance (what each agent may do), so nothing was run, created, charged or changed. Tell the owner plainly, in their language, that this is off for you, and that they can switch it on in Governance or ask the teammate it is on for. Do not try another tool to get around it.`;

/**
 * The prompt line for one agent's turn, or "" when nothing is limited: the prompt names these tools elsewhere, so a turn
 * without them says why rather than promising work it cannot start. Prompt text only explains; the gates are in code.
 */
export function policyNote(policy: unknown, agent: AgentId): string {
  const off = TOOL_CAPS.filter((c) => authorityOf(policy, agent, c) === "off").flatMap((c) => CAP_TOOLS[c]);
  const ask = TOOL_CAPS.filter((c) => authorityOf(policy, agent, c) === "ask").flatMap((c) => CAP_TOOLS[c]);
  if (!off.length && !ask.length) return "";
  const lines = [
    off.length ? `- Switched off for you by the owner: ${off.join(", ")}. You do not have these tools in this workspace; say so plainly when asked, and name the Governance page where the owner can switch them on.` : "",
    ask.length ? `- Ask first, set by the owner: ${ask.join(", ")}. Calling them never runs them: each call leaves a card under your reply that the owner runs or dismisses. Say so in one line.` : "",
  ].filter(Boolean);
  return `\n\nOWNER'S TOOL AUTHORITY:\n${lines.join("\n")}`;
}
