import { randomBytes } from "crypto";
import { CAPS, db, pushCapped } from "./db";
import { SEED_WISHES, SEED_WISH_IDS, type Bi, type WishArea, type WishStatus, isWishStatus } from "./changelog";

/**
 * Wishlist storage for /{lang}/updates. Content that never changes at runtime (the changelog and the seeded wishes)
 * lives in changelog.ts; this file holds what people and the founder add.
 *
 * Keys:
 *   wish:votes:{itemId}   set of account emails that voted for the item. The item id is checked against the known
 *                         items before any key is built, and the email is always the session's, never the body's.
 *   wish:mine:{email}     set of item ids that account voted for (so a page render reads the viewer's votes in one call).
 *   wish:items            hash id -> PromotedWish: suggestions the founder promoted to public items.
 *   wish:status           hash id -> WishStatus: the founder's status for any item (seeded items default to planned).
 *   wish:hidden           set of seeded item ids the founder removed from the public list (they live in code).
 *   wish:suggestions      capped list (CAPS.wishSuggestions) of JSON Suggestion, newest first. Never public.
 *
 * Votes are per account, not per brand: one person, one vote, whichever brand is active.
 */

export type PromotedWish = { id: string; title: Bi; area?: WishArea; at: string };
export type Wish = { id: string; title: Bi; area: WishArea | null; status: WishStatus; votes: number; voted: boolean; seeded: boolean; hidden: boolean };
export type Suggestion = { id: string; email: string; text: string; lang: "ar" | "en"; at: string };

const K = {
  votes: (id: string) => `wish:votes:${id}`,
  mine: (email: string) => `wish:mine:${email}`,
  items: "wish:items",
  status: "wish:status",
  hidden: "wish:hidden",
  suggestions: "wish:suggestions",
} as const;
export const WISH_KEYS = K;

/** Shape of every item id, seeded or promoted. Anything else is refused before a key is built. */
const ID_RE = /^[a-z0-9-]{1,40}$/;
export const wellFormedId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

/**
 * Untrusted free text in, one plain line out: control characters (including newlines) become spaces, invisible and
 * direction-override characters are dropped (they can make a line in the console read differently from what it
 * says), whitespace is collapsed. The caller checks the length of the result.
 */
export function cleanText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .slice(0, 4000)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function catalog() {
  const [promoted, status, hidden] = await Promise.all([db.hgetall<PromotedWish>(K.items), db.hgetall<string>(K.status), db.smembers(K.hidden)]);
  return { promoted, status, hidden: new Set(hidden) };
}

/** The id if it names an item people can vote on today (a seeded item not hidden, or a promoted one), else null. */
export async function votableId(v: unknown): Promise<string | null> {
  if (!wellFormedId(v)) return null;
  if (SEED_WISH_IDS.has(v)) return (await db.smembers(K.hidden)).includes(v) ? null : v;
  const promoted = await db.hgetall<PromotedWish>(K.items);
  return Object.prototype.hasOwnProperty.call(promoted, v) ? v : null;
}

const RANK: Record<WishStatus, number> = { in_progress: 0, planned: 1, shipped: 2 };

/**
 * Every item with its vote count, and whether `email` voted for it. Four reads side by side, then every count in one
 * pipelined request: the page costs the same number of round trips with 30 items or 300.
 * `includeHidden` is for the founder console only.
 */
export async function listWishes(email?: string | null, opts: { includeHidden?: boolean } = {}): Promise<Wish[]> {
  const [{ promoted, status, hidden }, mine] = await Promise.all([catalog(), email ? db.smembers(K.mine(email)) : Promise.resolve([] as string[])]);
  const mineSet = new Set(mine);
  const base = [
    ...SEED_WISHES.map((w) => ({ id: w.id, title: w.title, area: w.area as WishArea | null, seeded: true })),
    ...Object.values(promoted).sort((a, b) => a.at.localeCompare(b.at)).map((w) => ({ id: w.id, title: w.title, area: w.area ?? null, seeded: false })),
  ].filter((w) => opts.includeHidden || !hidden.has(w.id));
  const counts = await db.scardMany(base.map((w) => K.votes(w.id)));
  const out: Wish[] = base.map((w, i) => ({ ...w, status: isWishStatus(status[w.id]) ? status[w.id] as WishStatus : "planned", votes: counts[i] ?? 0, voted: mineSet.has(w.id), hidden: hidden.has(w.id) }));
  // Open work first (in progress, then planned), most votes first; shipped at the end. Ties keep the seed order.
  return out.map((w, i) => ({ w, i })).sort((a, b) => RANK[a.w.status] - RANK[b.w.status] || b.w.votes - a.w.votes || a.i - b.i).map(({ w }) => w);
}

/**
 * Vote or take the vote back. `on` states the result the caller wants, so repeating a request changes nothing; without
 * it the vote toggles. `email` must come from the session and `id` from `votableId`.
 */
export async function setVote(email: string, id: string, on?: boolean): Promise<{ voted: boolean; votes: number }> {
  const want = typeof on === "boolean" ? on : !(await db.smembers(K.mine(email))).includes(id);
  if (want) await Promise.all([db.sadd(K.votes(id), email), db.sadd(K.mine(email), id)]);
  else await Promise.all([db.srem(K.votes(id), email), db.srem(K.mine(email), id)]);
  const [votes] = await db.scardMany([K.votes(id)]);
  return { voted: want, votes: votes ?? 0 };
}

export async function addSuggestion(email: string, text: string, lang: "ar" | "en"): Promise<Suggestion> {
  const s: Suggestion = { id: `s-${randomBytes(6).toString("hex")}`, email, text, lang, at: new Date().toISOString() };
  await pushCapped(K.suggestions, JSON.stringify(s), CAPS.wishSuggestions);
  return s;
}

async function rawSuggestions(): Promise<{ raw: string; s: Suggestion }[]> {
  const rows = await db.lrange(K.suggestions, 0, CAPS.wishSuggestions - 1);
  return rows.flatMap((raw) => { try { return [{ raw, s: JSON.parse(raw) as Suggestion }]; } catch { return []; } });
}
export async function listSuggestions(): Promise<Suggestion[]> {
  return (await rawSuggestions()).map((r) => r.s);
}
/** True when a suggestion with this id was in the queue. */
export async function removeSuggestion(id: string): Promise<boolean> {
  const hit = (await rawSuggestions()).find((r) => r.s.id === id);
  if (hit) await db.lrem(K.suggestions, hit.raw);
  return !!hit;
}

/** Founder: publish a wish under a title the founder writes (never the suggester's raw text). */
export async function promoteWish(title: Bi, area?: WishArea, suggestionId?: string): Promise<PromotedWish> {
  const w: PromotedWish = { id: `w-${randomBytes(4).toString("hex")}`, title, ...(area ? { area } : {}), at: new Date().toISOString() };
  await Promise.all([db.hset(K.items, w.id, w), suggestionId ? removeSuggestion(suggestionId) : Promise.resolve(false)]);
  return w;
}

/** An id the founder can act on: seeded (hidden or not) or promoted. */
export async function existingId(v: unknown): Promise<string | null> {
  if (!wellFormedId(v)) return null;
  if (SEED_WISH_IDS.has(v)) return v;
  return Object.prototype.hasOwnProperty.call(await db.hgetall<PromotedWish>(K.items), v) ? v : null;
}

export async function setWishStatus(id: string, status: WishStatus) {
  await db.hset(K.status, id, status);
}

/** Seeded items are hidden (they live in code); promoted items are deleted with their votes and status. */
export async function removeWish(id: string) {
  if (SEED_WISH_IDS.has(id)) await db.sadd(K.hidden, id);
  else await Promise.all([db.hdel(K.items, id), db.hdel(K.status, id), db.del(K.votes(id))]);
}
export async function restoreWish(id: string) {
  if (SEED_WISH_IDS.has(id)) await db.srem(K.hidden, id);
}

/**
 * Account deletion: take this account's votes back and drop its suggestions (they carry the email and free text).
 * Returns the keys the caller deletes with the rest of the account.
 */
export async function forgetWishlistUser(email: string): Promise<string[]> {
  const [mine, sugg] = await Promise.all([db.smembers(K.mine(email)), rawSuggestions()]);
  await Promise.all([...mine.map((id) => db.srem(K.votes(id), email)), ...sugg.filter((r) => r.s.email === email).map((r) => db.lrem(K.suggestions, r.raw))]);
  return [K.mine(email)];
}
