import { randomBytes } from "crypto";
import { db } from "./db";
import { sc, type User } from "./auth";
import type { By } from "./actor";
import { isAgentId, type AgentId } from "./agents";
import { getGov } from "./governance";
import { authorityOf } from "./tool-authority";
import { getBrand, getTask, type Task } from "./brand";
import { isDraftType, isTaskType, type TaskType } from "./tasks";
import { BATCH_RUN_MIN_MS, generateBatch, type BatchRefusal } from "./generate-batch";
import { renderImage, type ImageOutcome } from "./media/start";

/**
 * Paid chat work the owner did not explicitly ask for (rule 1511): when `generate_content`, `draft_items` or
 * `generate_image` is called in a turn whose owner message shows no request (`spendIntent`, src/lib/spend-intent.ts), the
 * tool spends nothing and stores this proposal instead. The card under the reply shows what would run and its price, and
 * the owner's Run (`POST /api/chat/spend/[id]`, rule 1512) is the approval: the batch or the render then runs exactly as
 * the tool would have, with the stored type, brief and count, never anything from the request body.
 *
 * Keys, all under the caller's own scope (`sc(u)`, never an id from a request): the proposal (`spendprop:`, 24 hours),
 * the claim that orders two clicks arriving together and covers the run (`spendprop-claim:`, 330 s), the outcome
 * (`spendprop-done:`, 24 hours) and the index of ids (`spendprops:`), which lets `wipeAccount` find every proposal.
 */
export type SpendKind = "batch" | "draft" | "image";
/**
 * `reason` (rule 2333): "ask" when the owner set this capability to ask first for the talking agent, so the card says
 * that rather than "your message did not ask for this". Absent on every card saved before it existed, which reads as the
 * spend gate's own reason. A new optional field: code without it ignores it.
 */
export type SpendProposal = { id: string; kind: SpendKind; type: TaskType; count?: number; brief: string; taskId?: string; title?: string; credits: number; agent?: AgentId; reason?: "ask"; at: string; by: By };
export type SpendProposalState = "open" | "ran" | "dismissed" | "expired";
/** What the reply's card carries and the browser reads: the proposal without `by`, and where it stands now (filled in when a thread is read, never stored). */
export type SpendProposalCard = Omit<SpendProposal, "by"> & { state?: SpendProposalState };
export const spendCard = (p: SpendProposal): SpendProposalCard => {
  const { by: _by, ...card } = p; // eslint-disable-line @typescript-eslint/no-unused-vars
  return card;
};

/** Cards one reply carries at most; a further unrequested spend in the same turn is refused in its answer, with no card. */
export const SPEND_CARDS_PER_REPLY = 2;
export const SPEND_BRIEF_MAX = 2000;
const TTL_S = 86400;
const CLAIM_S = 330;
const key = (scope: string, id: string) => `spendprop:${scope}:${id}`;
const doneKey = (scope: string, id: string) => `spendprop-done:${scope}:${id}`;
const claimKey = (scope: string, id: string) => `spendprop-claim:${scope}:${id}`;
const indexKey = (scope: string) => `spendprops:${scope}`;
const ID = /^[a-f0-9]{16}$/;
export const isSpendProposalId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

/** Store one proposal under the scope. The caller has already checked the type (and, for a draft, the count and the draft type). */
export async function proposeSpend(scope: string, input: Omit<SpendProposal, "id" | "at">): Promise<SpendProposal> {
  const p: SpendProposal = { ...input, brief: input.brief.slice(0, SPEND_BRIEF_MAX), id: randomBytes(8).toString("hex"), at: new Date().toISOString() };
  // The id first: a proposal saved is always one `wipeAccount` can find. The index lives as long as its newest proposal.
  await db.sadd(indexKey(scope), p.id);
  await Promise.all([db.expire(indexKey(scope), TTL_S), db.set(key(scope, p.id), p, TTL_S)]);
  return p;
}

/** One proposal of the caller's own scope, or null (an id from another workspace is simply not there). */
export async function getSpendProposal(scope: string, id: string): Promise<SpendProposal | null> {
  return ID.test(id) ? db.get<SpendProposal>(key(scope, id)) : null;
}

/** Every key the proposals of one scope can leave behind, for `wipeAccount`. */
export async function spendProposalKeys(scope: string): Promise<string[]> {
  const ids = await db.smembers(indexKey(scope));
  return [...ids.flatMap((id) => [key(scope, id), doneKey(scope, id), claimKey(scope, id)]), indexKey(scope)];
}

/** Where each proposal stands, read in one round trip, so a reloaded chat never offers Run on a card that already ran. */
export async function spendProposalStates(scope: string, ids: string[]): Promise<Record<string, SpendProposalState>> {
  const ok = ids.filter((id) => ID.test(id));
  if (!ok.length) return {};
  const rows = await db.mget<unknown>([...ok.map((id) => key(scope, id)), ...ok.map((id) => doneKey(scope, id))]);
  return Object.fromEntries(ok.map((id, i): [string, SpendProposalState] => {
    const done = rows[ok.length + i];
    if (done === "ran" || done === "dismissed") return [id, done];
    return [id, rows[i] ? "open" : "expired"];
  }));
}

export type SpendRun =
  | { ok: true; kind: "batch" | "draft"; tasks: Task[]; credits: number }
  | { ok: true; kind: "image"; outcome: ImageOutcome }
  | { ok: true; kind: "dismissed" }
  | { ok: false; error: "not_found" | "gone" | "claim_busy" | "too_late" | "item_gone" | "bad_proposal" | "revoked" }
  | { ok: false; error: "refused"; refusal: BatchRefusal }
  | { ok: false; error: "image"; outcome: ImageOutcome };

/**
 * Run or dismiss one proposal, once, as the login that pressed the button.
 * - `not_found`: no such proposal in this scope (another workspace's id lands here too: only this scope's keys are read).
 * - `gone`: decided already, so a second click or a second tab runs nothing.
 * - `claim_busy`: another click for it is running.
 * - `revoked` (rule 2334): the owner has since switched this capability off for the agent the card came from
 *   (src/lib/tool-authority.ts). Checked at Run, from the setting read now, so a card made before the change never
 *   runs past it. Nothing is charged and the card stays open, so switching it back on lets the owner run it.
 * - Run: the batch through `generateBatch` (its credit, cap, trial and brand checks, the refund on failure), or the render
 *   through `renderImage` (the default model, the charge and refund in the media engine). A refusal or a failure leaves the
 *   proposal open, so the owner can top up and press Run again, or dismiss it. Only a batch that saved its items, or a
 *   render that started, closes it as `ran`.
 */
export async function decideSpend(u: User, id: string, decision: "run" | "dismiss", o: { by: By; deadline: number }): Promise<SpendRun> {
  if (!ID.test(id)) return { ok: false, error: "not_found" };
  const scope = sc(u);
  const claim = claimKey(scope, id);
  if (!(await db.setNx(claim, 1, CLAIM_S))) return { ok: false, error: "claim_busy" };
  const close = async (state: "ran" | "dismissed") => {
    await db.set(doneKey(scope, id), state, TTL_S);
    await db.del(key(scope, id));
  };
  try {
    const [p, done] = await Promise.all([db.get<SpendProposal>(key(scope, id)), db.get(doneKey(scope, id))]);
    if (done) return { ok: false, error: "gone" };
    if (!p) return { ok: false, error: "not_found" };
    if (decision === "dismiss") {
      await close("dismissed");
      return { ok: true, kind: "dismissed" };
    }
    // The stored record is checked again, never trusted: a type that is no longer a task type is refused before any charge.
    if (!isTaskType(p.type) || (p.kind === "draft" && !isDraftType(p.type))) return { ok: false, error: "bad_proposal" };
    // The approval is checked against today's settings, not the ones it was made under (rule 2334).
    if (p.agent && isAgentId(p.agent) && authorityOf((await getGov(scope)).toolPolicy, p.agent, p.kind === "image" ? "images" : "produce") === "off") return { ok: false, error: "revoked" };
    if (p.kind === "image") {
      const [brand, t] = await Promise.all([getBrand(scope), p.taskId ? getTask(scope, p.taskId) : null]);
      if (!brand || !t) return { ok: false, error: "item_gone" };
      const outcome = await renderImage(u, t, brand, undefined, { deadline: o.deadline, by: o.by, from: "chat" });
      if (!("placeholder" in outcome) && !outcome.ok) return { ok: false, error: "image", outcome };
      await close("ran");
      return { ok: true, kind: "image", outcome };
    }
    if (o.deadline - Date.now() < BATCH_RUN_MIN_MS) return { ok: false, error: "too_late" };
    const count = p.kind === "draft" ? Math.max(1, Math.min(3, Number(p.count) || 1)) : undefined;
    const r = await generateBatch(u, scope, { type: p.type, notes: p.brief, ...(count ? { count } : {}), source: "chat", via: "chat", by: o.by, deadline: o.deadline });
    if (!r.ok) return { ok: false, error: "refused", refusal: r };
    await close("ran");
    return { ok: true, kind: p.kind, tasks: r.tasks, credits: r.credits };
  } finally {
    await db.del(claim).catch(() => {});
  }
}
