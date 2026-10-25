import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentId } from "./agents";
import { db } from "./db";
import { wsKey, type Scope } from "./keys";
import { log } from "./log";
import { RUN_LOG } from "./v2-flags";

/**
 * The run log (Thakeen v2 component C2, rules 4510-4519, docs/system/flows.md "Run log").
 *
 * One record per chat turn, MCP tool call or content batch: what happened, in order. Each model call, with its tokens (from
 * `metered`, src/lib/metered.ts), each tool call with the gateway's verdict (src/lib/gateway.ts) and each publish attempt
 * (src/lib/publish-once.ts). Read back in order it replays the run, and it is what plans, the work view and self-check
 * build on in later phases.
 *
 * Steps only, never words: no prompt, reply, tool input or item text is kept, so a run record holds nothing the
 * workspace's own records do not already hold. The scope comes from `sc(u)` at the entry point, never from a request.
 *
 * A run opened inside another (a batch inside a chat turn, a chat turn inside an MCP `ask_noor`) joins it: one record
 * for what one request did. Writing never throws and never changes the caller's answer. Off (`RUN_LOG`), nothing is
 * kept and `withRun` is a plain call.
 */

export type RunKind = "chat" | "mcp" | "batch";

/** One step of a run. `at` is milliseconds since the run started. */
export type RunEvent =
  | { t: "model"; at: number; model: string; kind: string; agent?: AgentId; in: number; out: number; ok: boolean }
  | {
      t: "tool";
      at: number;
      tool: string;
      outcome: "ran" | "refused" | "error";
      ms: number;
      verdict?: "allow" | "ask" | "deny";
      rule?: string;
    }
  | { t: "publish"; at: number; provider: string; ok: boolean; error?: string };

/** A step as the code reports it; `at` is added here. */
export type RunStep = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "at"> : never) : never;

export type Run = {
  v: 1;
  id: string;
  kind: RunKind;
  /** What started it: a task type for a batch, a tool name for an MCP call; never text from the request. */
  label?: string;
  agent?: AgentId;
  via?: "app" | "mcp";
  startedAt: string;
  ms: number;
  ok: boolean;
  events: RunEvent[];
  /** Steps past `MAX_EVENTS`, counted and not kept. */
  dropped: number;
};

export type RunMeta = { scope: Scope; kind: RunKind; label?: string; agent?: AgentId; via?: "app" | "mcp" };

/** Steps one run keeps: a chat turn is at most five model turns with a handful of tools each. */
export const MAX_EVENTS = 200;
/** Runs one workspace's index keeps, newest first. */
export const RUNS_KEEP = 200;
/** Days a run record and the index live after the last write. */
export const RUN_TTL_S = 30 * 86400;

type Live = { scope: Scope; run: Run; t0: number };
const current = new AsyncLocalStorage<Live>();

/**
 * Runs `fn` as one run of `meta.scope`, or as part of the run already open. Its record is written when `fn` settles,
 * whatever the outcome; the error, if any, is rethrown unchanged.
 */
export async function withRun<T>(meta: RunMeta, fn: () => Promise<T>, on: boolean = RUN_LOG): Promise<T> {
  if (!on || current.getStore()) return fn();
  const t0 = Date.now();
  const run: Run = {
    v: 1,
    id: randomUUID(),
    kind: meta.kind,
    ...(meta.label ? { label: meta.label } : {}),
    ...(meta.agent ? { agent: meta.agent } : {}),
    ...(meta.via ? { via: meta.via } : {}),
    startedAt: new Date(t0).toISOString(),
    ms: 0,
    ok: false,
    events: [],
    dropped: 0,
  };
  try {
    const out = await current.run({ scope: meta.scope, run, t0 }, fn);
    run.ok = true;
    return out;
  } finally {
    run.ms = Date.now() - t0;
    await saveRun(meta.scope, run);
  }
}

/** Adds a step to the open run; with none open (or the log off) it does nothing. */
export function runEvent(step: RunStep): void {
  const live = current.getStore();
  if (!live) return;
  if (live.run.events.length >= MAX_EVENTS) {
    live.run.dropped++;
    return;
  }
  live.run.events.push({ ...step, at: Date.now() - live.t0 } as RunEvent);
}

/** The id of the open run, for an audit row to point at; undefined outside one. */
export const currentRunId = (): string | undefined => current.getStore()?.run.id;

async function saveRun(scope: Scope, run: Run): Promise<void> {
  const list = wsKey.runs(scope);
  try {
    // An index entry whose record did not land is skipped by `listRuns`; the trim follows the push it trims.
    await Promise.all([db.set(wsKey.run(scope, run.id), run, RUN_TTL_S), db.lpush(list, run.id)]);
    await Promise.all([db.ltrim(list, RUNS_KEEP), db.expire(list, RUN_TTL_S)]);
  } catch (e) {
    log.error("run log write failed", e);
  }
}

export const getRun = (scope: Scope, id: string): Promise<Run | null> => db.get<Run>(wsKey.run(scope, id));

/** The newest `n` runs of a workspace; a run whose record has expired is left out. */
export async function listRuns(scope: Scope, n = 20): Promise<Run[]> {
  const ids = await db.lrange(wsKey.runs(scope), 0, Math.max(0, n - 1));
  if (!ids.length) return [];
  const runs = await db.mget<Run>(ids.map((id) => wsKey.run(scope, id)));
  return runs.filter((r): r is Run => !!r);
}

/** What a run did, read back in order: totals for the console and the checks of later phases. Pure. */
export function replay(run: Run) {
  const steps = [...run.events].sort((a, b) => a.at - b.at);
  const models = steps.filter((e) => e.t === "model");
  const tools = steps.filter((e) => e.t === "tool");
  return {
    steps,
    tokens: { in: models.reduce((s, e) => s + e.in, 0), out: models.reduce((s, e) => s + e.out, 0) },
    modelCalls: models.length,
    failedModelCalls: models.filter((e) => !e.ok).length,
    toolCalls: tools.length,
    refusedTools: tools.filter((e) => e.outcome === "refused").length,
    publishes: steps.filter((e) => e.t === "publish").length,
  };
}
