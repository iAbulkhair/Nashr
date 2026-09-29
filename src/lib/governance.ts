import { db } from "./db";
import { isTaskType, type TaskType } from "./tasks";
import { isAgentId, type AgentId } from "./agents";

export type Governance = {
  autoApprove: Partial<Record<TaskType, boolean>>; // skip inbox for these types
  weeklyCap: number; // max items created per week on their own: the weekly plan and the routines (schedule.ts, routines.ts)
  learning: boolean; // write preferences from edits/rejections
  reviewer: boolean; // second-pass quality reviewer
  noEmDash: boolean; // strip em/en dashes from output
  notifyMinutes: number; // minutes before a scheduled post to notify (future: WhatsApp/email)
  /** Monthly credit cap per agent in this brand scope (`charge` in credits.ts enforces it); an agent with no entry has no cap. */
  agentCaps: Partial<Record<AgentId, number>>;
};

export const DEFAULT_GOV: Governance = { autoApprove: {}, weeklyCap: 20, learning: true, reviewer: true, noEmDash: false, notifyMinutes: 60, agentCaps: {} };
/** Highest monthly cap an owner can set for one agent. */
export const AGENT_CAP_MAX = 100000;

/** What the governance PUT may send: `null` or "" for an agent's cap removes it. */
export type GovPatch = Partial<Omit<Governance, "agentCaps">> & { agentCaps?: Partial<Record<AgentId, number | null | "">> };

export async function getGov(email: string): Promise<Governance> {
  return { ...DEFAULT_GOV, ...((await db.get<Partial<Governance>>(`gov:${email}`)) ?? {}) };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Merge a patch into the stored governance. The patch is a request body, so every field is checked here, not trusted:
 * auto-approve keys must be task types with boolean values, caps must name an agent and be finite, NaN never replaces a
 * number, and unknown keys are dropped. `typeof NaN === "number"` used to let NaN through as a weekly cap.
 */
export async function saveGov(email: string, patch: GovPatch) {
  const g: Record<string, unknown> = isObj(patch) ? patch : {};
  const cur = await getGov(email);
  const autoApprove: Partial<Record<TaskType, boolean>> = {};
  for (const [k, v] of Object.entries({ ...cur.autoApprove, ...(isObj(g.autoApprove) ? g.autoApprove : {}) })) if (isTaskType(k) && typeof v === "boolean") autoApprove[k] = v;
  const agentCaps: Partial<Record<AgentId, number>> = {};
  for (const [k, v] of Object.entries(cur.agentCaps ?? {})) if (isAgentId(k) && num(v)) agentCaps[k] = v;
  for (const [k, v] of Object.entries(isObj(g.agentCaps) ? g.agentCaps : {})) {
    if (!isAgentId(k)) continue;
    if (v === null || v === "") delete agentCaps[k];
    else if (num(v)) agentCaps[k] = Math.max(0, Math.min(AGENT_CAP_MAX, Math.trunc(v)));
  }
  const next: Governance = {
    autoApprove,
    weeklyCap: num(g.weeklyCap) ? Math.max(0, Math.min(200, g.weeklyCap)) : cur.weeklyCap,
    learning: typeof g.learning === "boolean" ? g.learning : cur.learning,
    reviewer: typeof g.reviewer === "boolean" ? g.reviewer : cur.reviewer,
    noEmDash: typeof g.noEmDash === "boolean" ? g.noEmDash : cur.noEmDash,
    notifyMinutes: num(g.notifyMinutes) ? Math.max(0, Math.min(1440, g.notifyMinutes)) : cur.notifyMinutes,
    agentCaps,
  };
  await db.set(`gov:${email}`, next);
  return next;
}
