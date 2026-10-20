import { randomBytes } from "crypto";
import { db } from "./db";
import type { AgentId } from "./agents";
import type { By } from "./actor";
import { readFile, safeName, writeFile, type WFile } from "./files";
import { fileSrc } from "./ref-provenance";
import { wsKey, type Scope } from "./keys";

/**
 * Rewrites of core memory an agent may propose in chat but never apply (rule 2306, security scan 2026-10-19).
 *
 * The core files (brand.md, products.md, strategy.md, … `CORE_FILES` in src/lib/files.ts) are what every agent reads on
 * every turn. `writeFile` already keeps an owner-written file safe (an agent write goes to a sibling name), but a core
 * file an agent wrote (onboarding, an import, an earlier chat) was replaced in place by the next `write_file`, and the
 * model that calls `write_file` reads crawled pages, catalogs, uploads and teammates' notes. So a chat `write_file` that
 * would replace the non-empty text of an existing core file is stored here as a proposal and shown under the reply as a
 * card; only the click of the owner or an admin writes it, through `POST /api/files/proposals/[id]` under
 * `files.core.write`, the same role as the Files page. A new core file, or an empty one, is still written at once.
 *
 * Keys (`wsKey.fileProposal*`, src/lib/keys.ts), all under the caller's own scope (`sc(u)`, never an id from a request): the proposal (`fileprop:`, 7 days), the
 * claim that orders two answers arriving together (`fileprop-claim:`, 60 s), the outcome (`fileprop-done:`, 7 days) and
 * the index of ids (`fileprops:`), which lets `wipeAccount` find every proposal of the scope.
 */
export type FileProposal = { id: string; name: string; content: string; /** the file's `updatedAt` when proposed: applying over a newer save is refused */ prevAt: string; at: string; agent?: AgentId; by: By };
export type FileProposalState = "open" | "applied" | "dismissed" | "stale" | "expired";
/** What the reply's card carries: the file name, its length and the opening of the new text, never `by` or the whole body. */
export type FileProposalCard = { id: string; name: string; chars: number; preview: string; at: string; agent?: AgentId; state?: FileProposalState };
export const PREVIEW_CHARS = 600;
export const fileProposalCard = (p: FileProposal): FileProposalCard => ({ id: p.id, name: p.name, chars: p.content.length, preview: p.content.slice(0, PREVIEW_CHARS), at: p.at, ...(p.agent ? { agent: p.agent } : {}) });

const TTL_S = 7 * 86400;
const MAX_CHARS = 40000; // the cap writeFile keeps
const key = wsKey.fileProposal;
const doneKey = wsKey.fileProposalDone;
const claimKey = wsKey.fileProposalClaim;
const indexKey = wsKey.fileProposals;
const ID = /^[a-f0-9]{16}$/;

/**
 * Whether a chat write of `content` to an existing file needs the owner's card: an agent wrote it (an owner-written file
 * is never replaced: `writeFile` saves beside it), it holds text, and the new text differs.
 */
export const needsFileCard = (existing: WFile | null, content: string): existing is WFile =>
  !!existing && existing.by === "noor" && existing.content.trim() !== "" && existing.content !== content.slice(0, MAX_CHARS);

/** Store one proposal; the id goes in the index first, so a saved proposal is always one `wipeAccount` can find. */
export async function proposeFile(scope: Scope, existing: WFile, content: string, agent: AgentId | undefined, by: By): Promise<FileProposal> {
  const p: FileProposal = { id: randomBytes(8).toString("hex"), name: existing.name, content: content.slice(0, MAX_CHARS), prevAt: existing.updatedAt, at: new Date().toISOString(), ...(agent ? { agent } : {}), by };
  await liveIds(scope);
  await db.sadd(indexKey(scope), p.id);
  await db.expire(indexKey(scope), TTL_S);
  await db.set(key(scope, p.id), p, TTL_S);
  return p;
}

/** The index's ids whose proposal or outcome still exists, in one read; dead ids are dropped off the caller's path. */
async function liveIds(scope: Scope): Promise<string[]> {
  const ids = await db.smembers(indexKey(scope));
  if (!ids.length) return ids;
  const rows = await db.mget<unknown>([...ids.map((id) => key(scope, id)), ...ids.map((id) => doneKey(scope, id))]);
  const dead = ids.filter((_, i) => !rows[i] && !rows[ids.length + i]);
  if (dead.length) await Promise.all(dead.map((id) => db.srem(indexKey(scope), id))).catch(() => {});
  return ids.filter((id) => !dead.includes(id));
}

/** Every key the proposals of one scope can leave behind, for `wipeAccount`. */
export async function fileProposalKeys(scope: Scope): Promise<string[]> {
  const ids = await liveIds(scope);
  return [...ids.flatMap((id) => [key(scope, id), doneKey(scope, id), claimKey(scope, id)]), indexKey(scope)];
}

/** Where each proposal stands, read in one round trip, so a reloaded chat shows a decided card as decided. */
export async function fileProposalStates(scope: Scope, ids: string[]): Promise<Record<string, FileProposalState>> {
  const ok = ids.filter((id) => ID.test(id));
  if (!ok.length) return {};
  const rows = await db.mget<unknown>([...ok.map((id) => key(scope, id)), ...ok.map((id) => doneKey(scope, id))]);
  return Object.fromEntries(ok.map((id, i): [string, FileProposalState] => {
    const done = rows[ok.length + i];
    if (done === "applied" || done === "dismissed" || done === "stale") return [id, done];
    return [id, rows[i] ? "open" : "expired"];
  }));
}

export type FileDecided = { ok: true; file?: WFile; agent?: AgentId } | { ok: false; error: "not_found" | "gone" | "claim_busy" | "stale" };

/**
 * Apply or dismiss one proposal, once.
 * - `not_found`: no such proposal in this scope (another workspace's id lands here too: only this scope's keys are read).
 * - `gone`: decided already, so a second click or a second tab writes nothing.
 * - `claim_busy`: another answer for the same proposal is running.
 * - `stale`: the file was saved again since the proposal (by the owner on the Files page, or another write), so applying
 *   would throw that newer text away; the proposal is closed as stale and nothing is written.
 * Apply writes with the file's own author label, so an agent-written file stays agent-written and the owner-written guard
 * in `writeFile` keeps working.
 */
export async function decideFileProposal(scope: Scope, id: string, decision: "apply" | "dismiss"): Promise<FileDecided> {
  if (!ID.test(id)) return { ok: false, error: "not_found" };
  const claim = claimKey(scope, id);
  if (!(await db.setNx(claim, 1, 60))) return { ok: false, error: "claim_busy" };
  const close = async (state: "applied" | "dismissed" | "stale") => {
    await db.set(doneKey(scope, id), state, TTL_S);
    await db.del(key(scope, id));
  };
  try {
    const [p, done] = await Promise.all([db.get<FileProposal>(key(scope, id)), db.get(doneKey(scope, id))]);
    if (done) return { ok: false, error: "gone" };
    if (!p) return { ok: false, error: "not_found" };
    if (decision === "dismiss") {
      await close("dismissed");
      return { ok: true };
    }
    const cur = await readFile(scope, safeName(p.name));
    if (cur && cur.updatedAt !== p.prevAt) {
      await close("stale");
      return { ok: false, error: "stale" };
    }
    const file = await writeFile(scope, p.name, p.content, cur?.by ?? "noor", { src: fileSrc("agent") });
    await close("applied");
    return { ok: true, file, ...(p.agent ? { agent: p.agent } : {}) };
  } finally {
    await db.del(claim).catch(() => {});
  }
}
