import { randomBytes } from "crypto";
import { db } from "./db";
import type { ChatMsg } from "./chat";

/** Multiple conversations per scope, searchable. `chat:{scope}` stays the legacy default thread. */
export type Conversation = { id: string; title: string; createdAt: string; updatedAt: string; count: number };

export async function listConversations(scope: string): Promise<Conversation[]> {
  const ids = await db.lrange(`convs:${scope}`, 0, 99);
  const out: Conversation[] = [];
  for (const id of ids) { const c = await db.get<Conversation>(`conv:${scope}:${id}`); if (c) out.push(c); }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
export async function createConversation(scope: string, title: string): Promise<Conversation> {
  const c: Conversation = { id: randomBytes(6).toString("hex"), title: title.slice(0, 80), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), count: 0 };
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
export async function deleteConversation(scope: string, id: string) {
  await db.del(`conv:${scope}:${id}`);
  await db.del(`chat:${scope}:${id}`);
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
