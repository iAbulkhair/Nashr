/**
 * Majed's auto-run (opt-in, OFF by default): the daily routines cron (GET /api/cron/routines, 06:00 UTC) may start, by
 * itself, one item a day per brand of a handoff Majed proposed to the owner, instead of waiting for a login to press Run
 * on the card (src/lib/handoffs.ts).
 *
 * The owner turns it on in Governance (`Governance.majedAutoHandoff`). That needs a monthly cap on at least one agent
 * Majed hands work to and an explicit confirmation in the request (`govRefusal`, src/lib/governance.ts). The model never
 * decides anything here: every rule below is checked in code, under the handoff's run lock, with the settings read again
 * there, and every refusal leaves the item exactly as it was, for the owner.
 * - the switch is on; the proposal is Majed's, from the app's chat, requested by the OWNER (never a member, support or
 *   a connected app); the owner has its card (the reply carrying it was saved, `shownAt`, and its conversation was not
 *   deleted, `liveConversations`); the item is still `proposed`; the proposal is at most 7 days old; the item's agent
 *   has an owner-set cap; the item's type keeps the 60% margin floor on the cold cache this cron usually finds
 *   (`autoUnderFloor`: never `article` or `followup_seq` today); the whole proposal is within the ceiling (3 items,
 *   12 credits): `autoBlock`;
 * - Claude paused: "retry:paused" (nothing charged; the cron asks again). No key (development mock): "skip:mock";
 * - at least HANDOFF_RUN_MIN_MS of the invocation left, else "retry:late";
 * - the weekly cap: the batch is held under the routines' per-brand cap lock (`holdBatch` with `autoHoldKey`), counted
 *   with everything else made on its own (`isAutonomous`, src/lib/brand.ts) and the routines' holds;
 * - an attempt counter per item (`autoTryKey`), counted before the charge and given back when the batch is refused or
 *   refunded, so a run the platform kills after the charge is charged at most twice, not once a day;
 * - the charge is `generateBatch`'s, to the item's agent under the owner's cap for it, by `systemBy("auto_handoff")`;
 * - every task it makes waits for the owner (`forcePending`), even for a type the owner auto-approves, and carries
 *   `parent.auto`, so it counts as autonomous;
 * - the owner is told once per item (`handoffFingerprint`), and the run is a `handoff_run` activity row by the system's
 *   `auto_handoff` job, next to the batch's `generated` row.
 *
 * Depth stays 1: the auto-run starts items of proposals made in chat; a generation offers no tools, so nothing it makes
 * proposes anything.
 *
 * The owner sees what the auto-run may start next on the Governance page, under the switch (`autoQueue`), with Decline,
 * so a card that scrolled out of its thread's window can still be declined.
 */
import { db } from "./db";
import { liveConversations } from "./conversations";
import type { User } from "./auth";
import { getGov, hasHandoffCap, type Governance } from "./governance";
import { modelState } from "./model";
import { pmap } from "./parallel";
import { TASK_COST, TASK_COUNT, type TaskType } from "./tasks";
import { agentById, type AgentId } from "./agents";
import { systemBy } from "./actor";
import { notifyItem } from "./notifications";
import { appDict } from "./app-i18n";
import { autoHoldKey, holdBatch } from "./routines";
import { HANDOFF_RUN_MIN_MS, autoBlock, autoTryKey, getHandoff, handoffFingerprint, isHandoffId, recentHandoffs, runItemLocked, withRunLock, type Handoff } from "./handoffs";

/**
 * The cron looks at the newest this many proposals of a brand whose switch is on (one index read and one MGET), never
 * at the whole index. A proposal further down waits for the owner.
 */
export const AUTO_HANDOFF_SCAN = 20;
/** Charges of one item that were neither refunded nor refused before the auto-run leaves that item to the owner. */
export const AUTO_HANDOFF_MAX_UNSETTLED = 2;
/** The attempt counter and the notification marker outlive the 7-day window a proposal can be started in. */
const AUTO_KEYS_DAYS = 8;
/** The auto-run's item id in the routines cron: one per brand scope and day (`crondone:routines:{day}:{scope}:auto_handoff`). */
export const AUTO_HANDOFF_CRON_ID = "auto_handoff";

export type AutoCandidate = { user: User; id: string; item: number };
/** One item the auto-run may start, as the Governance page lists it. */
export type AutoQueued = { id: string; item: number; type: TaskType; agent: AgentId; cost: number; createdAt: string; conv?: string };

/**
 * Every item of `scope` the auto-run may start now, oldest proposal first, under `gov`: the newest AUTO_HANDOFF_SCAN
 * proposals (two requests), and the conversations their cards sit in (one more, only for proposals that have one).
 */
async function eligible(scope: string, gov: Pick<Governance, "majedAutoHandoff" | "agentCaps">, now: number): Promise<AutoQueued[]> {
  const hs = await recentHandoffs(scope, AUTO_HANDOFF_SCAN);
  const convs = hs.flatMap((h) => (h.conv ? [h.conv] : []));
  const live = await liveConversations(scope, convs);
  // Oldest first: the proposal closest to leaving the 7-day window goes first.
  return [...hs].reverse().flatMap((h) => {
    const threadGone = !!h.conv && !live.has(h.conv);
    return h.items.flatMap((it, n) => (autoBlock(h, n, gov, now, { threadGone }) ? [] : [{ id: h.id, item: n, type: it.type, agent: it.agent, cost: TASK_COST[it.type], createdAt: h.createdAt, ...(h.conv ? { conv: h.conv } : {}) }]));
  });
}

/**
 * The cron's handoff items: for each (user, active brand) whose switch is on and has a cap on an agent Majed hands work
 * to, the first item the auto-run may start (`autoBlock`), oldest proposal first, so at most ONE per brand scope. Every
 * scope costs one settings read; only scopes with the switch on read their newest AUTO_HANDOFF_SCAN proposals and the
 * conversations of their cards, in at most three requests. All scopes are read in parallel (`pmap`).
 */
export async function dueHandoffs(users: User[], now: number = Date.now()): Promise<AutoCandidate[]> {
  const found = await pmap(users, async (u): Promise<AutoCandidate | null> => {
    const scope = u.scope ?? u.email;
    const gov = await getGov(scope);
    if (gov.majedAutoHandoff !== true || !hasHandoffCap(gov)) return null;
    const first = (await eligible(scope, gov, now))[0];
    return first ? { user: u, id: first.id, item: first.item } : null;
  });
  return found.filter((c): c is AutoCandidate => c !== null);
}

/**
 * What Majed's auto-run may start in this brand, for the Governance page: every eligible item (the cron starts the first
 * one a day), so the owner can decline any of them there, including one whose card scrolled out of its thread. Empty
 * while the switch is off or no agent Majed hands work to has a cap.
 */
export async function autoQueue(scope: string, gov: Pick<Governance, "majedAutoHandoff" | "agentCaps">, now: number = Date.now()): Promise<AutoQueued[]> {
  if (gov.majedAutoHandoff !== true || !hasHandoffCap(gov)) return [];
  return eligible(scope, gov, now);
}

/**
 * Start item `n` of handoff `id` of the user's brand scope, as Majed's auto-run. Returns the cron's outcome: "ok:N"
 * (made N tasks), "failed" (refunded; the item is marked failed and waits for the owner), a refusal of the charge
 * ("agent_cap", "no_credits", "trial_over", "no_brand", "missing_data"), "cap_reached" (weekly cap),
 * "attempts_exhausted", "skip:{reason}" (`autoBlock`, "mock" or "not_found"), "error", or a "retry:" that leaves the
 * cron's day open ("paused", "locked": a login's run or decline holds the handoff, "late"). Only "ok" charged.
 * `deadline` is when the cron's invocation ends.
 */
export async function autoRunHandoff(user: User, id: string, n: number, deadline: number): Promise<string> {
  if (!isHandoffId(id)) return "skip:not_found";
  const scope = user.scope ?? user.email;
  return (await withRunLock(scope, id, () => runLocked(user, scope, id, n, deadline))) ?? "retry:locked";
}

async function runLocked(user: User, scope: string, id: string, n: number, deadline: number): Promise<string> {
  // Before any read or charge. While paused the item stays as it is, and the next day's cron asks again.
  const state = modelState();
  if (state === "paused") return "retry:paused";
  // Without a key the output would be placeholders, which must never be charged for.
  if (state === "mock") return "skip:mock";
  // Read again under the lock: the owner may have switched it off, run, declined, removed a cap or deleted the
  // conversation since the cron's list.
  const [gov, h] = await Promise.all([getGov(scope), getHandoff(scope, id)]);
  if (!h) return "skip:not_found";
  const threadGone = !!h.conv && !(await liveConversations(scope, [h.conv])).has(h.conv);
  const no = autoBlock(h, n, gov, Date.now(), { threadGone });
  if (no) return `skip:${no}`;
  if (deadline - Date.now() < HANDOFF_RUN_MIN_MS) return "retry:late";
  const it = h.items[n];
  const hold = autoHoldKey(scope);
  const held = await holdBatch(scope, hold, TASK_COUNT[it.type], gov.weeklyCap);
  if (held) return held;
  try {
    // A platform timeout kills a run without throwing: its charge is neither refunded nor turned into items. The item
    // is then left `running` (never `proposed` again, so never auto-started again), and this count bounds the rest.
    const tries = autoTryKey(scope, id, n);
    const attempt = await db.incrby(tries, 1);
    await db.set(tries, attempt, AUTO_KEYS_DAYS * 86400); // incrby alone leaves the counter without an expiry
    if (attempt > AUTO_HANDOFF_MAX_UNSETTLED) return "attempts_exhausted";
    const settle = () => db.set(tries, attempt - 1, AUTO_KEYS_DAYS * 86400);
    let r: Awaited<ReturnType<typeof runItemLocked>>;
    try {
      r = await runItemLocked(user, scope, h, n, { by: systemBy("auto_handoff"), auto: true, gov, settle, deadline });
    } catch (e) {
      // Unexpected (a refused or failed batch is an answer, not a throw): the item is marked failed for the owner.
      console.error("auto handoff run failed", e instanceof Error ? e.name : "error");
      return "error";
    }
    if (r.ok) {
      await tell(user, scope, h, n, r.tasks.length);
      return `ok:${r.tasks.length}`;
    }
    // "not_found": the proposal was pushed off the index since it was read; nothing was charged.
    return r.error === "paused" ? "retry:paused" : r.error === "not_found" ? "skip:not_found" : r.error;
  } finally {
    // The hold goes only after the batch is saved: until then the brand's routines count it, and after it the items.
    await db.del(hold).catch((e) => console.error("auto handoff hold release failed", e instanceof Error ? e.name : "error"));
  }
}

/** The owner's notice of one auto-run, once per item. Never throws: the batch is saved and paid for by now. */
async function tell(user: User, scope: string, h: Handoff, n: number, count: number) {
  const it = h.items[n];
  // An unexpected language on an old record must not throw here.
  const ul = user.lang === "en" ? "en" : "ar";
  const ar = ul === "ar";
  const name = agentById(it.agent).name[ul];
  const lead = agentById("majed").name[ul];
  const label = appDict[ul].generate.types[it.type].t;
  try {
    await notifyItem(user.email, ul, {
      kind: "pending",
      agent: it.agent,
      title: ar ? `${label} من ${name} في صندوق الموافقة` : `${label} from ${name} is in your inbox`,
      body: ar
        ? `بدأه ${lead} بنفسه من تسليمه، لأنك فعّلت تشغيله التلقائي في الحوكمة. ${count} عنصر ينتظر موافقتك.`
        : `${lead} started it himself from his handoff, because you turned on his auto-run in Governance. ${count} item(s) wait for your approval.`,
      href: "",
    }, handoffFingerprint(scope, h.id, n), AUTO_KEYS_DAYS);
  } catch (e) {
    console.error("auto handoff notification failed", e instanceof Error ? e.name : "error");
  }
}
