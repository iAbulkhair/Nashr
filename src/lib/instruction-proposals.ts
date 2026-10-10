import { randomBytes } from "crypto";
import { db } from "./db";
import { isAgentId, type AgentId } from "./agents";
import type { By } from "./actor";
import { allow, INSTRUCTION_PROPOSALS_PER_DAY, WINDOW } from "./rate";
import { INSTRUCTION_CHARS, normalizeInstruction, screenInstruction, type InstructionLimits, type ScreenCode } from "./instructions-safety";
import { appendActive, type Layer, type StoreError } from "./instructions-store";

/**
 * Standing rules the owner states in chat ("we never say cheap"), which an agent may propose and never apply (agent
 * skills portal, spec 7, rules 953-954). The model that calls `propose_instruction` reads crawled pages, imported
 * catalogs, uploads and MCP clients' text, and what it proposes ends up in every agent's prompt, so the tool only stores
 * a proposal (the `brand-proposals.ts` pattern): the card under the reply is the owner's to apply or dismiss, through
 * `POST /api/instructions/proposals/[id]` under `instructions.write`. Applying runs `appendActive`, so the text, the
 * count and the plan are checked again with today's rules, and the live set and the draft in progress both get the item.
 *
 * Keys, all under the caller's own scope (`sc(u)`, never an id from a request): the proposal (`skillprop:`, 7 days), the
 * claim that orders two answers arriving together (`skillprop-claim:`, 60 s), the outcome (`skillprop-done:`, 7 days)
 * and the index of ids (`skillprops:`), which lets `wipeAccount` find every proposal of the scope.
 */
export type InstructionProposal = { id: string; text: string; agents: "all" | AgentId[]; at: string; by: By };
export type InstructionProposalState = "open" | "applied" | "dismissed" | "expired";
/**
 * What the reply's card carries and the browser reads: the proposal without `by` (the login behind a chat turn, which
 * may hold who impersonated), and where it stands now (filled in when a thread is read, never stored).
 */
export type InstructionProposalCard = Omit<InstructionProposal, "by"> & { state?: InstructionProposalState };
export const proposalCard = (p: InstructionProposal): InstructionProposalCard => ({ id: p.id, text: p.text, agents: p.agents, at: p.at });

const TTL_S = 7 * 86400;
const key = (scope: string, id: string) => `skillprop:${scope}:${id}`;
const doneKey = (scope: string, id: string) => `skillprop-done:${scope}:${id}`;
const claimKey = (scope: string, id: string) => `skillprop-claim:${scope}:${id}`;
const indexKey = (scope: string) => `skillprops:${scope}`;
const dayKey = (scope: string) => `rate:instr:p:${scope}`;
const ID = /^[a-f0-9]{16}$/;

export type ProposeError = ScreenCode | "empty" | "too_long" | "bad_target" | "daily_limit";

/**
 * Store one proposal. The text is normalized and screened exactly as a saved instruction is, before anything is stored; a
 * refused text makes no card and costs none of the day's allowance. `agents` is `"all"` or a list of the eight agents
 * (`reviewer`, `judge` and `media` are not the chat's to name); below a plan that allows per-agent targets it is stored as
 * `"all"` and `widened` says so, for the tool's answer. The day's allowance (20 per workspace) counts stored proposals.
 */
export async function proposeInstruction(
  scope: string,
  input: { text: string; agents?: unknown },
  by: By,
  limits: InstructionLimits,
): Promise<{ ok: true; p: InstructionProposal; widened: boolean } | { ok: false; error: ProposeError }> {
  const text = normalizeInstruction(typeof input.text === "string" ? input.text : "");
  if (!text) return { ok: false, error: "empty" };
  if (text.length > INSTRUCTION_CHARS) return { ok: false, error: "too_long" };
  const screen = screenInstruction(text);
  if (screen) return { ok: false, error: screen };
  let agents: "all" | AgentId[] = "all";
  if (input.agents !== undefined && input.agents !== null && input.agents !== "all") {
    if (!Array.isArray(input.agents) || !input.agents.every(isAgentId)) return { ok: false, error: "bad_target" };
    // An empty list names no one: it reads as "every agent", like leaving the field out.
    if (input.agents.length) agents = [...new Set(input.agents)];
  }
  const widened = agents !== "all" && !limits.perAgent;
  if (widened) agents = "all";
  if (!(await allow(`instr:p:${scope}`, INSTRUCTION_PROPOSALS_PER_DAY, WINDOW.day))) return { ok: false, error: "daily_limit" };
  const p: InstructionProposal = { id: randomBytes(8).toString("hex"), text, agents, at: new Date().toISOString(), by };
  // The id first: a proposal saved is always one `wipeAccount` can find.
  await db.sadd(indexKey(scope), p.id);
  await db.set(key(scope, p.id), p, TTL_S);
  return { ok: true, p, widened };
}

/** Every key the proposals of one scope can leave behind, for `wipeAccount`: each proposal, its outcome and claim, the index and the day's counter. */
export async function instructionProposalKeys(scope: string): Promise<string[]> {
  const ids = await db.smembers(indexKey(scope));
  return [...ids.flatMap((id) => [key(scope, id), doneKey(scope, id), claimKey(scope, id)]), indexKey(scope), dayKey(scope)];
}

/** Where each proposal stands, read in one round trip, so a reloaded chat shows a decided card as decided. */
export async function instructionProposalStates(scope: string, ids: string[]): Promise<Record<string, InstructionProposalState>> {
  const ok = ids.filter((id) => ID.test(id));
  if (!ok.length) return {};
  const rows = await db.mget<unknown>([...ok.map((id) => key(scope, id)), ...ok.map((id) => doneKey(scope, id))]);
  return Object.fromEntries(ok.map((id, i): [string, InstructionProposalState] => {
    const done = rows[ok.length + i];
    if (done === "applied" || done === "dismissed") return [id, done];
    return [id, rows[i] ? "open" : "expired"];
  }));
}

export type Decided = { ok: true; layer?: Layer } | { ok: false; error: StoreError | "gone" };

/**
 * Apply or dismiss one proposal, once.
 * - `not_found`: no such proposal in this scope (another workspace's id lands here too: only this scope's keys are read).
 * - `gone`: it was decided already (this scope's outcome record is there), so a second click or a second tab applies nothing.
 * - `busy`: another answer for the same proposal is running; it may be retried at once.
 * - Apply adds the text to the live set as a new version (`src: "chat"`) and to the draft in progress, through
 *   `appendActive`, under the store's lock and with today's checks. A refusal (a full set, a plan that no longer allows
 *   the targets, a text today's screen refuses) leaves the proposal open: the owner frees a slot and presses Apply again,
 *   or dismisses it.
 */
export async function decideInstructionProposal(scope: string, id: string, decision: "apply" | "dismiss", by: By, limits: InstructionLimits): Promise<Decided> {
  if (!ID.test(id)) return { ok: false, error: "not_found" };
  const claim = claimKey(scope, id);
  if (!(await db.setNx(claim, 1, 60))) return { ok: false, error: "busy" };
  const close = async (state: "applied" | "dismissed") => {
    await Promise.all([db.del(key(scope, id)), db.set(doneKey(scope, id), state, TTL_S)]);
  };
  try {
    const p = await db.get<InstructionProposal>(key(scope, id));
    if (!p) return { ok: false, error: (await db.get(doneKey(scope, id))) ? "gone" : "not_found" };
    if (decision === "dismiss") {
      await close("dismissed");
      return { ok: true };
    }
    const r = await appendActive(scope, { text: p.text, agents: p.agents, on: true }, by, { limits, src: "chat" });
    if (!r.ok) return { ok: false, error: r.error };
    await close("applied");
    return { ok: true, layer: r.layer };
  } finally {
    // The claim only orders answers that arrive together. A decided proposal answers `gone` afterwards, and one that was
    // not decided may be answered again at once.
    await db.del(claim).catch(() => {});
  }
}

/** The tool's answer for a refused proposal: the reason in plain words, for the model to relay. Nothing was stored. */
export const PROPOSE_REFUSAL: Readonly<Record<ProposeError, string>> = {
  empty: "Not proposed: the rule has no text. Nothing was stored.",
  too_long: `Not proposed: a rule is at most ${INSTRUCTION_CHARS} characters. Shorten it to one clear sentence. Nothing was stored.`,
  injection: "Not proposed: this text reads like an attempt to change how the assistant treats its own instructions, which an instruction may not do. Nothing was stored. Tell the owner plainly, and offer to word the rule as a plain working rule.",
  authority: "Not proposed: an instruction cannot give an agent the right to approve, publish, spend credits or skip the owner's approval. Those stay with the owner. Nothing was stored. Tell the owner plainly.",
  secret: "Not proposed: an instruction cannot ask an agent to reveal secrets, keys, its own prompts or another account's data. Nothing was stored. Tell the owner plainly.",
  bad_target: "Not proposed: agents must be a list of the eight agent ids (noor, sami, razan, faris, dana, layan, reem, majed), or left out for every agent. Nothing was stored.",
  daily_limit: `Not proposed: this workspace already has ${INSTRUCTION_PROPOSALS_PER_DAY} proposals today, the most a day carries. Nothing was stored. Tell the owner they can add the rule on the Agent instructions page.`,
};
