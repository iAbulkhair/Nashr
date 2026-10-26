import type { AgentId } from "./agents";
import { STUCK_DAYS, type AgentStatus } from "./agent-status";
import type { Run, RunCredit, RunEvent, RunKind } from "./runs";

/**
 * The work view (Thakeen v2 phase 3, C9, rules 4770-4789, docs/system/flows.md "Work view").
 *
 * What the team did, step by step, read from the run log (C2, src/lib/runs.ts), so it follows `RUN_LOG`: a chat turn's
 * steps stream to the chat as they happen (`step` events, src/app/api/chat/route.ts), and GET /api/runs lists the
 * workspace's newest runs with each thread's context meter (C13) for the panel beside the inbox.
 *
 * A step as the person sees it is narrower than the stored one: the step's kind, the tool, task purpose or provider it
 * names, its state, its tokens, a self-check score and the credits it moved (rule 4827). No model id (Thakeen names no model to customers), no gateway rule
 * id, no error text. The run log itself holds no words of the work, so neither does this.
 */
export type WorkStep = {
  kind: RunEvent["t"] | "charge";
  /** Milliseconds since the run started. */
  at: number;
  agent?: AgentId;
  /** A tool name, a model call's purpose ("chat", "compact", "judge"), a publish provider, "self_check" or "credits". */
  name: string;
  state: "ok" | "refused" | "error";
  tokens?: number;
  score?: number;
  rewritten?: boolean;
  /** A `charge` step's credits: taken, or given back when negative. */
  credits?: number;
};

export type WorkRun = {
  id: string;
  kind: RunKind;
  label?: string;
  agent?: AgentId;
  startedAt: string;
  ms: number;
  ok: boolean;
  steps: WorkStep[];
  tokens: number;
  /** Credits the run took, net of what it gave back (rule 4828); 0 for a run that moved none. */
  credits: number;
};

/** One stored step as the work view shows it (rule 4771); a kind this code does not know is left out (rule 4829). Pure. */
export function workStep(e: RunEvent): WorkStep | null {
  switch (e.t) {
    case "model":
      return {
        kind: "model",
        at: e.at,
        ...(e.agent ? { agent: e.agent } : {}),
        name: e.kind,
        state: e.ok ? "ok" : "error",
        tokens: e.in + e.out,
      };
    case "tool":
      return {
        kind: "tool",
        at: e.at,
        name: e.tool,
        state: e.outcome === "ran" ? "ok" : e.outcome === "refused" ? "refused" : "error",
      };
    case "publish":
      return { kind: "publish", at: e.at, name: e.provider, state: e.ok ? "ok" : "error" };
    case "check":
      return { kind: "check", at: e.at, name: "self_check", state: "ok", score: e.score, rewritten: e.rewritten };
    default:
      return null;
  }
}

/** One credit move as a step (rule 4827). Pure. */
export const creditStep = (c: RunCredit): WorkStep => ({ kind: "charge", at: c.at, name: "credits", state: "ok", credits: c.credits });

/** One run as the work view shows it: its steps and credit moves in order, its total tokens and its net credits. Pure. */
export function workRun(r: Run): WorkRun {
  const moves = (r.credits ?? []).filter((c) => Number.isFinite(c.at) && Number.isFinite(c.credits)).map(creditStep);
  const steps = [...r.events.map(workStep).filter((s): s is WorkStep => s !== null), ...moves].sort((a, b) => a.at - b.at);
  return {
    id: r.id,
    kind: r.kind,
    ...(r.label ? { label: r.label } : {}),
    ...(r.agent ? { agent: r.agent } : {}),
    startedAt: r.startedAt,
    ms: r.ms,
    ok: r.ok,
    steps,
    tokens: steps.reduce((s, x) => s + (x.tokens ?? 0), 0),
    credits: moves.reduce((s, x) => s + (x.credits ?? 0), 0),
  };
}

const DAY = 86_400_000;

/**
 * The status board agrees with the run log (rule 4780): an agent whose newest run failed, newer than the activity row
 * that decided its state and within `STUCK_DAYS`, is shown stuck, never done, waiting or quiet. Runs read newest first;
 * a run that went well changes nothing (the activity rows already say what it made). Pure.
 */
export function agreeWithRuns(statuses: AgentStatus[], runs: Run[], now: number = Date.now()): AgentStatus[] {
  return statuses.map((s) => {
    const last = runs.find((r) => r.agent === s.agent);
    if (!last || last.ok || s.state === "stuck") return s;
    const at = Date.parse(last.startedAt);
    if (!(now - at <= STUCK_DAYS * DAY)) return s;
    if (s.since && Date.parse(s.since) >= at) return s;
    return { ...s, state: "stuck", since: last.startedAt };
  });
}
