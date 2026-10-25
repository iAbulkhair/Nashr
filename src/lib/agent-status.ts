import { AGENTS, agentForTask, type AgentId } from "./agents";
import type { Activity, ActivityKind } from "./activity";
import type { TaskType } from "./brand";

/**
 * Each agent's state at a glance (rules 2550-2555, pattern 8 of docs/reports/2026-10-19-PRD-fizzy-orca_AR.md, borrowed
 * from Orca): working (يعمل), waiting for you (ينتظرك), done (انتهى) or stuck (متعثر), with the last few rows of how it
 * got there. Nothing is stored for it: the state is read from what already exists, the brand's activity log
 * (src/lib/activity.ts) and the drafts waiting in the inbox (`isWaiting`, src/lib/brand.ts). A pure module, so the app
 * page, the push sender and the tests all read one rule.
 */
export const AGENT_STATES = ["working", "waiting", "done", "stuck"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** A render still "working" this long after it started, with no ready or failed row, is shown stuck (rule 2551). */
export const WORKING_MINUTES = 30;
/** A failure older than this is old news: the agent falls back to done (or quiet) instead of stuck (rule 2551). */
export const STUCK_DAYS = 3;
/** How many of the agent's own rows the short log shows (rule 2552). */
export const LOG_ROWS = 5;
/** How many of the brand's newest activity rows the app page reads to derive every agent's state (one lrange). */
export const STATUS_ROWS = 200;

/** A scheduled run's skip outcomes that mean the agent could not do its work (as `SKIPPED` in src/lib/activity.ts). */
const STUCK_SKIPS = new Set(["cap_reached", "agent_cap", "no_credits", "trial_over", "fair_use", "attempts_exhausted", "error", "paused"]);

/** Rows that close a piece of work; the others (decisions, settings, refunds, declines) say nothing about the agent's state. */
const DONE_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  "generated", "published", "judged", "cross_reviewed", "render_done", "routine_ran", "handoff_run", "handoff_proposed",
  "external_draft", "file_written", "instructions_tested",
]);
const STUCK_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>(["cap_reached", "no_credits", "render_failed", "run_held"]);

/** What one activity row says about its agent's state, or null for a row that says nothing (rule 2550). */
export function rowState(a: Pick<Activity, "kind" | "outcome">): AgentState | null {
  if (a.kind === "image_started") return "working";
  if (STUCK_KINDS.has(a.kind)) return "stuck";
  if (a.kind === "routine_skipped") return a.outcome && STUCK_SKIPS.has(a.outcome) ? "stuck" : null;
  if (a.kind === "handoff_run" && a.outcome?.startsWith("failed:")) return "stuck";
  return DONE_KINDS.has(a.kind) ? "done" : null;
}

/**
 * Rows worth a phone notification when the owner is away (rule 2566): something now waits for them (a batch of drafts,
 * a routine that wrote some, a handoff to approve, a draft from a connected app) or the agent is stuck. Done alone and
 * working never wake anyone.
 */
export function pushStateOf(a: Pick<Activity, "kind" | "outcome" | "count">): "waiting" | "stuck" | null {
  if (rowState(a) === "stuck") return "stuck";
  if (a.kind === "generated" || a.kind === "handoff_proposed" || a.kind === "external_draft") return "waiting";
  if (a.kind === "routine_ran" && (a.count ?? 0) > 0) return "waiting";
  return null;
}

export type LogRow = { at: string; kind: ActivityKind; state: AgentState | null };
export type AgentStatus = {
  agent: AgentId;
  /** null: nothing recorded yet and nothing waiting, shown as quiet (no badge). */
  state: AgentState | null;
  /** Drafts of this agent waiting for the owner. */
  waiting: number;
  /** When the row that decided the state happened (absent for waiting with no such row, and for quiet). */
  since?: string;
  /** The agent's newest rows, newest first: kind and time only, never the free-text note (rule 2552). */
  log: LogRow[];
};

const MIN = 60_000, DAY = 86_400_000;

/**
 * One agent's state from its own rows (newest first) and its waiting drafts (rule 2551). Precedence: stuck (the newest
 * row that says anything is a failure, or a render left working past `WORKING_MINUTES`, within `STUCK_DAYS`), then
 * waiting (any draft of its own waits), then working (a render started within `WORKING_MINUTES`), then done (it has
 * finished something), else quiet.
 */
export function deriveStatus(agent: AgentId, rows: readonly Activity[], waiting: number, now: number): AgentStatus {
  const own = rows.filter((r) => r.agent === agent);
  const log = own.slice(0, LOG_ROWS).map((r) => ({ at: r.at, kind: r.kind, state: rowState(r) }));
  const decisive = own.find((r) => rowState(r) !== null);
  const st = decisive ? rowState(decisive) : null;
  const age = decisive ? now - Date.parse(decisive.at) : Infinity;
  const fresh = age <= STUCK_DAYS * DAY;
  const base = { agent, waiting, log };
  if (decisive && fresh && (st === "stuck" || (st === "working" && age > WORKING_MINUTES * MIN))) return { ...base, state: "stuck", since: decisive.at };
  if (waiting > 0) return { ...base, state: "waiting" };
  if (decisive && st === "working") return { ...base, state: "working", since: decisive.at };
  const done = own.find((r) => rowState(r) === "done");
  if (done) return { ...base, state: "done", since: done.at };
  return { ...base, state: null };
}

/**
 * Every agent with deliverable work (Reem keeps the owner's own to-dos and has no state here), in roster order. `rows`
 * are the brand's newest activity rows in any order; `waitingTasks` the brand's drafts that wait for the owner
 * (`isWaiting`), each counted for the agent that owns its type.
 */
export function agentStatuses(rows: readonly Activity[], waitingTasks: readonly { type: TaskType }[], now: number = Date.now()): AgentStatus[] {
  const sorted = [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const waiting = new Map<AgentId, number>();
  for (const t of waitingTasks) {
    const id = agentForTask(t.type).id;
    waiting.set(id, (waiting.get(id) ?? 0) + 1);
  }
  return AGENTS.filter((a) => a.tasks.length > 0).map((a) => deriveStatus(a.id, sorted, waiting.get(a.id) ?? 0, now));
}

/** The four states' words and the quiet line, Arabic and English (rule 2554). The push text uses `state` too. */
export const STATUS_COPY = {
  ar: {
    title: "حالة الفريق",
    state: { working: "يعمل", waiting: "ينتظرك", done: "انتهى", stuck: "متعثر" } satisfies Record<AgentState, string>,
    quiet: "لا عمل بعد",
    drafts: (n: number) => (n === 1 ? "مسودة واحدة" : n === 2 ? "مسودتان" : n <= 10 ? `${n} مسودات` : `${n} مسودة`),
    how: "كيف وصل إلى هنا",
    pushOn: "نبّهني على هذا الجهاز",
    pushOff: "أوقف التنبيه على هذا الجهاز",
    pushNote: "يصلك تنبيه فقط حين يحتاجك أحد الفريق وأنت بعيد عن التطبيق.",
    pushDenied: "التنبيهات محجوبة في إعدادات المتصفح لهذا الموقع.",
    pushFailed: "تعذّر تفعيل التنبيه. حاول مرة أخرى.",
    generic: "لديك تحديث من فريقك في ذكين.",
  },
  en: {
    title: "Your team now",
    state: { working: "Working", waiting: "Waiting for you", done: "Done", stuck: "Stuck" } satisfies Record<AgentState, string>,
    quiet: "No work yet",
    drafts: (n: number) => (n === 1 ? "1 draft" : `${n} drafts`),
    how: "How it got here",
    pushOn: "Notify me on this device",
    pushOff: "Stop notifications on this device",
    pushNote: "You get a notification only when a team member needs you and you are away from the app.",
    pushDenied: "Notifications are blocked for this site in the browser settings.",
    pushFailed: "Notifications could not be switched on. Try again.",
    generic: "You have an update from your Thakeen team.",
  },
} as const;
