/**
 * Handoffs: Majed, the lead, proposes work for the agents who own it, and a login of the account runs it.
 *
 * Majed proposes in chat with the `propose_handoff` tool (src/lib/chat.ts): one to three items, each a task type owned
 * by another agent and a brief for that agent. Proposing is free and runs nothing. Everything the owner is asked to
 * trust is set here, in code, never by the model or the request: which agent does each item (`agentForTask`), what it
 * costs (`TASK_COST`), its status, the scope it lives in (`sc(u)`) and who proposed it (the chat turn's `by`). The model
 * writes only the type (from a closed list) and the brief, and the brief is a request for work, never a source: it
 * reaches the agent, its reviewer, the cross-reviewers and the judge as a labelled `<lead_brief>` data block
 * (src/lib/json.ts), never as the owner's notes.
 *
 * A login runs one item per request (POST /api/handoffs/{id}/run) under the handoff's lock, through `generateBatch` with
 * the item's type, so the charge, the agent's cap, the refund on a failure, the brand gate and auto-approval are the
 * ones every batch has. Depth is 1: a run is a generation, which offers no tools, so nothing a handoff makes can propose
 * another handoff; only a chat turn with Majed can (`createHandoff` has one caller, and it checks the talking agent).
 * No MCP tool proposes, runs, declines or lists handoffs.
 *
 * Majed's auto-run (opt-in, off by default: `Governance.majedAutoHandoff`) may start one eligible item a day from the
 * routines cron instead of a login (src/lib/handoff-auto.ts). Which items are eligible is decided here (`autoBlock`),
 * so the cron, the run itself, the chat card, the Governance page and Majed's tool reply all read the same rule. Only a
 * proposal whose card the owner has is eligible: chat() marks it `shownAt` once the reply carrying the card is saved in
 * the thread (`markShown`), and a proposal whose thread was deleted is not.
 *
 * Keys, all under the caller's own scope: the record `handoff:{scope}:{id}` (180 days from its last write), the index
 * `handoffs:{scope}` (CAPS.handoffs newest ids; every id pushed past the cap is removed with its record by the proposal
 * that pushed it, so no record outlives the index), the lock `handofflock:{scope}:{id}`, and for the auto-run each
 * item's attempt counter `handofftry:{scope}:{id}:{n}` (8 days). A record is rewritten only while it exists (`setXx`),
 * so a run that ends after its proposal fell off the index cannot bring it back. `wipeAccount` deletes them all through
 * `handoffKeys`, with each item's auto-run notification marker.
 */
import { randomBytes } from "crypto";
import { CAPS, db } from "./db";
import type { User } from "./auth";
import { agentForTask, type AgentId } from "./agents";
import { TASK_COST, TASK_TYPES, type TaskType } from "./tasks";
import type { Task } from "./brand";
import type { ChatItem } from "./chat";
import { isBy, type By } from "./actor";
import { recordActivity } from "./activity";
import { BATCH_RUN_MIN_MS, generateBatch, type BatchRefusal, type BatchResult } from "./generate-batch";
import { LEAD_BRIEF_MAX } from "./json";
import { getGov, type Governance } from "./governance";
import { estimateBatch } from "./task-costs";
import { maxCostPerCreditUsd } from "./pricing";
import { log } from "./log";

/** A handoff id: 16 hex characters, checked before any key is built from it. */
export const HANDOFF_ID = /^[a-f0-9]{16}$/;
export const isHandoffId = (v: unknown): v is string => typeof v === "string" && HANDOFF_ID.test(v);

/** At most this many items in one proposal. */
export const HANDOFF_MAX_ITEMS = 3;
/** Longest brief per item, in characters: what the child batch's `<lead_brief>` block can carry. */
export const HANDOFF_BRIEF_MAX = LEAD_BRIEF_MAX;
/** Longest owner message kept with a proposal: the owner's own words that led to it. */
export const HANDOFF_OWNER_MSG_MAX = 500;
/** Longest "why" line Majed gives the owner. */
export const HANDOFF_WHY_MAX = 300;
/** A record lives this long after its last write. */
export const HANDOFF_TTL_S = 180 * 86400;
/**
 * The run's lock, held for the whole run: at least the run route's `maxDuration` (300 s), so while a run is alive no
 * other run or decline of the same handoff can start, and a "running" item seen under a lock this old belongs to a run
 * that no longer exists.
 */
export const HANDOFF_RUN_LOCK_S = 300;
/** A decline only rewrites the record. */
const DECLINE_LOCK_S = 10;
/** A batch (generation, reviewer, cross-review) needs this much of the request's time left before it is charged. */
export const HANDOFF_RUN_MIN_MS = BATCH_RUN_MIN_MS;

/**
 * The types Majed may hand off: every task type owned by another agent. Never his own (he writes those himself, with
 * generate_content), never Reem's (she owns none), and never a render: images and videos are made from an inbox item.
 */
export const HANDOFF_TYPES: readonly TaskType[] = TASK_TYPES.filter((t) => { const a = agentForTask(t).id; return a !== "majed" && a !== "reem"; });
export const isHandoffType = (v: unknown): v is TaskType => typeof v === "string" && (HANDOFF_TYPES as readonly string[]).includes(v);

export type HandoffItemStatus = "proposed" | "running" | "done" | "failed" | "declined";
export type HandoffStatus = "proposed" | "running" | "done" | "declined";
export type HandoffOrigin = "web_chat" | "mcp";

export type HandoffItem = {
  type: TaskType;
  /** The agent who owns `type` (`agentForTask`), in code. */
  agent: AgentId;
  /** Majed's brief for this item: model-written, at most HANDOFF_BRIEF_MAX characters. */
  brief: string;
  /** Credits: `TASK_COST[type]` when proposed, what the run charged once it is done. */
  cost: number;
  status: HandoffItemStatus;
  /** The tasks the run made, when done. */
  tasks?: string[];
  /** Who pressed Run (the request's session), and when the run started or ended. */
  ranBy?: By;
  /** Who declined it. */
  declinedBy?: By;
  at?: string;
};

export type Handoff = {
  id: string;
  /** The lead who proposed it. Only Majed proposes. */
  agent: "majed";
  /** The login of the chat turn (`byOf`, or the turn's `by`). */
  requestedBy: By;
  /** Where it was proposed. Only the app's chat proposes today; "mcp" is reserved and nothing creates it. */
  origin: HandoffOrigin;
  /** The conversation it was proposed in, when it was not the default thread. */
  conv?: string;
  /** The owner's own latest message of the turn, at most HANDOFF_OWNER_MSG_MAX characters. */
  ownerMsg: string;
  /** Majed's one line on why, for the owner. */
  why?: string;
  items: HandoffItem[];
  status: HandoffStatus;
  createdAt: string;
  /**
   * When the reply that carries this proposal's card was saved in the thread (`markShown`, called by chat()). Until then
   * the owner has no card to run or decline it from (the turn may still fail after the tool saved the record), so Majed's
   * auto-run never starts it.
   */
  shownAt?: string;
};

const key = (scope: string, id: string) => `handoff:${scope}:${id}`;
const indexKey = (scope: string) => `handoffs:${scope}`;
const lockKey = (scope: string, id: string) => `handofflock:${scope}:${id}`;
/** Majed's auto-run: charges of item `n` that were neither refunded nor refused (the routines' `routinetry:` for handoffs). */
export const autoTryKey = (scope: string, id: string, n: number) => `handofftry:${scope}:${id}:${n}`;
/** The notification fingerprint of an auto-run of item `n`: the owner is told once per item, ever. */
export const handoffFingerprint = (scope: string, id: string, n: number) => `handoff:${scope}:${id}:${n}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY_MS = 864e5;

// ── Majed's auto-run: which items it may start ───────────────────────────────────────────────────────────────────

/** Only proposals this recent. An older one waits for the owner, however long it stays open. */
export const AUTO_HANDOFF_MAX_AGE_DAYS = 7;
/** Only proposals of at most this many items… */
export const AUTO_HANDOFF_MAX_ITEMS = 3;
/** …costing at most this many credits in all, at today's `TASK_COST`, whatever runs of it first. */
export const AUTO_HANDOFF_MAX_CREDITS = 12;

/** Why the auto-run may not start an item. Every reason leaves the item exactly as it is, for the owner. */
export type AutoBlock = "off" | "not_majed" | "origin" | "requester" | "not_shown" | "thread_gone" | "bad_item" | "not_proposed" | "too_old" | "no_cap" | "floor" | "ceiling";

/**
 * Whether the auto-run may start a batch of `type` at all: the 60% margin floor (rule 241) checked the way it is for
 * every cron-driven type. The auto-run starts from the routines cron at 06:00 UTC, once a day per brand, so it usually
 * finds the prompt cache cold, and the floor checks cron types on a cold cache (founder decision, 2026-09-29): the
 * batch's estimated cost per credit on a COLD cache (`estimateBatch`, src/lib/task-costs.ts) must be at most the
 * ceiling (`maxCostPerCreditUsd`, src/lib/pricing.ts). Since each type got its own writer (rule 901, 2026-10-09) no type
 * is left out: `article`, the last one, is written by Sonnet 5.5 at $0.0482 per credit cold ($0.0773 on Opus 5.5), and
 * the dearest cold types are `unit_economics` and `decision_memo` at $0.0515. A change to a price, a credit count or a rate moves
 * the list with it. The estimate counts neither the lead brief nor the cross-agent review (docs/system/costs.md §3 and
 * §5 work those out by hand). Fails closed: a type the estimate cannot price is never started.
 *
 * Estimated on the generation default, not on the brand's pick: `autoBlock` is pure and its callers (the Governance list
 * and the cron's run, src/lib/handoff-auto.ts) do not read the brand file. The batch itself runs on the pick when route()
 * accepts it. That is safe because the default's check is the strictest: tests/pricing-floor.test.ts checks every
 * catalog model customers may pick on every type it allows, cold, with no exemption (only the default has one, for the
 * two types this check leaves out), and pins that every type passing here keeps the floor cold on every pick. A pick
 * not allowed for a type falls back to the default, which is what this checks.
 */
export function autoUnderFloor(type: TaskType): boolean {
  try {
    return estimateBatch(type, { cache: "cold" }).usdPerCredit <= maxCostPerCreditUsd();
  } catch {
    return false;
  }
}

/**
 * What `autoBlock` cannot read from the record. `threadGone`: the conversation the card sits in was deleted (read by the
 * caller, `liveConversations`). `beforeCard`: the question is asked for the proposal's own tool reply, whose card is
 * about to be shown with that reply, so `shownAt` is not required yet; every other rule applies.
 */
export type AutoContext = { threadGone?: boolean; beforeCard?: boolean };

/**
 * Whether Majed's auto-run may start item `n` of `h` under the brand's settings `gov` at `now`, or why not. Pure; the
 * run checks it again under the handoff's lock with the settings read again. All of these must hold:
 * - the owner switched the auto-run on (`majedAutoHandoff === true`);
 * - the proposal is Majed's, made in the app's chat (`origin: "web_chat"`) by the account's OWNER (`requestedBy.kind`):
 *   a member's, support's or a connected app's proposal is never started without a login pressing Run;
 * - the owner has its card: the reply carrying it was saved (`shownAt`), and its conversation still exists;
 * - the item is `proposed`: never one that ran, failed, is running or was declined (a failed item waits for the owner);
 * - the proposal is at most AUTO_HANDOFF_MAX_AGE_DAYS old;
 * - the agent that owns the item's type has an owner-set monthly cap, so every auto-run charge is capped by the owner;
 * - the item's type keeps the margin floor on a cold cache (`autoUnderFloor`): every type today, since rule 901;
 * - the whole proposal is within the ceiling: at most AUTO_HANDOFF_MAX_ITEMS items and AUTO_HANDOFF_MAX_CREDITS credits.
 */
export function autoBlock(h: Pick<Handoff, "agent" | "origin" | "requestedBy" | "items" | "createdAt" | "shownAt">, n: number, gov: Pick<Governance, "majedAutoHandoff" | "agentCaps">, now: number = Date.now(), ctx: AutoContext = {}): AutoBlock | null {
  if (gov.majedAutoHandoff !== true) return "off";
  if (h.agent !== "majed") return "not_majed";
  if (h.origin !== "web_chat") return "origin";
  if (h.requestedBy?.kind !== "owner") return "requester";
  if (!ctx.beforeCard && !(typeof h.shownAt === "string" && h.shownAt)) return "not_shown";
  if (ctx.threadGone) return "thread_gone";
  if (!Number.isInteger(n) || n < 0 || n >= h.items.length) return "bad_item";
  const it = h.items[n];
  if (it.status !== "proposed") return "not_proposed";
  const at = Date.parse(h.createdAt);
  if (Number.isNaN(at) || now - at > AUTO_HANDOFF_MAX_AGE_DAYS * DAY_MS) return "too_old";
  const cap = gov.agentCaps?.[agentForTask(it.type).id];
  if (typeof cap !== "number" || !Number.isFinite(cap)) return "no_cap";
  if (!autoUnderFloor(it.type)) return "floor";
  if (h.items.length > AUTO_HANDOFF_MAX_ITEMS || h.items.reduce((s, i) => s + TASK_COST[i.type], 0) > AUTO_HANDOFF_MAX_CREDITS) return "ceiling";
  return null;
}
/** The items of `h` the auto-run may start now, in order. */
export const autoItems = (h: Handoff, gov: Pick<Governance, "majedAutoHandoff" | "agentCaps">, now: number = Date.now(), ctx: AutoContext = {}) => h.items.flatMap((_, n) => (autoBlock(h, n, gov, now, ctx) ? [] : [n]));

// Control characters, zero-width spaces and bidi overrides hide or reorder text on the owner's screen; line breaks stay.
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f\u200b\u202a-\u202e\u2066-\u2069]/g;
/** Model or owner text as stored: hidden characters dropped, trimmed, cut to `max`. */
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(HIDDEN, "").trim().slice(0, max).trim() : "");

/** The handoff's own status, from its items: open while any item can still run. */
export function handoffStatus(items: readonly Pick<HandoffItem, "status">[]): HandoffStatus {
  if (items.some((i) => i.status === "running")) return "running";
  if (items.some((i) => i.status === "proposed" || i.status === "failed")) return "proposed";
  return items.every((i) => i.status === "declined") ? "declined" : "done";
}

/** A "running" item whose run started longer ago than the run's lock can live: that run no longer exists. */
const staleRun = (it: HandoffItem, now: number) => it.status === "running" && (!it.at || now - Date.parse(it.at) > HANDOFF_RUN_LOCK_S * 1000);
/** Why an item cannot be run or declined now, or null when it can: proposed, failed, or a run that died. */
function blocked(it: HandoffItem, now: number): "running" | "done" | "declined" | null {
  if (it.status === "proposed" || it.status === "failed" || staleRun(it, now)) return null;
  return it.status === "running" ? "running" : it.status;
}

// ── The proposal (chat) ──────────────────────────────────────────────────────────────────────────────────────────

export type Proposal = { items: { type: TaskType; brief: string }[]; why?: string };

/**
 * The model's tool input as a proposal, or the reason it is not one, as a sentence for the model. Only `items[].type`,
 * `items[].brief` and `why` are read: a cost, agent, status, scope or id in the input is ignored, whatever it says.
 */
export function parseProposal(input: Record<string, unknown>): { ok: true; proposal: Proposal } | { ok: false; error: string } {
  const raw = input.items;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > HANDOFF_MAX_ITEMS) return { ok: false, error: `Not proposed: give 1 to ${HANDOFF_MAX_ITEMS} items, each with a type and a brief. Nothing was saved.` };
  const items: Proposal["items"] = [];
  for (const [i, v] of raw.entries()) {
    const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const type = o.type;
    if (!isHandoffType(type)) {
      const own = typeof type === "string" && (TASK_TYPES as readonly string[]).includes(type) && agentForTask(type as TaskType).id === "majed";
      return { ok: false, error: own
        ? `Not proposed: item ${i + 1} (${type}) is your own work; create it yourself with generate_content. Nothing was saved.`
        : `Not proposed: item ${i + 1} has no valid type. Types you can hand off: ${HANDOFF_TYPES.join(", ")}. Images and videos are never handed off. Nothing was saved.` };
    }
    const brief = clean(o.brief, HANDOFF_BRIEF_MAX);
    if (!brief) return { ok: false, error: `Not proposed: item ${i + 1} (${type}) needs a brief for ${agentForTask(type).name.en}. Nothing was saved.` };
    items.push({ type, brief });
  }
  const why = clean(input.why, HANDOFF_WHY_MAX);
  return { ok: true, proposal: { items, ...(why ? { why } : {}) } };
}

/** A conversation id as the chat page accepts one; anything else is the default thread and is not kept. */
const convOf = (conv: string | undefined) => (typeof conv === "string" && /^[a-f0-9]{6,16}$/.test(conv) ? conv : undefined);

/**
 * Save a proposal under `scope` (the chat turn's own): the record, its id at the head of the capped index, and one
 * `handoff_proposed` activity row. Charges nothing. Called only by the chat tool, which checks that Majed is talking.
 */
export async function createHandoff(scope: string, p: { proposal: Proposal; requestedBy: By; origin: HandoffOrigin; conv?: string; ownerMsg: string }): Promise<Handoff> {
  const id = randomBytes(8).toString("hex");
  const createdAt = new Date().toISOString();
  const items: HandoffItem[] = p.proposal.items.map((it) => ({ type: it.type, agent: agentForTask(it.type).id, brief: it.brief, cost: TASK_COST[it.type], status: "proposed" }));
  const conv = convOf(p.conv);
  const { kind, email, role, imp, job } = p.requestedBy;
  // Only the fields a `by` has: nothing else the caller's object carries is stored.
  const requestedBy: By = { kind, ...(email ? { email } : {}), ...(role ? { role } : {}), ...(imp ? { imp } : {}), ...(job ? { job } : {}) };
  const h: Handoff = { id, agent: "majed", requestedBy, origin: p.origin, ...(conv ? { conv } : {}), ownerMsg: clean(p.ownerMsg, HANDOFF_OWNER_MSG_MAX), ...(p.proposal.why ? { why: p.proposal.why } : {}), items, status: "proposed", createdAt };
  await Promise.all([
    db.set(key(scope, id), h, HANDOFF_TTL_S),
    db.lpush(indexKey(scope), id),
    recordActivity(scope, [{ at: createdAt, kind: "handoff_proposed", agent: "majed", by: requestedBy, via: "chat", count: items.length, credits: items.reduce((s, i) => s + i.cost, 0), outcome: `handoff:${id}`, note: items.map((i) => i.type).join(",") }]),
  ]);
  await evictOverflow(scope);
  return h;
}

/**
 * Every id past the cap goes with its record, lock and attempt counters, so nothing outlives the index wipeAccount reads.
 * Read AFTER this proposal's own push, and removed by value (LREM), never by position (LTRIM): an id pushed past the cap
 * is past it when the proposal that pushed it reads, so two proposals at once each see, and delete, what they pushed off.
 * A position trim could drop an id another proposal pushed off between this read and the trim, without its record.
 * The auto-run's notification marker (keyed by the account's email, not the scope) is left to its 8-day expiry: a
 * proposal is pushed off only after 199 newer ones, and the auto-run never starts one older than 7 days.
 */
async function evictOverflow(scope: string) {
  const over = await db.lrange(indexKey(scope), CAPS.handoffs, -1);
  if (!over.length) return;
  await Promise.all([
    ...over.map((v) => db.lrem(indexKey(scope), v)),
    ...over.filter(isHandoffId).flatMap((old) => [db.del(key(scope, old)), db.del(lockKey(scope, old)), ...Array.from({ length: HANDOFF_MAX_ITEMS }, (_, n) => db.del(autoTryKey(scope, old, n)))]),
  ]);
}

/**
 * The reply that carries the proposal's card was saved in the thread: from now on the owner has the card (Run, Decline),
 * and Majed's auto-run may consider it. Called by chat() right after it saves that reply; a turn that failed after the
 * proposal was saved never marks it, and such a proposal never starts on its own. Under the handoff's lock (waited for
 * briefly, like a decline) and only onto a record that still exists. Never throws: a mark that fails leaves the proposal
 * out of the auto-run, the safe side. True when it is marked.
 */
export async function markShown(scope: string, id: string): Promise<boolean> {
  if (!isHandoffId(id)) return false;
  try {
    return (await withShortLock(scope, id, async () => {
      const h = await getHandoff(scope, id);
      if (!h) return false;
      if (h.shownAt) return true;
      return save(scope, { ...h, shownAt: new Date().toISOString() });
    })) ?? false;
  } catch (e) {
    log.error("handoff mark failed", e);
    return false;
  }
}

/**
 * The chat tool's reply to the model once a proposal is saved: each item with its agent and cost, and what to say.
 * `auto` is the items Majed's auto-run may start (`autoItems`): when there are any, the model is told to say so plainly
 * instead of "nothing runs until Run", which would then be untrue.
 */
export function proposalText(h: Handoff, credits: number, auto: readonly number[] = []): string {
  const lines = h.items.map((it, i) => `${i + 1}. ${agentLabel(it.type)}: ${it.type}, ${it.cost} credit${it.cost === 1 ? "" : "s"}`);
  const total = h.items.reduce((s, i) => s + i.cost, 0);
  const when = auto.length
    ? `The owner turned on Majed's auto-run in Governance: unless the owner runs or declines them first, Thakeen may start item${auto.length === 1 ? "" : "s"} ${auto.map((n) => n + 1).join(", ")} by itself at the daily run (06:00 UTC), one item a day, charged to the item's agent under the monthly cap the owner set; what it writes waits in the inbox for the owner's approval. Say this plainly, and say that any other item runs only when the owner presses Run on the card.`
    : "Say plainly that nothing runs or is charged until the owner presses Run on the card.";
  return `Proposed handoff ${h.id}. Nothing ran and nothing was charged. The owner sees a card under your reply with each item, its agent, its cost and a Run button:\n${lines.join("\n")}\nTotal if every item runs: ${total} credits (the owner has ${credits}). In your reply, list each item with its agent and cost and the total. ${when} Do not repeat the briefs word for word.`;
}
const agentLabel = (type: TaskType) => { const a = agentForTask(type); return `${a.name.en} (${a.role.en})`; };

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ITEM_STATUSES: readonly HandoffItemStatus[] = ["proposed", "running", "done", "failed", "declined"];
/** A stored record read back, or null when it is not one. The agent is always the type's owner from code. */
function readHandoff(v: unknown, id: string): Handoff | null {
  if (!v || typeof v !== "object") return null;
  const h = v as Partial<Handoff>;
  if (h.id !== id || h.agent !== "majed" || !isBy(h.requestedBy) || typeof h.createdAt !== "string" || !Array.isArray(h.items) || h.items.length < 1 || h.items.length > HANDOFF_MAX_ITEMS) return null;
  const items: HandoffItem[] = [];
  for (const it of h.items as unknown[]) {
    const o = it as Partial<HandoffItem> | null;
    if (!o || !isHandoffType(o.type) || typeof o.brief !== "string" || !ITEM_STATUSES.includes(o.status as HandoffItemStatus)) return null;
    items.push({ ...o, type: o.type, agent: agentForTask(o.type).id, brief: o.brief, cost: typeof o.cost === "number" && Number.isFinite(o.cost) ? o.cost : TASK_COST[o.type], status: o.status as HandoffItemStatus, ...(Array.isArray(o.tasks) ? { tasks: o.tasks.filter((t): t is string => typeof t === "string") } : {}) });
  }
  return { ...(h as Handoff), items, status: handoffStatus(items), ownerMsg: typeof h.ownerMsg === "string" ? h.ownerMsg : "" };
}

/** One handoff of `scope` (always the caller's own `sc(u)`), or null: a malformed id builds no key. */
export async function getHandoff(scope: string, id: string): Promise<Handoff | null> {
  if (!isHandoffId(id)) return null;
  return readHandoff(await db.get<unknown>(key(scope, id)), id);
}

/** Several handoffs of `scope` in ONE request (MGET), in the order of `ids`; null for a malformed id or a record that is gone. */
export async function getHandoffs(scope: string, ids: readonly string[]): Promise<(Handoff | null)[]> {
  const ok = ids.filter(isHandoffId);
  const rows = ok.length ? await db.mget<unknown>(ok.map((id) => key(scope, id))) : [];
  const byId = new Map(ok.map((id, i) => [id, readHandoff(rows[i], id)] as const));
  return ids.map((id) => byId.get(id) ?? null);
}

/**
 * The newest `limit` handoffs of `scope`, newest first, in two requests whatever the count: one read of the index, one
 * MGET of the records. Records that are gone or malformed are left out. The auto-run's cron looks only here.
 */
export async function recentHandoffs(scope: string, limit: number): Promise<Handoff[]> {
  const n = Math.max(0, Math.min(CAPS.handoffs, Math.floor(limit)));
  if (!n) return [];
  const ids = (await db.lrange(indexKey(scope), 0, n - 1)).filter(isHandoffId);
  if (!ids.length) return [];
  const rows = await db.mget<unknown>(ids.map((id) => key(scope, id)));
  return rows.flatMap((r, i) => { const h = readHandoff(r, ids[i]); return h ? [h] : []; });
}

/**
 * Rewrite a record that exists (SET XX): false when it is gone, so a run or a decline that read it before its proposal
 * was pushed off the index never brings it back outside the index, past `wipeAccount`.
 */
const save = (scope: string, h: Handoff) => db.setXx(key(scope, h.id), { ...h, status: handoffStatus(h.items) }, HANDOFF_TTL_S);
const withItem = (h: Handoff, n: number, it: HandoffItem): Handoff => { const items = h.items.map((x, i) => (i === n ? it : x)); return { ...h, items, status: handoffStatus(items) }; };

/**
 * A task as a chat card shows it: its current text and status, and which other agents flagged it in the cross-agent
 * review with how many notes (`xflag`), so a chat card never offers Approve on an item whose notes the owner has not
 * read: the card sends the owner to the inbox, where the notes are.
 */
export const chatItemOf = (t: Task): ChatItem => {
  const flags = t.source === "external" ? [] : (t.crossReview ?? []).filter((v) => v.verdict === "flag");
  return {
    id: t.id, type: t.type, channel: t.channel, title: t.title, body: t.editedBody ?? t.body, status: t.status,
    ...(flags.length ? { xflag: flags.map((v) => ({ by: v.by, n: Math.max(1, v.notes.split("\n").filter((l) => l.trim()).length) })) } : {}),
  };
};

/** `ranAuto`: Majed's auto-run started this item (its `ranBy` is the system's `auto_handoff` job), not a login. */
export type HandoffItemView = { type: TaskType; agent: AgentId; brief: string; cost: number; status: HandoffItemStatus; made: ChatItem[]; ranAuto?: true };
/**
 * What the chat card shows. No `by` and no owner message: the card needs neither. `auto` (only when not empty) is the
 * items Majed's auto-run may start (`autoItems`), so the card never says "nothing runs until you press Run" when that
 * is not so.
 */
export type HandoffView = { id: string; agent: "majed"; status: HandoffStatus; createdAt: string; why?: string; items: HandoffItemView[]; auto?: number[] };

const ranByAuto = (it: HandoffItem) => it.ranBy?.kind === "system" && it.ranBy.job === "auto_handoff";

/**
 * The card's view of a handoff: each item with its agent, the price it would be charged now (the one it was charged,
 * once done) and the tasks it made, read in one request from the same scope, and which items the auto-run may start
 * under the brand's settings (`gov`, read here when the caller has not).
 */
export async function handoffView(scope: string, h: Handoff, gov?: Pick<Governance, "majedAutoHandoff" | "agentCaps">): Promise<HandoffView> {
  return (await handoffViews(scope, [h], gov))[0];
}

/**
 * The views of several handoffs of `scope` (the chat page's cards) in two requests whatever the count: one MGET of every
 * task they made, and the settings (unless given).
 */
export async function handoffViews(scope: string, hs: readonly Handoff[], gov?: Pick<Governance, "majedAutoHandoff" | "agentCaps">): Promise<HandoffView[]> {
  if (!hs.length) return [];
  const ids = hs.flatMap((h) => h.items.flatMap((i) => i.tasks ?? []));
  const [rows, g] = await Promise.all([ids.length ? db.mget<Task>(ids.map((id) => `task:${scope}:${id}`)) : Promise.resolve([] as (Task | null)[]), gov ?? getGov(scope)]);
  const byId = new Map(rows.filter((t): t is Task => !!t && typeof t === "object").map((t) => [t.id, t]));
  const now = Date.now();
  return hs.map((h) => viewOf(h, byId, g, now));
}

function viewOf(h: Handoff, byId: ReadonlyMap<string, Task>, g: Pick<Governance, "majedAutoHandoff" | "agentCaps">, now: number): HandoffView {
  // The card sits in its thread, so the thread exists; whether the card was shown is the record's own `shownAt`.
  const auto = autoItems(h, g, now);
  return {
    id: h.id, agent: "majed", status: handoffStatus(h.items), createdAt: h.createdAt, ...(h.why ? { why: h.why } : {}),
    items: h.items.map((it) => ({
      type: it.type, agent: agentForTask(it.type).id, brief: it.brief,
      cost: it.status === "done" ? it.cost : TASK_COST[it.type],
      // A run that died is shown as not completed, so the card offers it again.
      status: staleRun(it, now) ? "failed" : it.status,
      made: (it.tasks ?? []).flatMap((id) => { const t = byId.get(id); return t ? [chatItemOf(t)] : []; }),
      ...(ranByAuto(it) ? { ranAuto: true as const } : {}),
    })),
    ...(auto.length ? { auto } : {}),
  };
}

// ── Running and declining (the app's card) ───────────────────────────────────────────────────────────────────────

export type RunError = "not_found" | "bad_item" | "busy" | "running" | "done" | "declined" | "too_late" | BatchRefusal["reason"];
export type RunResult =
  | { ok: true; handoff: Handoff; tasks: Task[]; credits: number; cost: number }
  | { ok: false; error: RunError; handoff?: Handoff; refusal?: BatchRefusal };

/**
 * Run ONE item of one handoff of `scope` (the caller's own). Under the handoff's lock for the whole run, so the same
 * item never runs twice at once and no decline lands meanwhile. The item's status is checked in code: proposed, or a
 * failed or dead run; never done, declined or running. With less than HANDOFF_RUN_MIN_MS of the request left nothing is
 * charged, and the same deadline bounds the batch's cross-agent review. The batch goes through `generateBatch` with the
 * item's type and Majed's brief as `leadBrief` (never as notes), `source: "handoff"`, `via: "handoff"`, the item as
 * `parent`, and the login that pressed Run as `by`: its tasks follow the normal auto-approval, brand gate and
 * cross-review hold. A refusal before the charge (credits, cap, trial, paused,
 * no brand or data) leaves the item as it was; a failed generation is refunded by `generateBatch` and marks it failed.
 */
export async function runHandoffItem(user: User, scope: string, id: string, n: number, o: { by: By; deadline: number }): Promise<RunResult> {
  if (!isHandoffId(id)) return { ok: false, error: "not_found" };
  const out = await withRunLock(scope, id, async (): Promise<RunResult> => {
    const h = await getHandoff(scope, id);
    if (!h) return { ok: false, error: "not_found" };
    if (!Number.isInteger(n) || n < 0 || n >= h.items.length) return { ok: false, error: "bad_item", handoff: h };
    const no = blocked(h.items[n], Date.now());
    if (no) return { ok: false, error: no, handoff: h };
    if (o.deadline - Date.now() < HANDOFF_RUN_MIN_MS) return { ok: false, error: "too_late", handoff: h };
    return runItemLocked(user, scope, h, n, { by: o.by, deadline: o.deadline });
  });
  return out ?? { ok: false, error: "busy" };
}

/**
 * Run `fn` holding the handoff's lock for a short rewrite (a decline, `markShown`): waited for up to about a second, then
 * null (busy). Released afterwards, also on a throw.
 */
async function withShortLock<T>(scope: string, id: string, fn: () => Promise<T>): Promise<T | null> {
  const lk = lockKey(scope, id);
  let got = false;
  for (let i = 0; i < 20 && !got; i++) {
    got = await db.lock(lk, DECLINE_LOCK_S);
    if (!got) await sleep(50);
  }
  if (!got) return null;
  try {
    return await fn();
  } finally {
    await db.unlock(lk).catch((e) => log.error("handoff lock release failed", e));
  }
}

/**
 * Run `fn` holding the handoff's run lock (HANDOFF_RUN_LOCK_S, the whole run), or answer null at once when someone else
 * holds it. Released afterwards, also on a throw. The owner's Run and Majed's auto-run share it, so an item never runs
 * twice at once and no decline lands in the middle of a run.
 */
export async function withRunLock<T>(scope: string, id: string, fn: () => Promise<T>): Promise<T | null> {
  if (!isHandoffId(id)) return null;
  const lk = lockKey(scope, id);
  if (!(await db.lock(lk, HANDOFF_RUN_LOCK_S))) return null;
  try {
    return await fn();
  } finally {
    // A failed release must not turn a finished run into an error: the lock's TTL frees it.
    await db.unlock(lk).catch((e) => log.error("handoff lock release failed", e));
  }
}

/** What differs between the owner's Run and Majed's auto-run, all set in code. */
export type RunOpts = {
  /** The login that pressed Run, or `systemBy("auto_handoff")`. Kept as the item's `ranBy` and on the activity rows. */
  by: By;
  /** The auto-run: its tasks carry `parent.auto` (they count as autonomous) and always wait for the owner. */
  auto?: boolean;
  /** The settings the caller already read under the lock (the auto-run): the charge uses their caps. */
  gov?: Governance;
  /** Runs when the batch ends without keeping a charge (refused or refunded): the auto-run gives back its attempt. */
  settle?: () => Promise<unknown>;
  /** When the request or invocation ends: bounds the batch's cross-agent review (`BatchOpts.deadline`). */
  deadline?: number;
};

/**
 * The run itself, for a caller that holds the run lock (`withRunLock`) and has checked the item. The item is written
 * `running` with `by`, the batch goes through `generateBatch` with the item's type and Majed's brief as `leadBrief`
 * (never as notes), `source: "handoff"`, `via: "handoff"` and the item as `parent`: its tasks follow the normal
 * auto-approval, brand gate and cross-review hold, except an auto-run's, which always wait (`forcePending`). A refusal
 * before the charge (credits, cap, trial, paused, no brand or data) leaves the item as it was; a failed generation is
 * refunded by `generateBatch` and marks it failed. One `handoff_run` row for a run that charged. A record that is gone
 * by the time the item is marked running (pushed off the index) is "not_found", before any charge.
 */
export async function runItemLocked(user: User, scope: string, h: Handoff, n: number, o: RunOpts): Promise<RunResult> {
  const id = h.id;
  const it = h.items[n];
  if (!(await save(scope, withItem(h, n, { ...it, status: "running", ranBy: o.by, at: new Date().toISOString() })))) {
    await o.settle?.();
    return { ok: false, error: "not_found" };
  }
  const parent = { handoff: id, item: n, ...(h.conv ? { conv: h.conv } : {}), ...(o.auto ? { auto: true as const } : {}) };
  let r: BatchResult;
  try {
    r = await generateBatch(user, scope, { type: it.type, leadBrief: it.brief, source: "handoff", via: "handoff", parent, by: o.by, ...(o.auto ? { forcePending: true } : {}), ...(o.gov ? { gov: o.gov } : {}), ...(o.settle ? { settle: o.settle } : {}), ...(o.deadline !== undefined ? { deadline: o.deadline } : {}) });
  } catch (e) {
    // Unexpected (generateBatch refunds its own failures): the item did not complete, and the owner may run it again.
    await save(scope, withItem(h, n, { ...it, status: "failed", ranBy: o.by, at: new Date().toISOString() })).catch(() => {});
    throw e;
  }
  const at = new Date().toISOString();
  if (r.ok) {
    const tasks = r.tasks.map((t) => t.id);
    const next = withItem(h, n, { ...it, status: "done", tasks, cost: r.cost, ranBy: o.by, at });
    await Promise.all([save(scope, next), recordActivity(scope, [{ at, kind: "handoff_run", agent: "majed", by: o.by, via: "handoff", type: it.type, tasks, count: tasks.length, outcome: `done:${id}:${n}` }])]);
    return { ok: true, handoff: next, tasks: r.tasks, credits: r.credits, cost: r.cost };
  }
  if (r.reason === "failed") {
    const next = withItem(h, n, { ...it, status: "failed", ranBy: o.by, at });
    await Promise.all([save(scope, next), recordActivity(scope, [{ at, kind: "handoff_run", agent: "majed", by: o.by, via: "handoff", type: it.type, outcome: `failed:${id}:${n}` }])]);
    return { ok: false, error: "failed", handoff: next, refusal: r };
  }
  // Refused before any charge: the item is exactly as it was.
  await save(scope, h);
  return { ok: false, error: r.reason, handoff: h, refusal: r };
}

export type DeclineError = "not_found" | "bad_item" | "busy" | "running" | "done" | "declined" | "nothing";

/**
 * Decline one item (`n`), or every item that can still run (no `n`), of one handoff of `scope`. Under the same lock as a
 * run, waited for briefly: a decline never lands in the middle of a run. Charges and generates nothing.
 */
export async function declineHandoff(scope: string, id: string, n: number | undefined, by: By): Promise<{ ok: true; handoff: Handoff; declined: number } | { ok: false; error: DeclineError; handoff?: Handoff }> {
  if (!isHandoffId(id)) return { ok: false, error: "not_found" };
  return (await withShortLock(scope, id, () => declineLocked(scope, id, n, by))) ?? { ok: false, error: "busy" };
}

async function declineLocked(scope: string, id: string, n: number | undefined, by: By): Promise<{ ok: true; handoff: Handoff; declined: number } | { ok: false; error: DeclineError; handoff?: Handoff }> {
  const h = await getHandoff(scope, id);
  if (!h) return { ok: false, error: "not_found" };
  const now = Date.now();
  let which: number[];
  if (n === undefined) which = h.items.flatMap((it, i) => (blocked(it, now) ? [] : [i]));
  else {
    if (!Number.isInteger(n) || n < 0 || n >= h.items.length) return { ok: false, error: "bad_item", handoff: h };
    const no = blocked(h.items[n], now);
    if (no) return { ok: false, error: no, handoff: h };
    which = [n];
  }
  if (!which.length) return { ok: false, error: "nothing", handoff: h };
  const at = new Date(now).toISOString();
  const items = h.items.map((it, i): HandoffItem => (which.includes(i) ? { ...it, status: "declined", declinedBy: by, at } : it));
  const next: Handoff = { ...h, items, status: handoffStatus(items) };
  const types = which.map((i) => h.items[i].type);
  // Written only while the record exists: a proposal pushed off the index meanwhile stays gone.
  if (!(await save(scope, next))) return { ok: false, error: "not_found" };
  await recordActivity(scope, [{ at, kind: "handoff_declined", agent: "majed", by, via: "handoff", ...(types.length === 1 ? { type: types[0] } : {}), count: which.length, outcome: `handoff:${id}`, note: types.join(",") }]);
  return { ok: true, handoff: next, declined: which.length };
}

/**
 * Every key of every handoff of `scope`, for `wipeAccount`: one read of the index, then per id the record, its lock and
 * each item's auto-run attempt counter, then the index. `seen` names a notification marker (`seenKey` with the account's
 * email, src/lib/notifications.ts): with it, each item's auto-run marker is listed too. Listed whether or not the
 * auto-run ever touched the item, since only the index says which handoffs exist.
 */
export async function handoffKeys(scope: string, seen?: (fingerprint: string) => string): Promise<string[]> {
  const ids = (await db.lrange(indexKey(scope), 0, -1)).filter(isHandoffId);
  const items = Array.from({ length: HANDOFF_MAX_ITEMS }, (_, n) => n);
  return [
    ...ids.flatMap((id) => [key(scope, id), lockKey(scope, id), ...items.map((n) => autoTryKey(scope, id, n)), ...(seen ? items.map((n) => seen(handoffFingerprint(scope, id, n))) : [])]),
    indexKey(scope),
  ];
}
