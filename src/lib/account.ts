import { db } from "./db";
import { listFiles } from "./files";
import { listBrands, scopeFor } from "./brands";
import { pmap } from "./parallel";
import { revokeAllGrants } from "./oauth";
import { EVENTS } from "./track";
import { codeFor } from "./referral";
import { monthKey } from "./credits";
import { AGENTS } from "./agents";

/** Every per-month usage counter this account can have, from signup month to now. */
function usageKeys(email: string): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let back = 0; back < 36; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const m = monthKey(d);
    for (const part of ["in", "out", "calls", "usd_micro", "cache_read", "cache_write"]) out.push(`usage:${email}:${m}:${part}`);
    for (const kind of ["generate", "review", "chat", "onboard", "image_prompt", "tool", "judge"]) {
      out.push(`usage:${email}:${m}:kind:${kind}`, `usage:${email}:${m}:kind:${kind}:in`, `usage:${email}:${m}:kind:${kind}:out`, `usage:${email}:${m}:kind:${kind}:usd_micro`);
    }
  }
  return out;
}

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
      // The chat feedback log: per brand, and it holds the free-text reason the owner typed, so it must not outlive
      // the account. wipeAccount never deleted it at all.
      `fblog:${s}`,
      `onboardplan:${s}`, `pending:${s}`, `pendingidx:${s}`, `tidxm:${s}`, `tidxv:${s}`, `tasks:${s}`, `files:${s}`, `brand:${s}`, `prefs:${s}`, `chat:${s}`, `convs:${s}`, `gov:${s}`, `schedule:${s}`, `brief:${s}`, `conns:${s}`,
    );
  }
  // Named notification markers: the names are only knowable from the index `once()` keeps.
  const onceNames = await db.smembers(`notifiedkeys:${e}`);
  keys.push(...onceNames.map((k) => `notified:${e}:${k}`), `notifiedkeys:${e}`);

  const token = await db.get<string>(`mcptoken-of:${e}`);
  if (token) keys.push(`mcptoken:${token}`);
  await revokeAllGrants(e); // OAuth tokens issued to connected apps
  keys.push(`mcpgrants:${e}`);
  keys.push(`profile:${e}`, `mcptoken-of:${e}`, `brands:${e}`, `activebrand:${e}`, `user:${e}`);
  // Account-level records that are not brand-scoped. Missing these meant a deleted account left its notifications,
  // referral graph, share-bonus markers and activity history behind, so re-registering the same address inherited
  // them. `notifseen:` is not listed because it carries its own three-day TTL and its suffix cannot be enumerated.
  keys.push(
    `notifs:${e}`,
    `referrals:${e}`,
    `referredBy:${e}`,
    `ref:${codeFor(e)}`,
    `shared:${e}`,
    ...["x", "linkedin", "whatsapp", "instagram"].map((p) => `shared:${e}:${p}`), // pre-set markers
    `ulast:${e}`,
    `weeklylock:${e}`,
    `onboardlock:${e}`,
    ...EVENTS.flatMap((ev) => [`uev:${e}:${ev}`, `ufirst:${e}:${ev}`, `ufirst0:${e}:${ev}`]),
    // Model-spend counters for the months this account could have been active.
    ...usageKeys(e),
    // Lifetime thumbs counters from before the feedback log replaced them. No longer written, but never deleted either.
    ...AGENTS.flatMap((a) => [`fb:${e}:${a.id}:up`, `fb:${e}:${a.id}:down`]),
  );
  await pmap(keys, (k) => db.del(k));
  await Promise.all([db.srem("users:all", e), db.lpush("deleted-accounts", JSON.stringify({ email: e, at: new Date().toISOString() }))]);
}
