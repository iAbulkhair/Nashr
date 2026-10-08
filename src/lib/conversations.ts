import { randomBytes } from "crypto";
import { db } from "./db";
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
 * Set (`model`, an id the caller validated) or clear (null: the field is deleted, never stored as "null") the
 * conversation's chat pick. False, and nothing written, when there is no such conversation under `scope`. Read and
 * written without a lock, like a rename: a pick saved while a turn's `touchConversation` runs can be lost, and the owner
 * sets it again.
 */
export async function setConversationModel(scope: string, id: unknown, model: string | null): Promise<boolean> {
  if (!isConversationId(id)) return false;
  const c = await db.get<Conversation>(`conv:${scope}:${id}`);
  if (!c) return false;
  if (model === null) delete c.model;
  else c.model = model;
  await db.set(`conv:${scope}:${id}`, c);
  return true;
}

export async function listConversations(scope: string): Promise<Conversation[]> {
  const ids = await db.lrange(`convs:${scope}`, 0, 99);
  // Up to 100 conversations: read together instead of one round trip after another (the sidebar asks on every navigation).
  const out = (await pmap(ids, (id) => db.get<Conversation>(`conv:${scope}:${id}`))).filter((c): c is Conversation => !!c);
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
export async function createConversation(scope: string, title: string, agent: AgentId = "noor"): Promise<Conversation> {
  const c: Conversation = { id: randomBytes(6).toString("hex"), title: title.slice(0, 80), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), count: 0, agent };
  await db.set(`conv:${scope}:${c.id}`, c);
  await db.lpush(`convs:${scope}`, c.id);
  return c;
}
export async function touchConversation(scope: string, id: string, firstUserText?: string) {
  const c = await db.get<Conversation>(`conv:${scope}:${id}`);
  if (!c) return;
  c.updatedAt = new Date().toISOString();
  c.count += 1;
  if (firstUserText && (c.title === "" || c.title === "…")) c.title = firstUserText.slice(0, 60);
  await db.set(`conv:${scope}:${id}`, c);
}
export async function renameConversation(scope: string, id: string, title: string) {
  const c = await db.get<Conversation>(`conv:${scope}:${id}`);
  if (c) { c.title = title.slice(0, 80); await db.set(`conv:${scope}:${id}`, c); }
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
export async function deleteConversation(scope: string, id: string) {
  // The id has to leave the index as well as the record. `listConversations` reads only the newest 100 ids, so dead
  // ids left behind push live conversations out of that window and they disappear from the owner's list for good.
  await Promise.all([db.del(`conv:${scope}:${id}`), db.del(`chat:${scope}:${id}`), db.lrem(`convs:${scope}`, id)]);
}
/** Substring search across all conversations (server-side, bounded). */
export async function searchConversations(scope: string, q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: { conversationId: string; title: string; snippet: string; at: string }[] = [];
  const convs = await listConversations(scope);
  const threads: [string, string][] = [["default", `chat:${scope}`], ...convs.map((c): [string, string] => [c.id, `chat:${scope}:${c.id}`])];
  for (const [id, key] of threads) {
    const rows = await db.lrange(key, 0, 199);
    for (const r of rows) {
      const m = JSON.parse(r) as ChatMsg;
      const i = m.content.toLowerCase().indexOf(needle);
      if (i >= 0) hits.push({ conversationId: id, title: convs.find((c) => c.id === id)?.title ?? (id === "default" ? "Getting started" : id), snippet: m.content.slice(Math.max(0, i - 60), i + 100), at: m.at });
      if (hits.length >= 50) return hits;
    }
  }
  return hits.sort((a, b) => (a.at < b.at ? 1 : -1));
}
