import { randomBytes } from "crypto";
import { db } from "./db";
import { getBrand, saveBrand, type Brand } from "./brand";
import { bannedTerms, normalize } from "./brand-rules";
import type { AgentId } from "./agents";

/**
 * Brand changes an agent may propose but never apply: the inputs of the code gates.
 *
 * `banned` is the list the approve and publish gates enforce, and `offers` decides which discounts and deadlines the
 * agents may promise (cart recovery's capDiscounts lets through only the percentages the offers name). A model call wrote
 * both directly (update_brand), and the model reads crawled sites, imported catalogs, uploads and MCP clients' text, so
 * one planted sentence could remove the rule that holds an item, or open a 50% discount. An agent may still ADD a banned
 * word at once (that only holds more). Taking words out, and any change to the offers, is saved here as a proposal and
 * shown to the owner as a card with the old and the new value; only the owner's click applies it, through the route
 * /api/brand/proposals/[id], under the same role as the Brand page ("brand.write").
 */
export type ProposalField = "offers" | "banned";
export type ProposalState = "open" | "applied" | "dismissed" | "stale" | "expired";
export type BrandProposal = { id: string; field: ProposalField; from: string; to: string; at: string; agent: AgentId; via: "chat" | "mcp"; dropped?: string[]; /** filled in when a chat thread is read, never stored */ state?: ProposalState };

const TTL_S = 7 * 86400;
const key = (scope: string, id: string) => `brandprop:${scope}:${id}`;
const doneKey = (scope: string, id: string) => `brandprop-done:${scope}:${id}`;
const claimKey = (scope: string, id: string) => `brandprop-claim:${scope}:${id}`;
const lockKey = (scope: string) => `brandlock:${scope}`;
/**
 * Every proposal id of a scope. An id is random and a proposal holds the brand's old and new offers or banned words, so
 * without this set `wipeAccount` could not find one, and it would outlive the account by up to 7 days. One 16-character
 * id per proposal an agent ever made in the brand; it goes with the account.
 */
const indexKey = (scope: string) => `brandprops:${scope}`;
const ID = /^[a-f0-9]{16}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every read-change-write of the brand file by an agent or a proposal runs under this lock, so a word an agent adds and a
 * proposal the owner applies cannot overwrite each other. (The Brand page saves the whole form, as before.)
 */
export async function withBrandLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const k = lockKey(scope);
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = await db.lock(k, 10);
    if (!got) await sleep(50);
  }
  if (!got) throw new Error("brand_lock_timeout");
  try {
    return await fn();
  } finally {
    await db.unlock(k).catch((e) => console.error("brand lock release failed", e instanceof Error ? e.name : "error"));
  }
}

export async function proposeBrandChange(scope: string, p: Omit<BrandProposal, "id" | "at" | "state">): Promise<BrandProposal> {
  const out: BrandProposal = { ...p, id: randomBytes(8).toString("hex"), at: new Date().toISOString() };
  // The id first: a proposal saved is always one `wipeAccount` can find.
  await db.sadd(indexKey(scope), out.id);
  await db.set(key(scope, out.id), out, TTL_S);
  return out;
}

/** Every key the proposals of one scope can leave behind, for `wipeAccount`: each proposal, its outcome and claim, the index and the brand lock. */
export async function proposalKeys(scope: string): Promise<string[]> {
  const ids = await db.smembers(indexKey(scope));
  return [...ids.flatMap((id) => [key(scope, id), doneKey(scope, id), claimKey(scope, id)]), indexKey(scope), lockKey(scope)];
}

export async function getProposal(scope: string, id: string): Promise<BrandProposal | null> {
  return ID.test(id) ? db.get<BrandProposal>(key(scope, id)) : null;
}

/** Where each proposal stands, read in one round trip, so a reloaded chat shows a decided card as decided. */
export async function proposalStates(scope: string, ids: string[]): Promise<Record<string, ProposalState>> {
  const ok = ids.filter((id) => ID.test(id));
  if (!ok.length) return {};
  const rows = await db.mget<unknown>([...ok.map((id) => key(scope, id)), ...ok.map((id) => doneKey(scope, id))]);
  return Object.fromEntries(ok.map((id, i): [string, ProposalState] => {
    const done = rows[ok.length + i];
    if (done === "applied" || done === "dismissed" || done === "stale") return [id, done];
    return [id, rows[i] ? "open" : "expired"];
  }));
}

/** An applied proposal names its field and the agent that proposed it, for the activity row the route writes. */
export type Decided = { ok: true; applied: boolean; brand?: Brand; field?: ProposalField; agent?: AgentId } | { ok: false; error: "not_found" | "stale" | "no_brand" | "busy" };

/**
 * Apply or dismiss one proposal, once.
 * - An offers change applies only while the offers still say what they said when it was proposed: otherwise it would
 *   overwrite a newer value (`stale`, dropped; the owner decides on the Brand page).
 * - A removal takes its words out of the list as it is now, so words added since (by the owner or an agent) stay; it is
 *   stale only when none of its words is on the list any more.
 * A failure that is not a decision (no brand file yet, another tab deciding) leaves the proposal open for a retry.
 */
export async function decideProposal(scope: string, id: string, action: "apply" | "dismiss"): Promise<Decided> {
  if (!ID.test(id)) return { ok: false, error: "not_found" };
  const claim = claimKey(scope, id);
  if (!(await db.setNx(claim, 1, 60))) return { ok: false, error: "busy" };
  const close = async (state: "applied" | "dismissed" | "stale") => {
    await Promise.all([db.del(key(scope, id)), db.set(doneKey(scope, id), state, TTL_S)]);
  };
  try {
    const p = await db.get<BrandProposal>(key(scope, id));
    if (!p) return { ok: false, error: "not_found" };
    if (action === "dismiss") { await close("dismissed"); return { ok: true, applied: false }; }
    return await withBrandLock(scope, async (): Promise<Decided> => {
      const brand = await getBrand(scope);
      if (!brand) return { ok: false, error: "no_brand" };
      if (p.field === "banned" && p.dropped?.length) {
        const out = new Set(p.dropped.map(normalize));
        const cur = bannedTerms(brand.banned);
        const kept = cur.filter((t) => !out.has(normalize(t)));
        if (kept.length === cur.length) { await close("stale"); return { ok: false, error: "stale" }; }
        brand.banned = kept.join(", ");
      } else {
        if ((brand[p.field] ?? "") !== p.from) { await close("stale"); return { ok: false, error: "stale" }; }
        brand[p.field] = p.to;
      }
      brand.updatedAt = new Date().toISOString();
      await saveBrand(scope, brand);
      await close("applied");
      return { ok: true, applied: true, brand, field: p.field, agent: p.agent };
    });
  } finally {
    // The claim only orders answers that arrive together. A decided proposal is gone (the next answer is not_found), and
    // one that was not decided (no brand file, a failed write) may be answered again at once.
    await db.del(claim).catch(() => {});
  }
}
