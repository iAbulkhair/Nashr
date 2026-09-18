import { db } from "./db";
import { listFiles } from "./files";
import { listBrands, scopeFor } from "./brands";
import { pmap } from "./parallel";
import { revokeAllGrants } from "./oauth";

/** Wipe every record of an account: all brand scopes, files, tasks, chats, connections, tokens, the user itself. */
export async function wipeAccount(email: string) {
  const e = email;
  const scopes = (await listBrands(e)).map((b) => scopeFor(e, b.id));
  const keys: string[] = [];
  for (const s of scopes) {
    // Every id, not only the newest 200 tasks or 100 conversations: nothing of a deleted account may stay behind.
    const [taskIds, files, convIds, conns, months] = await Promise.all([db.lrange(`tasks:${s}`, 0, -1), listFiles(s), db.lrange(`convs:${s}`, 0, -1), db.smembers(`conns:${s}`), db.smembers(`tidxm:${s}`)]);
    keys.push(
      ...taskIds.map((id) => `task:${s}:${id}`),
      ...files.map((f) => `file:${s}:${f.name}`),
      ...convIds.flatMap((id) => [`conv:${s}:${id}`, `chat:${s}:${id}`]),
      ...conns.map((p) => `conn:${s}:${p}`), // encrypted third-party credentials
      ...months.map((m) => `tidx:${s}:${m}`),
      `onboardplan:${s}`, `pending:${s}`, `pendingidx:${s}`, `tidxm:${s}`, `tidxv:${s}`, `tasks:${s}`, `files:${s}`, `brand:${s}`, `prefs:${s}`, `chat:${s}`, `convs:${s}`, `gov:${s}`, `schedule:${s}`, `brief:${s}`, `conns:${s}`,
    );
  }
  const token = await db.get<string>(`mcptoken-of:${e}`);
  if (token) keys.push(`mcptoken:${token}`);
  await revokeAllGrants(e); // OAuth tokens issued to connected apps
  keys.push(`mcpgrants:${e}`);
  keys.push(`profile:${e}`, `mcptoken-of:${e}`, `brands:${e}`, `activebrand:${e}`, `user:${e}`);
  await pmap(keys, (k) => db.del(k));
  await Promise.all([db.srem("users:all", e), db.lpush("deleted-accounts", JSON.stringify({ email: e, at: new Date().toISOString() }))]);
}
