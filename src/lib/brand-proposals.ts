import { randomBytes } from "crypto";
import { db } from "./db";
import { getBrand, saveBrand, type Brand } from "./brand";
import { bannedTerms, normalize } from "./brand-rules";
import type { AgentId } from "./agents";
import { log } from "./log";

/**
 * Brand changes an agent may propose but never apply.
 *
 * Every field of the brand file a chat tool may change (update_brand in src/lib/chat.ts) is read by every agent, and two
 * of them are the inputs of the code gates: `banned` is the list the approve and publish gates enforce, and `offers`
 * decides which discounts and deadlines the agents may promise (cart recovery's capDiscounts lets through only the
 * percentages the offers name). The model that calls update_brand reads crawled sites, imported catalogs, uploads and
 * MCP clients' text, so one planted sentence could rename the brand, rewrite its tone or products, ban its own name,
 * remove the rule that holds an item, or open a 50% discount. So no tool call writes the brand file: every change is
 * saved here as a proposal and shown to the owner as a card with the old and the new value; only the click of the owner
 * or an admin applies it, through the route /api/brand/proposals/[id], under the same role as the Brand page
 * ("brand.write").
 */
/** Every brand field a proposal may change: plain strings on `Brand` (dialect is one of DIALECTS). */
export const PROPOSAL_FIELDS = ["offers", "banned", "tone", "products", "audience", "competitors", "preferred", "dialect", "city", "name"] as const;
export type ProposalField = (typeof PROPOSAL_FIELDS)[number];
export const DIALECTS = ["msa", "saudi", "emirati", "kuwaiti", "english"] as const;
/** The most each field keeps, the same caps as the Brand page (PUT /api/brand), so a proposal never stores more than a Save would. */
export const FIELD_MAX: Readonly<Record<ProposalField, number>> = { offers: 1000, banned: 400, tone: 300, products: 1000, audience: 1000, competitors: 400, preferred: 400, dialect: 20, city: 60, name: 80 };
export type ProposalState = "open" | "applied" | "dismissed" | "stale" | "expired";
/**
 * `dropped`: banned words a removal takes out; `added`: banned words an addition puts in. Both apply to the list as it is
 * when the owner presses Save, so words changed meanwhile by someone else stay.
 */
export type BrandProposal = { id: string; field: ProposalField; from: string; to: string; at: string; agent: AgentId; via: "chat" | "mcp"; dropped?: string[]; added?: string[]; /** filled in when a chat thread is read, never stored */ state?: ProposalState };

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
 * Every read-change-write of the brand file runs under this lock: a proposal the owner applies, the Profile page's brand
 * fields and the Brand page's Save (PUT /api/brand), so none of them overwrites another with an older copy of the file.
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
    await db.unlock(k).catch((e) => log.error("brand lock release failed", e));
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
export type Decided = { ok: true; applied: boolean; brand?: Brand; field?: ProposalField; agent?: AgentId } | { ok: false; error: "not_found" | "stale" | "no_brand" | "busy" | "too_long" };

/**
 * Apply or dismiss one proposal, once.
 * - An offers change applies only while the offers still say what they said when it was proposed: otherwise it would
 *   overwrite a newer value (`stale`, dropped; the owner decides on the Brand page).
 * - A removal takes its words out of the list as it is now, so words added since (by the owner or an agent) stay; it is
 *   stale only when none of its words is on the list any more.
 * - An addition puts its words on the list as it is now; it is stale when all of them are already there, and refused
 *   (`too_long`, left open) when the list would pass the 400 characters the Brand page keeps.
 * - Any other field applies only while it still says what it said when proposed (`stale` otherwise), capped at FIELD_MAX,
 *   and a dialect only when it is one of DIALECTS.
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
      if (!(PROPOSAL_FIELDS as readonly string[]).includes(p.field)) { await close("stale"); return { ok: false, error: "stale" }; }
      if (p.field === "banned" && p.dropped?.length) {
        const out = new Set(p.dropped.map(normalize));
        const cur = bannedTerms(brand.banned);
        const kept = cur.filter((t) => !out.has(normalize(t)));
        if (kept.length === cur.length) { await close("stale"); return { ok: false, error: "stale" }; }
        brand.banned = kept.join(", ");
      } else if (p.field === "banned" && p.added?.length) {
        const cur = bannedTerms(brand.banned);
        const have = new Set(cur.map(normalize));
        const add = p.added.filter((t) => !have.has(normalize(t)));
        if (!add.length) { await close("stale"); return { ok: false, error: "stale" }; }
        const merged = [(brand.banned ?? "").trim(), add.join(", ")].filter(Boolean).join(", ");
        if (merged.length > FIELD_MAX.banned) return { ok: false, error: "too_long" };
        brand.banned = merged;
      } else {
        const cur = String(brand[p.field] ?? "");
        if (cur !== p.from) { await close("stale"); return { ok: false, error: "stale" }; }
        const to = String(p.to).slice(0, FIELD_MAX[p.field]);
        if (p.field === "dialect") {
          if (!(DIALECTS as readonly string[]).includes(to)) { await close("stale"); return { ok: false, error: "stale" }; }
          brand.dialect = to as Brand["dialect"];
        } else (brand as unknown as Record<string, string>)[p.field] = to;
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
