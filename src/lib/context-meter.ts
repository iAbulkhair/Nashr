import type { AgentId } from "./agents";
import { CHAT_FIRST_MIN_OUT } from "./chat-budget";
import type { ThreadSummary } from "./compaction";
import { isConversationId } from "./conversations";
import type { Scope } from "./keys";
import { chatTurnMaxUsd } from "./models/credits";
import { listRuns, type Run } from "./runs";
import { costUsd } from "./usage";

/**
 * The context meter (Thakeen v2 phase 3, C13, rules 4760-4769, docs/system/flows.md "Context meter").
 *
 * How full each agent's context is in one thread: the input tokens of the agent's first chat call in its newest turn of that
 * thread, as `metered` recorded them in the run log (src/lib/runs.ts), against the room a first call has before the history
 * guard starts dropping messages (`contextBudget`). No new storage: it is read from the run log, so it follows `RUN_LOG`.
 *
 * At `METER_PRESSURE` (80%) the next turn of that agent compacts before its model call (C11, src/lib/compaction.ts): the
 * thread's older messages are folded into the summary and only the newest `CONTEXT_KEEP` are sent, so the thread keeps what
 * was decided instead of losing it to the guard. That needs `COMPACTION` too; off, the meter only shows.
 */
/** One agent's meter: no model id, since the work view shows it to the person (Thakeen names no model to customers). */
export type ContextMeter = {
  agent: AgentId;
  used: number;
  budget: number;
  pct: number;
  /** At `METER_PRESSURE`: the agent's next turn here compacts first. */
  hot: boolean;
  at: string;
};

/** The share of the budget at which the next turn compacts first. */
export const METER_PRESSURE = 0.8;
/** The newest messages a turn under pressure still sends in full; the summary carries the rest. */
export const CONTEXT_KEEP = 6;
/** The newest runs of the workspace the meter reads (one list read and one batch read). */
export const METER_RUNS = 20;

/**
 * The input tokens a turn's first call can take on `model` and still have `CHAT_FIRST_MIN_OUT` of output within the
 * per-message ceiling (`chatTurnMaxUsd`), priced as plain input: past it `fitFirstCall` drops the oldest messages.
 */
export function contextBudget(model: string): number {
  const room = chatTurnMaxUsd(model) - costUsd(model, { output_tokens: CHAT_FIRST_MIN_OUT });
  const rate = costUsd(model, { input_tokens: 1 });
  return rate > 0 && room > 0 ? Math.floor(room / rate) : 0;
}

/** The thread a run belongs to, as the run log keeps it: a conversation id, or none for the default thread. */
export const runConv = (conv: string | undefined): { conv?: string } =>
  conv && conv !== "default" && isConversationId(conv) ? { conv } : {};

/**
 * Each agent's meter in one thread, from runs read newest first: the newest chat run of the thread per agent, and in it
 * that agent's first chat call. Pure.
 */
export function metersOf(runs: Run[], conv: string | undefined): ContextMeter[] {
  const want = runConv(conv).conv;
  const seen = new Map<AgentId, ContextMeter>();
  for (const r of runs) {
    if (r.kind !== "chat" || r.conv !== want || !r.agent || seen.has(r.agent)) continue;
    const first = r.events.find((e) => e.t === "model" && e.kind === "chat" && e.agent === r.agent);
    if (!first || first.t !== "model") continue;
    const budget = contextBudget(first.model);
    const pct = budget > 0 ? Math.min(1, first.in / budget) : 0;
    seen.set(r.agent, { agent: r.agent, used: first.in, budget, pct, hot: pct >= METER_PRESSURE, at: r.startedAt });
  }
  return [...seen.values()];
}

/** The meters of one thread of the caller's workspace (`sc(u)`), read from the run log. */
export async function readMeters(s: Scope, conv: string | undefined): Promise<ContextMeter[]> {
  return metersOf(await listRuns(s, METER_RUNS), conv);
}

/** Whether `agent`'s next turn in the thread compacts first (rule 4763). */
export const underPressure = (meters: ContextMeter[], agent: AgentId): boolean =>
  meters.some((m) => m.agent === agent && m.hot);

/** How many of the guard's `trimmed` newest messages to keep out of compaction: all, or `CONTEXT_KEEP` under pressure. */
export const keptFor = (pressure: boolean, trimmed: number): number =>
  pressure ? Math.min(trimmed, CONTEXT_KEEP) : trimmed;

/**
 * The messages to send (rule 4764): the newest `kept` of `trimmed` once the summary covers every older message of the
 * thread, else `trimmed` unchanged (a compaction that did not run or failed never costs the thread a message).
 */
export function coveredTail<T>(
  trimmed: T[],
  thread: { at?: string }[],
  kept: number,
  summary: ThreadSummary | null,
): T[] {
  if (kept >= trimmed.length || !summary) return trimmed;
  const last = thread[thread.length - kept - 1]?.at;
  return typeof last === "string" && summary.upTo >= last ? trimmed.slice(-kept) : trimmed;
}
