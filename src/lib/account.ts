import { db } from "./db";
import { listTasks } from "./brand";
import { listFiles } from "./files";
import { listBrands, scopeFor } from "./brands";
import { listConversations } from "./conversations";

/** Wipe every record of an account: all brand scopes, files, tasks, chats, connections, tokens, the user itself. */
export async function wipeAccount(email: string) {
  const e = email;
  const scopes = (await listBrands(e)).map((b) => scopeFor(e, b.id));
  for (const s of scopes) {
    for (const t of await listTasks(s)) await db.del(`task:${s}:${t.id}`);
    for (const f of await listFiles(s)) await db.del(`file:${s}:${f.name}`);
    for (const c of await listConversations(s)) { await db.del(`conv:${s}:${c.id}`); await db.del(`chat:${s}:${c.id}`); }
    for (const k of [`tasks:${s}`, `files:${s}`, `brand:${s}`, `prefs:${s}`, `chat:${s}`, `convs:${s}`, `gov:${s}`, `schedule:${s}`, `brief:${s}`, `conns:${s}`]) await db.del(k);
  }
  const token = await db.get<string>(`mcptoken-of:${e}`);
  if (token) await db.del(`mcptoken:${token}`);
  for (const k of [`profile:${e}`, `mcptoken-of:${e}`, `brands:${e}`, `activebrand:${e}`, `user:${e}`]) await db.del(k);
  await db.lpush("deleted-accounts", JSON.stringify({ email: e, at: new Date().toISOString() }));
}
