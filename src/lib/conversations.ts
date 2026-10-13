import { randomBytes } from "crypto";
import { db, mgetChunked } from "./db";
import { pmap } from "./parallel";
import type { ChatMsg } from "./chat";
import type { AgentId } from "./agents";

/**
 * Multiple conversations per scope, searchable. `chat:{scope}` stays the legacy default thread, which has no record.
 * `model`: the conversation's chat pick (src/lib/models/overrides.ts), set and cleared only by PUT /api/models; absent:
 * automatic. Absent on conversations saved before 2026-10-08.
 */
export type Conversation = { id: string; title: string; createdAt: string; updatedAt: string; count: number; agent?: AgentId; model?: string };

/**
 * A conversation id as `createConversation` makes them, checked before it is put in a key: letters, digits, "_" and "-",
 * at most 64. A request's id is never trusted as is; within the caller's scope it can only name the caller's own records.
 */
const isConversationId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** The record of conversation `id` under `scope`, or null: not one, or not a well-formed id (nothing is read then). */
export async function getConversation(scope: string, id: unknown): Promise<Conversation | null> {
  if (!isConversationId(id)) return null;
  return db.get<Conversation>(`conv:${scope}:${id}`);
}

/**
 * One lock per conversation (`convlock:{scope}:{id}`, built from the caller's scope and an id that passed
 * `isConversationId`, never from anything else in a request), held by every writer of its record: the pick
 * (`setConversationModel`), a turn's `touchConversation`, `renameConversation` and `deleteConversation`, which the account wipe calls for every conversation (src/lib/account.ts). Each of them reads
 * the whole record and writes it back, so without the lock a writer that read before another one wrote would put back
 * what it read: a pick the owner cleared would come back, or a record deleted meanwhile would be recreated outside the
 * `convs:` index, where the account wipe never finds it and `liveConversations` reports a deleted thread as live.
 * Under the lock a writer reads the record again and writes only while it still exists, so none of them recreates a
 * deleted conversation.
 *
 * SET NX with a 10 s TTL and an owner token (`lockOwned`), tried up to 60 times 50 ms apart (about 3 s), as the brand and
 * task locks are. Each writer holds it for one read and one write, far under the TTL; the TTL only frees the lock of a
 * writer that died. Not taken within the bound: `busy`, and nothing is read or written.
 */
const LOCK_TRIES = 60;
const LOCK_WAIT_MS = 50;
const LOCK_TTL_S = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function withConversationLock<T>(scope: string, id: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const key = `convlock:${scope}:${id}`;
  let token: string | null = null;
  for (let i = 0; i < LOCK_TRIES && !token; i++) {
    token = await db.lockOwned(key, LOCK_TTL_S);
    if (!token && i < LOCK_TRIES - 1) await sleep(LOCK_WAIT_MS);
  }
  if (!token) return { ok: false };
  try {
    return { ok: true, value: await fn() };
  } finally {
    await db.unlockOwned(key, token).catch((e) => console.error("conversation lock release failed", e instanceof Error ? e.name : "error"));
  }
}

/** What a conversation writer did: `busy` when it could not take the conversation's lock in time and wrote nothing. */
export type ConversationWrite = "ok" | "not_found" | "busy";

/**
 * Set (`model`, an id the caller validated) or clear (null: the field is deleted, never stored as "null") the
 * conversation's chat pick, under the conversation's lock. `not_found`, and nothing written, when there is no such
 * conversation under `scope`, including one deleted while this call waited for the lock. `busy` (the lock was not taken
 * in time; PUT /api/models answers 503 and the owner presses again): nothing was written.
 */
export async function setConversationModel(scope: string, id: unknown, model: string | null): Promise<ConversationWrite> {
  if (!isConversationId(id)) return "not_found";
  const key = `conv:${scope}:${id}`;
  const r = await withConversationLock(scope, id, async () => {
    const c = await db.get<Conversation>(key);
    if (!c || c.id !== id) return false;
    if (model === null) delete c.model;
    else c.model = model;
    await db.set(key, c);
    return true;
  });
  if (!r.ok) return "busy";
  return r.value ? "ok" : "not_found";
}

export async function listConversations(scope: string): Promise<Conversation[]> {
  const ids = await db.lrange(`convs:${scope}`, 0, 99);
  // Up to 100 conversations in one MGET (rule 1430), not one command each: the sidebar asks on every navigation.
  const out = (await mgetChunked<Conversation>(ids.map((id) => `conv:${scope}:${id}`))).filter((c): c is Conversation => !!c);
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
export async function createConversation(scope: string, title: string, agent: AgentId = "noor"): Promise<Conversation> {
  const c: Conversation = { id: randomBytes(6).toString("hex"), title: title.slice(0, 80), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), count: 0, agent };
  await db.set(`conv:${scope}:${c.id}`, c);
  await db.lpush(`convs:${scope}`, c.id);
  return c;
}
/**
 * A turn's bookkeeping (time, count, first title), under the conversation's lock; nothing when the conversation does
 * not exist or was deleted meanwhile. Never fails the turn: when the lock is not taken in time the update is skipped
 * (logged without the account or the id) and the next turn's touch counts again from the record as it is.
 */
export async function touchConversation(scope: string, id: string, firstUserText?: string): Promise<void> {
  if (!isConversationId(id)) return;
  const key = `conv:${scope}:${id}`;
  const r = await withConversationLock(scope, id, async () => {
    const c = await db.get<Conversation>(key);
    if (!c) return;
    c.updatedAt = new Date().toISOString();
    c.count += 1;
    if (firstUserText && (c.title === "" || c.title === "…")) c.title = firstUserText.slice(0, 60);
    await db.set(key, c);
  });
  if (!r.ok) console.warn("conversation touch skipped: lock busy");
}
/** Rename under the conversation's lock; `not_found` (nothing written) when it does not exist, `busy` when the lock was not taken. */
export async function renameConversation(scope: string, id: string, title: string): Promise<ConversationWrite> {
  if (!isConversationId(id)) return "not_found";
  const key = `conv:${scope}:${id}`;
  const r = await withConversationLock(scope, id, async () => {
    const c = await db.get<Conversation>(key);
    if (!c) return false;
    c.title = title.slice(0, 80);
    await db.set(key, c);
    return true;
  });
  if (!r.ok) {
    console.warn("conversation rename skipped: lock busy");
    return "busy";
  }
  return r.value ? "ok" : "not_found";
}
/**
 * Which of `ids` are conversations that still exist under `scope`, in ONE request (MGET of their records). A deleted
 * conversation has no record: `deleteConversation` removes it with the thread. Majed's auto-run reads this so a
 * handoff whose card was in a thread the owner deleted never starts on its own (src/lib/handoff-auto.ts).
 */
export async function liveConversations(scope: string, ids: readonly string[]): Promise<Set<string>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Set();
  const rows = await db.mget<Conversation>(uniq.map((id) => `conv:${scope}:${id}`));
  return new Set(uniq.filter((_, i) => rows[i] !== null));
}
/**
 * Delete a conversation: its record, its thread and its id in the index, under the conversation's lock, so a writer that
 * read the record before cannot write it back afterwards. `busy` (nothing deleted) when the lock was not taken in time.
 */
export async function deleteConversation(scope: string, id: string): Promise<ConversationWrite> {
  if (!isConversationId(id)) return "not_found";
  const r = await withConversationLock(scope, id, async () => {
    // The id has to leave the index as well as the record. `listConversations` reads only the newest 100 ids, so dead
    // ids left behind push live conversations out of that window and they disappear from the owner's list for good.
    await Promise.all([db.del(`conv:${scope}:${id}`), db.del(`chat:${scope}:${id}`), db.lrem(`convs:${scope}`, id)]);
  });
  return r.ok ? "ok" : "busy";
}
/** Substring search across all conversations (server-side, bounded). */
export async function searchConversations(scope: string, q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: { conversationId: string; title: string; snippet: string; at: string }[] = [];
  const convs = await listConversations(scope);
  const threads: [string, string][] = [["default", `chat:${scope}`], ...convs.map((c): [string, string] => [c.id, `chat:${scope}:${c.id}`])];
  // Every thread read together, 8 at a time (rule 1431): one awaited LRANGE per thread made a search on 100 threads 101
  // round trips in a row.
  const pages = await pmap(threads, ([, key]) => db.lrange(key, 0, 199), 8);
  for (const [t, [id]] of threads.entries()) {
    for (const r of pages[t]) {
      const m = JSON.parse(r) as ChatMsg;
      const i = m.content.toLowerCase().indexOf(needle);
      if (i >= 0) hits.push({ conversationId: id, title: convs.find((c) => c.id === id)?.title ?? (id === "default" ? "Getting started" : id), snippet: m.content.slice(Math.max(0, i - 60), i + 100), at: m.at });
      if (hits.length >= 50) return hits;
    }
  }
  return hits.sort((a, b) => (a.at < b.at ? 1 : -1));
}
