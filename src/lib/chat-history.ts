/**
 * The chat: message and item types and the stored conversation (`history`, `push`).
 */
import type { AgentId } from "./agents";
import { CAPS, db, pushCapped } from "./db";
import type { TaskType } from "./tasks";
import { proposalStates, type BrandProposal } from "./brand-proposals";
import { awayProposalStates, type AwayProposal } from "./secretary-away";
import { instructionProposalStates, type InstructionProposalCard } from "./instruction-proposals";
import { memoryProposalStates, type MemoryCard } from "./memory";
import { markShown } from "./handoffs";
import { spendProposalStates, type SpendProposalCard } from "./spend-proposals";
import { fileProposalStates, type FileProposalCard } from "./file-proposals";
import type { Scope } from "./keys";

/**
 * An inbox item as a chat card shows it. `xflag`: the other agents that flagged it in the cross-agent review, each with
 * how many notes (`chatItemOf`, src/lib/handoffs.ts): the card then shows their pills and sends the owner to the inbox to
 * read the notes instead of offering Approve.
 */
export type ChatItem = { id: string; type: TaskType; channel: string; title: string; body: string; status: string; xflag?: { by: AgentId; n: number }[] };
export type ChatMsg = { role: "user" | "assistant"; content: string; at: string; actions?: string[]; agent?: AgentId; /** items created by tools during this turn, rendered as cards */ items?: ChatItem[]; /** workspace files written during this turn, rendered as collapsible cards (first-run onboarding) */ files?: { name: string; content: string }[]; /** starter plan proposed at the end of onboarding */ plan?: PlanItem[]; /** a handoff Majed proposed during this turn (src/lib/handoffs.ts), rendered as a card with Run buttons */ handoff?: { id: string }; /** brand changes proposed during this turn, waiting for the owner's Save (src/lib/brand-proposals.ts) */ proposals?: BrandProposal[]; /** absences Reem proposed during this turn (contact_away), waiting for a person's Save (src/lib/secretary-away.ts) */ awayProposals?: AwayProposal[]; /** instructions an agent proposed during this turn (propose_instruction), waiting for the owner's Apply (src/lib/instruction-proposals.ts); absent on older messages */ instructionProposals?: InstructionProposalCard[]; /** the agent whose work the owner asked for, when this agent's role refusal sent it elsewhere (rule 798): the reply shows a button that switches to them. Expand-only (rule 679): old messages have none. */ switchTo?: AgentId; /** the workspace was large for this turn (`workspaceLarge`, rule 1484): the app shows a quiet hint under the reply; absent before 2026-10-12 */ large?: true; /** paid work the owner's message did not ask for in words, waiting for the owner's Run (src/lib/spend-proposals.ts, rule 1511). Expand-only (rule 679): absent on older messages. */ spendProposals?: SpendProposalCard[]; /** core-file rewrites an agent asked for in write_file, waiting for the owner's Apply (src/lib/file-proposals.ts, rule 2306). Expand-only (rule 679): absent on older messages. */ fileProposals?: FileProposalCard[]; /** facts the `remember` tool proposed during this turn, waiting for the owner's Save (src/lib/memory.ts, rule 4556). Expand-only (rule 679): absent on older messages. */ memoryProposals?: MemoryCard[] };
export type PlanItem = { title: string; type: TaskType; brief: string; added?: boolean };

const key = (email: string, conv?: string) => (conv && conv !== "default" ? `chat:${email}:${conv}` : `chat:${email}`);
export async function history(email: string, conv?: string): Promise<ChatMsg[]> {
  const rows = await db.lrange(key(email, conv), 0, 39);
  const msgs = rows.map((r) => JSON.parse(r) as ChatMsg).reverse();
  // A brand-change, away or instruction card shows where it stands now (applied or saved, dismissed, expired), both read in one round
  // trip, so a reload never offers Save on a change that was already decided.
  const ids = msgs.flatMap((m) => m.proposals?.map((p) => p.id) ?? []);
  const awayIds = msgs.flatMap((m) => m.awayProposals?.map((p) => p.id) ?? []);
  const instrIds = msgs.flatMap((m) => m.instructionProposals?.map((p) => p.id) ?? []);
  const spendIds = msgs.flatMap((m) => m.spendProposals?.map((p) => p.id) ?? []);
  if (ids.length || awayIds.length || instrIds.length || spendIds.length) {
    const [states, away, instr, spend]: [Record<string, BrandProposal["state"]>, Record<string, AwayProposal["state"]>, Record<string, InstructionProposalCard["state"]>, Record<string, SpendProposalCard["state"]>] = await Promise.all([ids.length ? proposalStates(email, ids) : {}, awayIds.length ? awayProposalStates(email, awayIds) : {}, instrIds.length ? instructionProposalStates(email, instrIds) : {}, spendIds.length ? spendProposalStates(email, spendIds) : {}]);
    for (const m of msgs) {
      for (const p of m.proposals ?? []) p.state = states[p.id] ?? "expired";
      for (const p of m.awayProposals ?? []) p.state = away[p.id] ?? "expired";
      for (const p of m.instructionProposals ?? []) p.state = instr[p.id] ?? "expired";
      for (const p of m.spendProposals ?? []) p.state = spend[p.id] ?? "expired";
    }
  }
  return msgs;
}

/**
 * `history` for a screen the owner reads, with each core-file and memory card's state (rules 2306, 4557). The proposal keys live in the key
 * registry and take a `Scope` (`sc(u)`), so the screens that hold one call this; the model's own read of the thread
 * (`history` in src/lib/chat.ts) needs no card state. One more round trip, only when the thread holds a file card.
 */
export async function historyFor(s: Scope, conv?: string): Promise<ChatMsg[]> {
  const msgs = await history(s, conv);
  const fileIds = msgs.flatMap((m) => m.fileProposals?.map((p) => p.id) ?? []);
  const memIds = msgs.flatMap((m) => m.memoryProposals?.map((p) => p.id) ?? []);
  if (!fileIds.length && !memIds.length) return msgs;
  const [files, mem]: [Record<string, FileProposalCard["state"]>, Record<string, MemoryCard["state"]>] = await Promise.all([fileIds.length ? fileProposalStates(s, fileIds) : {}, memIds.length ? memoryProposalStates(s, memIds) : {}]);
  for (const m of msgs) {
    for (const p of m.fileProposals ?? []) p.state = files[p.id] ?? "expired";
    for (const p of m.memoryProposals ?? []) p.state = mem[p.id] ?? "expired";
  }
  return msgs;
}
/** Append a message to a thread (used by chat turns and the onboarding run). */
export async function push(email: string, m: ChatMsg, conv?: string) {
  await pushCapped(key(email, conv), JSON.stringify(m), CAPS.chat);
}

/**
 * Save a turn's reply, and then, when it carries a handoff card, mark that proposal shown (`markShown`): only now does
 * the owner have the card, with Run and Decline, so only now may Majed's auto-run consider it. A turn that fails after
 * the tool saved a proposal never gets here, and that proposal never starts on its own.
 */
export async function deliver(email: string, m: ChatMsg, conv?: string) {
  await push(email, m, conv);
  if (m.handoff) await markShown(email, m.handoff.id);
}
