/**
 * One generation pipeline for every paid text batch: `/api/generate`, the chat tools `generate_content` and
 * `draft_items`, MCP `generate_content`, the Sunday plan (`runWeekly`) and the routines (`routineFor`). Each of them
 * used to repeat the same charge, generate, save and judge steps, and a rule added to one (a cap, a refund receipt, the
 * grounding the judge gets) had to be copied into five others by hand.
 *
 * The order is fixed here and is the same on every path: the model switch, the brand file, the trial, the data the
 * type needs, then the owning agent's charge under the owner's monthly cap for that agent. Every refusal before the
 * charge is typed and charges nothing. The grounding is read inside the refunding try, so a failed read or a failed
 * generation gives the credits back with the charge's receipt (the agent's monthly counter comes down with them), and
 * the items are built by one helper (`taskFromItem`), saved together and handed to the judge with what the agent had.
 *
 * Callers keep what is theirs: their response shapes and messages, tracking, the early 503 of the generate route,
 * the weekly cap and locks of the scheduled paths. The scope is always the caller's own (`sc(u)`), never request data.
 * A saved batch is one row of the activity log (src/lib/activity.ts), and so is a refusal at the charge on an owner path.
 */
import { randomBytes } from "crypto";
import { trialOver, type User } from "./auth";
import { charge, refund, type AgentCharge } from "./credits";
import { agentForTask, type AgentId } from "./agents";
import { briefOf, getBrand, listPreferencesFor, saveTask, type Brand, type Task, type TaskParent } from "./brand";
import { TASK_COST, TASK_COUNT, isDraftType, type TaskType } from "./tasks";
import { getGov, type Governance } from "./governance";
import { missingData } from "./cart-recovery";
import { modelState } from "./model";
import { memoryBlock } from "./files";
import { statsFor } from "./stats";
import { feedbackFor } from "./feedback";
import { generate, type Generated } from "./noor";
import { judgeLater } from "./judge";
import { warnAgentCap } from "./notifications";
import { initialStatus } from "./brand-rules";
import type { Grounding } from "./json";
import { promptStamp } from "./prompt-stamp";
import { byOf, systemBy, type By } from "./actor";
import { recordActivity, type Activity } from "./activity";

/** Where a batch was asked for. Not the same as `source`: MCP and chat items are both `source:"chat"`. */
export type BatchVia = "app" | "chat" | "mcp" | "weekly" | "routine" | "handoff";
export type TaskSource = NonNullable<Task["source"]>;

export type BatchOpts = {
  type: TaskType;
  /** The owner's notes or brief for this batch, or a scheduled path's fixed note: given to the agent, the reviewer and the judge. */
  notes?: string;
  /** What each task keeps as `brief`. By default the notes, through `briefOf`. */
  brief?: string;
  /** A small ask (chat `draft_items`, 1-3): exactly this many items, charged their share of the full batch, at least 1 credit. */
  count?: number;
  source: TaskSource;
  via: BatchVia;
  /** Already read by the caller (the scheduled paths check the weekly cap with it): not read again. */
  gov?: Governance;
  brand?: Brand;
  /** Every item waits for the owner even when auto-approve is on for its type (the MCP `save_draft` rule). */
  forcePending?: boolean;
  /** Runs whenever the batch ends without keeping a charge (refused, or refunded): a routine gives back its attempt. */
  settle?: () => Promise<unknown>;
  /**
   * Who asked, for the activity log: the chat turn's login, `tokenBy` for MCP. By default `byOf(user)` from the session,
   * and the system job for the scheduled paths (the Sunday plan's "Run now" passes the login that pressed it).
   */
  by?: By;
  /**
   * An item of Majed's handoff (src/lib/handoffs.ts): his brief for this item. It reaches the agent, the reviewer, the
   * cross-reviewers and the judge as its own labelled data block (`leadBriefBlock`, src/lib/json.ts), never as the
   * owner's notes and never as a source of figures; a batch without it is prompted exactly as before handoffs existed.
   */
  leadBrief?: string;
  /**
   * The handoff item the batch is run for: kept on every task it makes (`Task.parent`). Set by the run, in code; `auto`
   * when Majed's auto-run started it (such tasks count as autonomous, `isAutonomous` in brand.ts).
   */
  parent?: TaskParent;
  /**
   * When the caller's request or cron invocation ends (epoch ms). Only the cross-agent review reads it: notes only, it is
   * skipped with too little time left (`CROSS_REVIEW_MIN_MS`, noor.ts), so it never pushes a charged batch past the
   * platform's limit. Callers that start a batch late check `BATCH_RUN_MIN_MS` themselves, before the charge.
   */
  deadline?: number;
};

/**
 * What a batch (generation, reviewer, cross-review) needs of its request or invocation before it is charged: a caller with
 * less left refuses before the charge (the handoff run "too_late", the auto-run and the routines "retry:late"). A platform
 * timeout kills a function without throwing, so a batch cut short keeps its charge and saves nothing.
 */
export const BATCH_RUN_MIN_MS = 180_000;

export type BatchRefusal =
  | { ok: false; reason: "paused" }
  | { ok: false; reason: "no_brand" }
  | { ok: false; reason: "trial_over" }
  | { ok: false; reason: "missing_data"; missing: string }
  | { ok: false; reason: "agent_cap"; agent: AgentId; spent: number; cap: number; credits: number }
  | { ok: false; reason: "no_credits"; need: number; credits: number }
  /** The charge was refunded (`credits` is the balance after it); the caller decides how to report `error`. */
  | { ok: false; reason: "failed"; error: unknown; credits: number };

export type BatchDone = { ok: true; tasks: Task[]; credits: number; receipt: Extract<AgentCharge, { ok: true }>; cost: number; agent: AgentId; gov: Governance };
export type BatchResult = BatchDone | BatchRefusal;

/**
 * What `count` items of a type cost: their share of the full batch, rounded up, never less than 1 credit. The same
 * formula as `draftCredits` in src/lib/task-costs.ts, whose estimate the margin-floor test checks; that test pins the two
 * equal (tests/pricing-floor.test.ts, rule 241).
 */
export const countCost = (type: TaskType, count: number) => Math.max(1, Math.ceil((TASK_COST[type] / (TASK_COUNT[type] || 1)) * count));

export type ItemContext = {
  type: TaskType;
  /** `industry` picks the industry playbook named in the prompt stamp; without it the stamp leaves that part out. */
  brand: Pick<Brand, "banned" | "languages"> & Partial<Pick<Brand, "industry">>;
  /** `gov.autoApprove[type]`; ignored when `forcePending`. */
  autoApprove?: boolean;
  source: TaskSource;
  brief?: string;
  forcePending?: boolean;
  /** One creation time for the whole batch. */
  createdAt: string;
  /** The handoff item the batch was run for (`Task.parent`). */
  parent?: TaskParent;
};

/**
 * One generated item as a new task. Every batch builds its tasks here, so a field every new task must carry is added
 * in one place. Auto-approval never skips the brand gate (`initialStatus`), and a forced batch is never auto-approved.
 * The gate reads the item's channel: a personalisation slot such as {{1}} passes only on a WhatsApp, email, SMS or call
 * draft, and an unfilled placeholder such as [رقم] holds approval on every channel (src/lib/brand-rules.ts, rule 213).
 * `pb` records which prompts made it (src/lib/prompt-stamp.ts), so a change in quality can be traced to a prompt change.
 *
 * The cross-agent review's verdicts (`it.crossReview`, noor.ts) are kept on the task, and a "flag" holds it pending
 * the way `forcePending` does, so another agent's concern always reaches the owner before the item counts as approved.
 * An `external` item (MCP `save_draft`) is never cross-reviewed: no Nashr agent wrote it, so it keeps no verdicts.
 */
export function taskFromItem(it: Generated, c: ItemContext): Task {
  const draft = { type: c.type, channel: it.channel, title: it.title, body: it.body };
  const verdicts = c.source !== "external" && it.crossReview?.length ? it.crossReview : undefined;
  const flagged = !!verdicts?.some((v) => v.verdict === "flag");
  return {
    id: randomBytes(8).toString("hex"), type: c.type, channel: it.channel, title: it.title, body: it.body,
    status: initialStatus(c.forcePending || flagged ? false : c.autoApprove, c.brand, draft),
    createdAt: c.createdAt, lang: c.brand.languages[0] ?? "ar", source: c.source, ...(c.brief ? { brief: c.brief } : {}),
    pb: promptStamp(c.type, c.brand),
    ...(verdicts ? { crossReview: verdicts } : {}),
    ...(c.parent ? { parent: { handoff: c.parent.handoff, item: c.parent.item, ...(c.parent.conv ? { conv: c.parent.conv } : {}), ...(c.parent.auto === true ? { auto: true as const } : {}) } } : {}),
  };
}

/**
 * The batch's cross-agent review in the activity log: one `cross_reviewed` row per reviewing agent that gave verdicts,
 * with the items it read, how many, and how many it flagged (`outcome` "flags:N"). The review runs by itself, so `by` is
 * the system's, with the batch's `via`, like the judge's rows.
 */
export function crossReviewRows(tasks: Task[], at: string, via: BatchVia): Activity[] {
  const by = new Map<AgentId, Task[]>();
  for (const t of tasks) for (const v of t.crossReview ?? []) by.set(v.by, [...(by.get(v.by) ?? []), t]);
  return [...by].map(([agent, ts]) => {
    const flags = ts.filter((t) => t.crossReview!.some((v) => v.by === agent && v.verdict === "flag")).length;
    return { at, kind: "cross_reviewed", agent, by: { kind: "system" }, via, type: ts[0].type, tasks: ts.map((t) => t.id), count: ts.length, outcome: `flags:${flags}` };
  });
}

export async function generateBatch(user: User, scope: string, opts: BatchOpts): Promise<BatchResult> {
  const { type } = opts;
  // A small ask is only for DRAFT_TYPES (rule 250). The chat's `draft_items` refuses any other type in code before it
  // calls this; here it is an invariant, before any read or charge, so no caller can buy one item of a batch type at
  // its pro-rata price.
  if (opts.count !== undefined && !isDraftType(type)) throw new Error(`not_draft_type:${type}`);
  // A scheduled run records its own outcome (`recordRun`), so a refusal at its charge is one row there, not two.
  const scheduled = opts.via === "weekly" || opts.via === "routine";
  const refuse = async (r: BatchRefusal, row?: Activity): Promise<BatchRefusal> => {
    await Promise.all([opts.settle?.(), row && !scheduled ? recordActivity(scope, [row]) : null]);
    return r;
  };
  const who = async () => opts.by ?? (opts.via === "weekly" ? systemBy("cron") : opts.via === "routine" ? systemBy("routine") : await byOf(user));
  // Before any read or charge. Chat is the exception: its turn answers while paused before any tool runs (rule 76), and
  // a tool called outside a turn keeps the backstop every path has, generate() throwing and the charge refunded.
  if (opts.via !== "chat" && modelState() === "paused") return refuse({ ok: false, reason: "paused" });
  // Governance before the charge: the owner's monthly cap for this agent is checked inside the ledger's lock.
  const [brand, gov] = await Promise.all([opts.brand ?? getBrand(scope), opts.gov ?? getGov(scope)]);
  if (!brand) return refuse({ ok: false, reason: "no_brand" });
  if (trialOver(user)) return refuse({ ok: false, reason: "trial_over" });
  const missing = await missingData(type, scope);
  if (missing) return refuse({ ok: false, reason: "missing_data", missing });
  const cost = opts.count ? countCost(type, opts.count) : TASK_COST[type];
  // The agent that owns the type, computed in code: never taken from the request or the model.
  const agent = agentForTask(type).id;
  const paid = await charge(user.email, cost, { scope, agent, cap: gov.agentCaps[agent] });
  // Nothing was charged; the row says what the batch would have cost and, at a cap, what the agent spent of it.
  const refused = async (kind: "cap_reached" | "no_credits", outcome?: string): Promise<Activity> => ({ at: new Date().toISOString(), kind, agent, by: await who(), via: opts.via, type, credits: cost, ...(outcome ? { outcome } : {}) });
  if (!paid.ok && paid.reason === "agent_cap") return refuse({ ok: false, reason: "agent_cap", agent: paid.agent, spent: paid.spent, cap: paid.cap, credits: paid.credits }, await refused("cap_reached", `${paid.spent}/${paid.cap}`));
  if (!paid.ok) return refuse({ ok: false, reason: "no_credits", need: cost, credits: paid.credits }, await refused("no_credits"));
  user.credits = paid.credits;
  await warnAgentCap(user, paid);

  let items: Generated[];
  let ground: Grounding;
  // Read inside the try: the credits are already charged, and a failed read must reach the refund below.
  try {
    const [prefs, memory, stats, feedback] = await Promise.all([listPreferencesFor(scope, agent), memoryBlock(scope), statsFor(type, scope), feedbackFor(scope, agent, { gov })]);
    // A lead brief rides along only when there is one, so every other batch's prompts and judge grounding are unchanged.
    const lead = opts.leadBrief?.trim() ? { leadBrief: opts.leadBrief } : {};
    ground = { notes: opts.notes, memory, stats, ...lead };
    items = await generate(type, brand, prefs, opts.notes, { memory, reviewer: gov.reviewer, noEmDash: gov.noEmDash, crossReview: gov.crossReview !== false, meter: user.email, stats, feedback, ...(opts.count ? { count: opts.count } : {}), ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}), ...lead });
  } catch (error) {
    // With the receipt, so the agent's monthly counter comes down with the balance.
    const [credits] = await Promise.all([refund(user.email, cost, paid), opts.settle?.()]);
    user.credits = credits;
    return { ok: false, reason: "failed", error, credits };
  }

  const createdAt = new Date().toISOString();
  const brief = opts.brief ?? briefOf(opts.notes);
  const tasks = items.map((it) => taskFromItem(it, { type, brand, autoApprove: gov.autoApprove[type], source: opts.source, brief, forcePending: opts.forcePending, createdAt, parent: opts.parent }));
  // Together, not one round trip after another (Redis is HTTP per command), with the batch's one activity row and, when
  // other agents reviewed it, one row per reviewer.
  const done: Activity = { at: createdAt, kind: "generated", agent, by: await who(), via: opts.via, type, tasks: tasks.map((t) => t.id), count: tasks.length, credits: cost };
  await Promise.all([...tasks.map((t) => saveTask(scope, t, true)), recordActivity(scope, [done, ...crossReviewRows(tasks, createdAt, opts.via)])]);
  // The judge scores against what the agent had, and against the count the owner asked for.
  judgeLater(scope, user.email, brand, tasks, opts.count, { ...ground, via: opts.via });
  return { ok: true, tasks, credits: user.credits, receipt: paid, cost, agent, gov };
}
