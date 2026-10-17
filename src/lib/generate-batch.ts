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
import { charge, chargeOnce, refund, refundOnce, renewIfDue, renewalDue, type SpendRef } from "./credits";
import { fairUseGate } from "./fair-use";
import { agentForTask, type AgentId } from "./agents";
import { briefOf, dropTasks, getBrand, listPreferencesFor, saveTask, type Brand, type Task, type TaskParent } from "./brand";
import { TASK_COST, TASK_COUNT, isDraftType, type TaskType } from "./tasks";
import { getGov, type Governance } from "./governance";
import { missingData } from "./cart-recovery";
import { modelState } from "./model";
import { modelAllowsTask, modelById } from "./models/catalog";
import { creditsFor } from "./models/credits";
import { type Rejected } from "./models/route";
import { generateRouteFor } from "./models/overrides";
import { noteRejectedPick } from "./usage";
import { memoryBlock } from "./files";
import { statsFor } from "./stats";
import { feedbackFor } from "./feedback";
import { generate, type Generated } from "./noor";
import { judgeLater } from "./judge";
import { warnAgentCap } from "./notifications";
import { initialStatus, isCustomerFacing } from "./brand-rules";
import { regulatedSector, withDisclaimer } from "./regulated";
import type { Grounding } from "./json";
import { promptStamp } from "./prompt-stamp";
import { entitlements } from "./entitlements";
import { instructionBlocks, loadLayers } from "./agent-instructions";
import { byOf, systemBy, type By } from "./actor";
import { recordActivity, type Activity } from "./activity";
import { AgentScopeRefused, checkGenerationNotes, itemText, otherBrandNames, readAgentScopeModes, scopeCheck, type AgentScopeModes, type NotesGate, type ScopeDecision } from "./agent-scope";
import { pmap } from "./parallel";
import { log } from "./log";

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
  /**
   * Charge at most once for this claim (src/lib/credits.ts `chargeOnce`, rule 333): the Sunday plan passes
   * `weekly:{scope}:{week}`. A run that finds the claim's hold (a run killed after its charge) reuses it instead of
   * charging, and a failure gives it back once (`refundOnce`). Without it every batch is charged as before.
   */
  once?: string;
  /**
   * Runs inside the refund guard, after the tasks are saved (rule 334): the Sunday plan's `lastWeekly` marker. A throw
   * here refunds the batch like a failed generation, so a charge is kept only with its tasks and its marker written.
   */
  commit?: (tasks: Task[]) => Promise<unknown>;
  /**
   * The model the batch runs on and is charged for (spec 2026-10-08-straitly-model-routing, sections 4 and 6): the batch
   * costs its base credits times the model's tier multiplier (`creditsFor`, src/lib/models/credits.ts). Left out or
   * `undefined`: resolved once here, after the brand file is read, by `generateRouteFor` (src/lib/models/overrides.ts):
   * the brand's pick (`Brand.model`) when `route("generate")` accepts it for this type, else the automatic choice (today
   * Opus 5, x1: today's price) and `BatchDone.modelRejected` says why, so the caller tells the owner. Anything passed here
   * must be exactly a catalog id the routing may offer (`auto` or `pick`) that may run the type, or the batch throws
   * (`unknown_model`, `model_not_offered`, `model_task_not_allowed`) before anything is read or charged; the routed model
   * is held to the same checks after the brand read, still before the charge (a backstop: `route()` already refused
   * a pick that would fail them, `task_not_allowed` included).
   *
   * The invariant: what the balance lost, the activity row's `credits` and `BatchDone.cost` are one number, the credits
   * finally charged. A fresh charge charges the batch's price; a claim's hold (`once`) is reused only when it holds exactly
   * that price, and one of another price is given back and the price charged in the same save (`chargeOnce`); a failure
   * gives back what was charged (`refund` of that number, or `refundOnce` of the hold).
   *
   * One decision: the model resolved here is the one `generate()` is asked for (the requested model), the one
   * `creditsFor` prices and the one the judge is told generated the batch (`judgeLater`). `generate()` asks for the
   * server-side fallback only when the requested model is the automatic default (`DEFAULTS.generate`, src/lib/noor.ts):
   * a pick is never answered by another model than the one it was priced at, and when it fails the batch is refunded.
   */
  model?: string;
  /**
   * The founder's agent-scope modes (src/lib/agent-scope.ts), read once by the route (`agentScopePreflight`) and handed down,
   * as `ChatOpts.agentScope` is for a chat turn. The owner's routes also hand the notes' gate (`notesGate`) and pass the modes on
   * for the check of the items the batch makes (a later task of Part B); left out, the batch reads them itself. Its `prompt` is
   * what puts the scope paragraph in the generation prompt (rule 797).
   */
  agentScope?: AgentScopeModes;
  /**
   * The input gate on the owner's notes (rule 796), set only by `POST /api/generate` and MCP `generate_content`. It runs here, with
   * this batch's own brand read, after the free refusals (paused, no brand, ended trial, missing data) and before the renewal and
   * the charge: a refusal is typed (`agent_scope`, or `agent_scope_slow` for a spent ceiling or bound), charges and saves nothing,
   * and goes through `refuse()` like the others. In `enforce` it is awaited before the charge; in `shadow` it runs beside the batch
   * and is awaited before the batch returns, on every path. A batch without it is gated by nothing here, as before.
   */
  notesGate?: NotesGate;
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
  /** The fair-use stop (src/lib/fair-use.ts, rule 1723): the account's cost this month reached 95% of what it paid; `resumes` is YYYY-MM-DD. */
  | { ok: false; reason: "fair_use"; resumes: string }
  | { ok: false; reason: "missing_data"; missing: string }
  | { ok: false; reason: "agent_cap"; agent: AgentId; spent: number; cap: number; credits: number }
  | { ok: false; reason: "no_credits"; need: number; credits: number }
  /** The charge was refunded (`credits` is the balance after it); the caller decides how to report `error`. */
  | { ok: false; reason: "failed"; error: unknown; credits: number };

/**
 * `receipt`: what the batch's charge was booked to (a reused hold's, for a batch that paid in an earlier run).
 * `modelRejected`: the brand's pick was not used and why (the batch ran on the automatic choice); the caller tells the
 * owner (`MODEL_UNAVAILABLE`, src/lib/models/overrides.ts). Absent when the pick ran, or there was none.
 * `held` (rule 801): how many items the output check refused in `enforce` and did not save, present only when above 0. Their
 * share of the price is refunded after the commit; `refunded` (present with `held`) is what actually landed, 0 when that
 * refund could not be written, so no answer claims a refund that did not happen (`withheldNote`). `cost` (and `credits`) are
 * net of what landed.
 */
export type BatchDone = { ok: true; tasks: Task[]; credits: number; receipt: SpendRef & { ok: true; credits: number }; cost: number; agent: AgentId; gov: Governance; modelRejected?: Rejected; held?: number; refunded?: number };

/**
 * The sentence the chat tools and MCP add when the output check withheld items (rule 801): it says the credits came back only
 * when the refund landed (`refunded > 0`). Empty when nothing was withheld.
 */
export function withheldNote(r: { held?: number; refunded?: number }): string {
  if (!r.held) return "";
  return (r.refunded ?? 0) > 0 ? ` ${r.held} item(s) were withheld as outside the team's work, and their credits refunded.` : ` ${r.held} item(s) were withheld as outside the team's work.`;
}
export type BatchResult = BatchDone | BatchRefusal;
/**
 * What only a batch with a `notesGate` can answer (rule 796): `agent_scope` carries the refusal text the owner reads (the notes are
 * outside what the team works on); `agent_scope_slow` says which window is spent (`retry`: the refusal ceiling, or too many checks),
 * and the route turns it into its `slow_down` answer. Kept apart from `BatchRefusal` so every other caller, which passes no gate,
 * has nothing new to handle.
 */
export type ScopeRefusal = { ok: false; reason: "agent_scope"; message: string } | { ok: false; reason: "agent_scope_slow"; retry: "hour" | "day" };

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
  /** The hashes of the platform and owner instruction blocks the batch carried (`instructionBlocks(...).stamp`), recorded in `pb`; left out, the stamp has neither field. */
  ins?: { plat: string; ins: string };
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
  // A regulated brand's customer-facing item ends with its sector's plain disclaimer line (rule 1522), before the gate reads it.
  const sector = isCustomerFacing(c.type) ? regulatedSector(c.brand.industry) : null;
  const body = sector ? withDisclaimer(it.body, sector) : it.body;
  const draft = { type: c.type, channel: it.channel, title: it.title, body };
  const verdicts = c.source !== "external" && it.crossReview?.length ? it.crossReview : undefined;
  const flagged = !!verdicts?.some((v) => v.verdict === "flag");
  return {
    id: randomBytes(8).toString("hex"), type: c.type, channel: it.channel, title: it.title, body,
    status: initialStatus(c.forcePending || flagged ? false : c.autoApprove, c.brand, draft),
    createdAt: c.createdAt, lang: c.brand.languages[0] ?? "ar", source: c.source, ...(c.brief ? { brief: c.brief } : {}),
    pb: promptStamp(c.type, c.brand, c.ins),
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

// A call that sets a gate may be answered with a `ScopeRefusal`; a call that sets none cannot, so no other caller handles one. The
// last form takes options of the plain `BatchOpts` type (gate unknown) and answers with either.
export function generateBatch(user: User, scope: string, opts: BatchOpts & { notesGate: NotesGate }): Promise<BatchResult | ScopeRefusal>;
export function generateBatch(user: User, scope: string, opts: BatchOpts & { notesGate?: undefined }): Promise<BatchResult>;
export function generateBatch(user: User, scope: string, opts: BatchOpts): Promise<BatchResult | ScopeRefusal>;
export async function generateBatch(user: User, scope: string, opts: BatchOpts): Promise<BatchResult | ScopeRefusal> {
  // Shadow checks that run beside the batch (`notesGate`): awaited on every path out, a refusal, a failure or a saved batch, so a
  // function that ends with the answer never leaves a classifier call and its log line behind.
  const late: Promise<unknown>[] = [];
  try {
    return await runBatch(user, scope, opts, late);
  } finally {
    await Promise.allSettled(late);
  }
}

async function runBatch(user: User, scope: string, opts: BatchOpts, late: Promise<unknown>[]): Promise<BatchResult | ScopeRefusal> {
  const { type } = opts;
  // A small ask is only for DRAFT_TYPES (rule 250). The chat's `draft_items` refuses any other type in code before it
  // calls this; here it is an invariant, before any read or charge, so no caller can buy one item of a batch type at
  // its pro-rata price.
  if (opts.count !== undefined && !isDraftType(type)) throw new Error(`not_draft_type:${type}`);
  // The model the batch runs on and is charged for must be exactly a catalog id the routing may offer, allowed to run the
  // type (its `tasks`, set where the type misses the margin floor at the model's tier). Checked in code, never left to the
  // routing: a caller's model before any read, the routed one after the brand read, both before the charge.
  const usable = (id: string) => {
    const entry = modelById(id);
    if (!entry) throw new Error("unknown_model");
    // Only a model the routing may offer, the set the margin-floor test covers (tests/pricing-floor.test.ts).
    if (!entry.auto && !entry.pick) throw new Error(`model_not_offered:${entry.id}`);
    if (!modelAllowsTask(entry, type)) throw new Error(`model_task_not_allowed:${entry.id}:${type}`);
    return entry.id;
  };
  if (opts.model !== undefined) usable(opts.model);
  // A scheduled run records its own outcome (`recordRun`), so a refusal at its charge is one row there, not two.
  const scheduled = opts.via === "weekly" || opts.via === "routine";
  const refuse = async <R extends BatchRefusal | ScopeRefusal>(r: R, row?: Activity): Promise<R> => {
    await Promise.all([opts.settle?.(), row && !scheduled ? recordActivity(scope, [row]) : null]);
    return r;
  };
  const who = async () => opts.by ?? (opts.via === "weekly" ? systemBy("cron") : opts.via === "routine" ? systemBy("routine") : await byOf(user));
  // Before any read or charge. Chat is the exception: its turn answers while paused before any tool runs (rule 76), and
  // a tool called outside a turn keeps the backstop every path has, generate() throwing and the charge refunded.
  if (opts.via !== "chat" && modelState() === "paused") return refuse({ ok: false, reason: "paused" });
  // Governance before the charge: the owner's monthly cap for this agent is checked inside the ledger's lock.
  // The instruction layers ride along (agent skills portal): read with the brand and governance, the plan's limits from the
  // caller's own entitlements, the reference files only of the items that reach the owning agent.
  // The founder's scope modes are read here, beside them, only when the caller handed none (routines, the weekly plan, handoffs, an
  // admin run): the prompt flag below (rule 797) is the `prompt` switch, so every generation path obeys it. Never throws.
  const [brand, gov, layers, scopeModes] = await Promise.all([opts.brand ?? getBrand(scope), opts.gov ?? getGov(scope), loadLayers(scope, entitlements(user).instructions, "active", [agentForTask(opts.type).id]), opts.agentScope ?? readAgentScopeModes()]);
  if (!brand) return refuse({ ok: false, reason: "no_brand" });
  // Resolved once (one decision): the caller's model, or the brand's pick when route() accepts it for this type, else
  // the automatic choice. `user` is the account's own record, so the China confirmation is the owner's stored one.
  const routed = opts.model === undefined ? generateRouteFor(user, brand, type) : null;
  const model = usable(routed ? routed.model : opts.model!);
  const modelRejected = routed?.rejected;
  // A refused pick is counted for the founder console (global, best effort: it never changes the batch).
  if (modelRejected) await noteRejectedPick("generate", modelRejected);
  if (trialOver(user)) return refuse({ ok: false, reason: "trial_over" });
  // The fair-use stop (rule 1723): before the data check, the input gate's classifier and the charge, so a paused account
  // makes no model call and is charged nothing.
  const stop = await fairUseGate(user);
  if (stop) return refuse({ ok: false, reason: "fair_use", resumes: stop.resumes });
  const missing = await missingData(type, scope);
  if (missing) return refuse({ ok: false, reason: "missing_data", missing });
  // The names of the account's other brands, for the classifier and the refusal copy: read at most once per batch, shared by the
  // notes' gate and the items' check, and only when one of them asks. A store error reads `[]` (only the error's name is printed):
  // the check reads none, and it must not cost the owner the batch.
  let names: Promise<string[]> | undefined;
  const brandNames = () => (names ??= otherBrandNames(user).catch((e): string[] => {
    log.error("agent scope brand names failed", e);
    return [];
  }));
  // The input gate on the notes (rule 796), after every free refusal and before the renewal and the charge, on this batch's own
  // brand read. Enforce is awaited here: a refusal charges nothing and saves nothing. Shadow runs beside the batch and is awaited
  // by `generateBatch` on the way out. The check does not throw (a failing counter or store read fails open inside it); the catch
  // is the backstop, so a late rejection can never reach the process as unhandled.
  const gate = opts.notesGate;
  if (gate && gate.mode !== "off") {
    const check = checkGenerationNotes(user, type, gate, brand, opts.deadline, brandNames).catch((e): { block: false } => {
      log.error("agent scope notes gate failed", e);
      return { block: false };
    });
    if (gate.mode === "enforce") {
      const d = await check;
      if (d.block) return refuse("slow" in d ? { ok: false, reason: "agent_scope_slow", retry: d.slow } : { ok: false, reason: "agent_scope", message: d.reply });
    } else late.push(check);
  }
  const base = opts.count ? countCost(type, opts.count) : TASK_COST[type];
  // The batch's price at its model's tier relative to the type's own writer (rule 902), computed once. It is what is charged: `charge`, or `chargeOnce`, which reuses a
  // claim's hold only when it holds exactly this price and otherwise swaps it for this price in one save.
  const cost = creditsFor(base, model, "generate", type);
  // The agent that owns the type, computed in code: never taken from the request or the model.
  const agent = agentForTask(type).id;
  // A paid account's monthly credits arrive before its first charge of the month, whichever job runs first (rule 332).
  // Only the daily cron at 05:00 UTC renewed, after the Sunday plan at 03:00: on a Sunday the 1st (next 2026-11-01) the
  // plan met last month's balance, answered no_credits and marked the week done. `renewIfDue` is the cron's own
  // function, idempotent and under the ledger's lock; the copy in hand only decides whether to take that lock.
  if (renewalDue(user)) await renewIfDue(user.email);
  const meta = { scope, agent, cap: gov.agentCaps[agent] };
  const paid = opts.once ? await chargeOnce(user.email, cost, meta, opts.once) : await charge(user.email, cost, meta);
  // Nothing was charged; the row says what the batch would have cost and, at a cap, what the agent spent of it.
  const refused = async (kind: "cap_reached" | "no_credits", outcome?: string): Promise<Activity> => ({ at: new Date().toISOString(), kind, agent, by: await who(), via: opts.via, type, credits: cost, ...(outcome ? { outcome } : {}) });
  if (!paid.ok && paid.reason === "agent_cap") return refuse({ ok: false, reason: "agent_cap", agent: paid.agent, spent: paid.spent, cap: paid.cap, credits: paid.credits }, await refused("cap_reached", `${paid.spent}/${paid.cap}`));
  if (!paid.ok) return refuse({ ok: false, reason: "no_credits", need: cost, credits: paid.credits }, await refused("no_credits"));
  user.credits = paid.credits;
  let receipt: BatchDone["receipt"];
  // What this batch is paid with: its price, or a reused hold's credits (equal to it: `chargeOnce` swaps any other). The
  // activity row and `BatchDone.cost` report this, so they always say what the balance lost.
  const charged = "hold" in paid ? paid.hold.credits : cost;
  // A reused hold (a claim this batch paid in an earlier, killed run) was warned about by the run that took it.
  // The hold keeps the top-up receipt of the run that paid (`from`, rule 442), so the receipt names the same packs.
  if ("hold" in paid) receipt = { ok: true, credits: paid.credits, scope: paid.hold.scope, agent: paid.hold.agent, month: paid.hold.month, ...(paid.hold.from ? { from: paid.hold.from } : {}) };
  else {
    await warnAgentCap(user, paid);
    receipt = paid;
  }

  let ground: Grounding;
  let tasks: Task[] = [];
  let createdAt: string;
  // Items the output check refused in `enforce` and that were not saved (rule 801), out of `made` generated.
  let held = 0;
  let made = 0;
  // Everything up to the commit is inside the try: the credits are already charged, and a failed read, generation, task
  // save or commit must reach the refund below. Before 2026-10-01 only the read and the generation were: a save that
  // failed, or a run killed while saving, kept the charge with no plan, and the Sunday retry charged again.
  try {
    const [prefs, memory, stats, feedback] = await Promise.all([listPreferencesFor(scope, agent), memoryBlock(scope), statsFor(type, scope), feedbackFor(scope, agent, { gov })]);
    // A lead brief rides along only when there is one, so every other batch's prompts and judge grounding are unchanged.
    const lead = opts.leadBrief?.trim() ? { leadBrief: opts.leadBrief } : {};
    ground = { notes: opts.notes, memory, stats, ...lead };
    const items: Generated[] = await generate(type, brand, prefs, opts.notes, { memory, reviewer: gov.reviewer, noEmDash: gov.noEmDash, crossReview: gov.crossReview !== false, meter: user.email, stats, feedback, model, layers, agentScope: scopeModes.prompt === "on", ...(opts.count ? { count: opts.count } : {}), ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}), ...lead });
    createdAt = new Date().toISOString();
    const brief = opts.brief ?? briefOf(opts.notes);
    // One stamp for the batch: the blocks are the same for every item (they hash the layers, not the item).
    const ins = instructionBlocks(layers, agent).stamp;
    tasks = items.map((it) => taskFromItem(it, { type, brand, autoApprove: gov.autoApprove[type], source: opts.source, brief, forcePending: opts.forcePending, createdAt, parent: opts.parent, ins }));
    made = tasks.length;
    // Layer 4, the output check on the items (rule 801; spec section 6), between generation and saving: each item's title and
    // body, as the owning agent's text, five at a time (`pmap`, never one await per item). `enforce`: a refused item is not
    // saved; when none is left, or any is refused in a claim's batch (`once`, which charges and refunds only whole), the batch
    // throws here and the catch below refunds all of it; otherwise the rest is saved and the refused items' share is refunded
    // after the commit. `shadow`: every item is saved, and the check runs beside the save and is awaited before `generateBatch`
    // returns, so its log lines (with `itemId`) are written. An error lets the item through; while paused nothing is asked.
    const output = scopeModes.output;
    if (output !== "off" && tasks.length) {
      const lang = brand.languages[0] ?? (user.lang === "en" ? "en" : "ar");
      // `tasks` is read when the names arrive: in `enforce` it is reassigned only after `run` is awaited, in `shadow` never.
      const run = brandNames().then((otherBrands) => pmap(tasks, (t) => scopeCheck("output", output, itemText(t), { user, agent, where: "items", lang, brand: { name: brand.name, industry: brand.industry ?? "" }, otherBrands, itemId: t.id, deadline: opts.deadline }), 5));
      if (output === "enforce") {
        const checks = await run;
        const first = checks.find((c): c is Extract<ScopeDecision, { block: true }> => c.block);
        if (first) {
          const kept = tasks.filter((_, i) => !checks[i].block);
          if (!kept.length || opts.once) {
            tasks = [];
            throw new AgentScopeRefused(first.verdict, first.reply);
          }
          held = tasks.length - kept.length;
          tasks = kept;
        }
      } else late.push(run.catch((e) => log.error("agent scope items check failed", e)));
    }
    // Together, not one round trip after another (Redis is HTTP per command). Every save settles before the guard
    // decides, so a refund below never races a save still landing.
    const saved = await Promise.allSettled(tasks.map((t) => saveTask(scope, t, true)));
    const lost = saved.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (lost) throw lost.reason;
    await opts.commit?.(tasks);
  } catch (error) {
    // With the receipt (or the claim's hold), so the agent's monthly counter comes down with the balance. Once: a claim's
    // hold is dropped in the same save. A refunded batch keeps no task (rule 334): the ones saved before a save or the
    // commit failed are removed, or they stayed approvable for free and the Sunday retry planned the week a second time.
    // Their removal failing is logged and never stops the refund.
    const back = opts.once ? refundOnce(user.email, opts.once).then((r) => r.credits) : refund(user.email, cost, receipt);
    const drop = tasks.length ? dropTasks(scope, tasks).catch((e) => log.error("refunded batch tasks not removed", e)) : null;
    const [credits] = await Promise.all([back, opts.settle?.(), drop]);
    user.credits = credits;
    return { ok: false, reason: "failed", error, credits };
  }

  // The share of the items the output check held back (rule 801), after the commit and outside the guard: the rest is saved and
  // paid for. `Math.ceil(charged * held / made)`, rounded in the owner's favour, of what this batch charged; with the charge's
  // receipt, so the agent's monthly counter comes down with the balance, exactly as the whole-batch refund above does. Never a
  // claim's batch (`once` throws above instead). A refund that cannot be written is logged by name and the batch kept: the
  // balance then lost the whole price, and the activity row and `cost` say so.
  let back = 0;
  if (held > 0) {
    const share = Math.ceil((charged * held) / made);
    try {
      user.credits = await refund(user.email, share, receipt);
      back = share;
    } catch (e) {
      // The error's name and where the charge was booked (agent, month, the top-up lots' ids), never the owner's email or text.
      log.error("agent scope partial refund failed", { error: e, agent: receipt.agent, month: receipt.month, lots: receipt.from?.lots.map((l) => l.id) ?? [], share });
    }
  }
  const net = charged - back;
  // After the guard: the work is saved and paid for, so a failed log write must not refund it. The batch's one activity
  // row and, when other agents reviewed it, one row per reviewer.
  const done: Activity = { at: createdAt, kind: "generated", agent, by: await who(), via: opts.via, type, tasks: tasks.map((t) => t.id), count: tasks.length, credits: net };
  await recordActivity(scope, [done, ...crossReviewRows(tasks, createdAt, opts.via)]);
  // The judge scores against what the agent had, and against the count the owner asked for.
  judgeLater(scope, user.email, brand, tasks, opts.count, { ...ground, via: opts.via, generatedBy: model, layers });
  return { ok: true, tasks, credits: user.credits, receipt, cost: net, agent, gov, ...(modelRejected ? { modelRejected } : {}), ...(held > 0 ? { held, refunded: back } : {}) };
}
