import { randomUUID } from "node:crypto";
import type { AgentId } from "./agents";
import { acct } from "./account-id";
import { sc, type User } from "./auth";
import { TOOL_ACTION } from "./chat-gates";
import { toolsFor } from "./chat-tools";
import { db } from "./db";
import { getGov } from "./governance";
import { wsKey, type Scope } from "./keys";
import { log } from "./log";
import { can, type Action } from "./roles";
import { WEB_SEARCH_TOOL } from "./research";
import { currentRunId, runEvent } from "./runs";
import { authorityOf, capOfTool, type AuthorityMode } from "./tool-authority";
import { GATEWAY_MODE, type GatewayMode } from "./v2-flags";

/**
 * The action gateway (Thakeen v2 component C1, rules 4500-4509, docs/system/flows.md "Action gateway").
 *
 * One place that answers "may this action run, and who started it": a person, an agent in a chat turn, a routine or a
 * connected app over MCP. Today the answer is spread over each tool's own gates (`runTool` in src/lib/chat-run-tool.ts,
 * the MCP route, `publishOnce`). Phase 0 adds the gateway beside them, in log mode only: each chat tool call and each MCP
 * tool call is judged by `decide`, the verdict is written to the workspace's audit list before the call runs, the call
 * then runs exactly as before, and its outcome is written after. A row with `mismatch` is a call the old path ran that the
 * gateway would have refused: the evidence phase 4 needs before the gateway may enforce anything.
 *
 * The gateway never blocks in this release and never changes a tool's answer. It is the code that approves, never the
 * model: every input to `decide` is read here from the session user and stored settings, none from the model's words.
 */

export type Initiator = "person" | "agent" | "routine" | "mcp";
export type Verdict = "allow" | "ask" | "deny";
export type Decision = { verdict: Verdict; rule: string };

export type GateInput = {
  tool: string;
  initiator: Initiator;
  /** The tool exists for this caller: offered to the talking agent this turn, or an MCP tool of the server's list. */
  offered: boolean;
  /** The session's role allows the tool's action (`can`, src/lib/roles.ts). */
  roleOk: boolean;
  /** The owner's tool authority for the agent and the tool's capability (src/lib/tool-authority.ts); "on" when none applies. */
  authority: AuthorityMode;
};

/** Tools a connected app never runs, whatever its token's role: the words come from another assistant. */
export const MCP_NEVER: ReadonlySet<string> = new Set(["publish_item", "handoff_note"]);
/** Tools whose effect leaves Thakeen and cannot be taken back: they run only on an item a person approved. */
export const IRREVERSIBLE: ReadonlySet<string> = new Set(["publish_item"]);

const deny = (rule: string): Decision => ({ verdict: "deny", rule });
const ask = (rule: string): Decision => ({ verdict: "ask", rule });

/**
 * The policy table, first match wins. Pure: the same input gives the same verdict, so a test pins every row. "ask" means
 * a person's yes must exist before the effect: the authority setting's card, or for an irreversible tool the person's
 * approval on the item itself, which the old path checks on the stored item.
 */
export function decide(i: GateInput): Decision {
  if (!i.offered) return deny("not_offered");
  if (!i.roleOk) return deny("role");
  if (i.initiator === "mcp" && MCP_NEVER.has(i.tool)) return deny("mcp_never");
  if (i.authority === "off") return deny("authority_off");
  if (IRREVERSIBLE.has(i.tool)) return ask("person_approved_item");
  if (i.authority === "ask") return ask("authority_ask");
  return { verdict: "allow", rule: "default" };
}

export type Outcome = "ran" | "refused" | "error";

/** The audit list's rows: a `check` row is written before the call, its `done` row after. Names only, never text. */
export type AuditRow =
  | {
      phase: "check";
      id: string;
      at: string;
      tool: string;
      initiator: Initiator;
      agent?: AgentId;
      verdict: Verdict;
      rule: string;
      run?: string;
    }
  | { phase: "done"; id: string; at: string; outcome: Outcome; mismatch: boolean };

/** Rows one workspace keeps, newest first (two per call). */
export const AUDIT_KEEP = 1000;
export const AUDIT_TTL_S = 30 * 86400;

/**
 * The words every tool refusal in `runTool` starts with. Log mode only reads them to tell "ran" from "refused" for the
 * audit row; a tool's answer is never changed by them. A refusal worded otherwise is counted as "ran", which can only add
 * a mismatch row to look at, never hide one.
 */
const REFUSED = /^(Not |Unknown tool|Unknown type|Cannot |Insufficient credits|Item not found)/;
export const refusedAnswer = (answer: string): boolean => REFUSED.test(answer);

/** A call the gateway would refuse that the old path ran. */
export const isMismatch = (verdict: Verdict, outcome: Outcome): boolean => verdict === "deny" && outcome === "ran";

async function pushAudit(scope: Scope, row: AuditRow): Promise<void> {
  const key = wsKey.audit(scope);
  try {
    await db.lpush(key, JSON.stringify(row));
    await Promise.all([db.ltrim(key, AUDIT_KEEP), db.expire(key, AUDIT_TTL_S)]);
  } catch (e) {
    log.error("gateway audit write failed", e);
  }
}

/** The newest rows of a workspace's audit list, parsed; a row that does not parse is skipped. */
export async function readAudit(scope: Scope, n = 100): Promise<AuditRow[]> {
  const raw = await db.lrange(wsKey.audit(scope), 0, Math.max(0, n - 1));
  return raw.flatMap((s) => {
    try {
      return [JSON.parse(s) as AuditRow];
    } catch {
      return [];
    }
  });
}

type Judged = { scope: Scope; id: string; decision: Decision };

/** Writes the check row and answers what `finish` needs; a failed judgement is logged and leaves no row. */
async function check(
  user: User,
  tool: string,
  initiator: Initiator,
  agent: AgentId | undefined,
  input: () => Promise<GateInput>,
): Promise<Judged | null> {
  try {
    const scope = sc(user);
    const decision = decide(await input());
    const id = randomUUID();
    const run = currentRunId();
    await pushAudit(scope, {
      phase: "check",
      id,
      at: new Date().toISOString(),
      tool,
      initiator,
      ...(agent ? { agent } : {}),
      verdict: decision.verdict,
      rule: decision.rule,
      ...(run ? { run } : {}),
    });
    return { scope, id, decision };
  } catch (e) {
    log.error("gateway check failed", e);
    return null;
  }
}

async function finish(j: Judged | null, tool: string, outcome: Outcome, t0: number): Promise<void> {
  runEvent({
    t: "tool",
    tool,
    outcome,
    ms: Date.now() - t0,
    ...(j ? { verdict: j.decision.verdict, rule: j.decision.rule } : {}),
  });
  if (!j) return;
  const mismatch = isMismatch(j.decision.verdict, outcome);
  if (mismatch) log.warn("gateway mismatch", { tool, rule: j.decision.rule });
  await pushAudit(j.scope, { phase: "done", id: j.id, at: new Date().toISOString(), outcome, mismatch });
}

/**
 * A chat tool call (`runTool`) through the gateway. The inputs are read as `runTool` reads them: the tools offered to the
 * talking agent, the role's action and the owner's authority setting read at the moment of the call. A call with no agent
 * (a test, onboarding) is a person's own; over MCP the caller is the connected app.
 */
export async function gatedTool(
  user: User,
  tool: string,
  ctx: { agent?: AgentId; via?: "app" | "mcp" },
  run: () => Promise<string>,
  mode: GatewayMode = GATEWAY_MODE,
): Promise<string> {
  const t0 = Date.now();
  const initiator: Initiator = ctx.via === "mcp" ? "mcp" : ctx.agent ? "agent" : "person";
  const j =
    mode === "off"
      ? null
      : await check(user, tool, initiator, ctx.agent, async () => {
          const needs = Object.hasOwn(TOOL_ACTION, tool) ? TOOL_ACTION[tool] : null;
          const cap = ctx.agent ? capOfTool(tool) : null;
          return {
            tool,
            initiator,
            offered: !ctx.agent || toolsFor(ctx.agent).some((t) => t.name === tool),
            roleOk: !needs || can(user, needs),
            // A web search runs only from its approved card (v2 C10, rule 4798): "ask" for every workspace in this release.
            authority:
              tool === WEB_SEARCH_TOOL.name
                ? "ask"
                : cap && ctx.agent
                ? authorityOf((await getGov(user.scope ?? acct(user))).toolPolicy, ctx.agent, cap)
                : "on",
          };
        });
  let answer: string;
  try {
    answer = await run();
  } catch (e) {
    await finish(j, tool, "error", t0);
    throw e;
  }
  await finish(j, tool, refusedAnswer(answer) ? "refused" : "ran", t0);
  return answer;
}

/**
 * An MCP `tools/call` through the gateway. `need` is the tool's action from `MCP_TOOL_ACTION` (an unknown tool is answered
 * before this). The outcome is read from the JSON-RPC answer: a result marked `isError` or an error object is "refused".
 */
export async function gatedMcp(
  user: User,
  tool: string,
  need: Action,
  run: () => Promise<Response>,
  mode: GatewayMode = GATEWAY_MODE,
): Promise<Response> {
  const t0 = Date.now();
  const j =
    mode === "off"
      ? null
      : await check(user, tool, "mcp", undefined, async () => ({
          tool,
          initiator: "mcp",
          offered: true,
          roleOk: can(user, need),
          authority: "on",
        }));
  let res: Response;
  try {
    res = await run();
  } catch (e) {
    await finish(j, tool, "error", t0);
    throw e;
  }
  // Both switches off: the answer is not read again.
  if (!j && !currentRunId()) return res;
  await finish(j, tool, await mcpOutcome(res), t0);
  return res;
}

async function mcpOutcome(res: Response): Promise<Outcome> {
  try {
    const body = (await res.clone().json()) as { result?: { isError?: boolean }; error?: unknown };
    return body.error || body.result?.isError ? "refused" : "ran";
  } catch {
    return "ran";
  }
}
