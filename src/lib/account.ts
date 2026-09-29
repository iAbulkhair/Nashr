import { db } from "./db";
import { listFiles } from "./files";
import { listBrands, scopeFor } from "./brands";
import { pmap } from "./parallel";
import { revokeAllGrants } from "./oauth";
import { EVENTS } from "./track";
import { codeFor } from "./referral";
import { monthKey } from "./credits";
import { AGENTS, AGENT_IDS } from "./agents";
import { usageMonthKeys } from "./usage";
import { routineFingerprints, routineKeys } from "./routines";
import { agentCapFingerprint, seenKey } from "./notifications";
import { forgetWishlistUser } from "./wishlist";

/**
 * Every per-month usage counter this account can have, from signup month to now. The list per month comes from
 * `usageMonthKeys`, built from KINDS and AGENT_IDS: it was spelled out here by hand, so a new kind or the per-agent
 * counters would have survived the account.
 */
function usageKeys(email: string): string[] {
  const now = new Date();
  return Array.from({ length: 36 }, (_, back) => usageMonthKeys(email, monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))))).flat();
}

/** Wipe every record of an account: all brand scopes, files, tasks, chats, connections, tokens, the user itself. */
export async function wipeAccount(email: string) {
  const e = email;
  const scopes = (await listBrands(e)).map((b) => scopeFor(e, b.id));
  const now = new Date();
  const warnMonths = [monthKey(now), monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))];
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
      // The owner's decision records: per brand, with the reasons the owner typed.
      `decisions:${s}`,
      // Each routine's last run, locks, hold and attempt counts, for every routine id (routines.ts).
      ...routineKeys(s),
      // Follow-up markers that name this brand and live for weeks: the 80% cap warning (35 days) and a routine's run
      // (8 or 35 days), for this and the previous month or period. Left behind, a new account at the same address
      // would never get those follow-ups, and the deleted scope would stay in key names for a month.
      ...AGENT_IDS.flatMap((a) => warnMonths.map((m) => seenKey(e, agentCapFingerprint(s, a, m)))),
      ...routineFingerprints(s).map((fp) => seenKey(e, fp)),
      `onboardplan:${s}`, `pending:${s}`, `pendingidx:${s}`, `tidxm:${s}`, `tidxv:${s}`, `tasks:${s}`, `files:${s}`, `brand:${s}`, `prefs:${s}`, `chat:${s}`, `convs:${s}`, `gov:${s}`, `schedule:${s}`, `brief:${s}`, `conns:${s}`,
    );
  }
  // Named notification markers: the names are only knowable from the index `once()` keeps.
  const onceNames = await db.smembers(`notifiedkeys:${e}`);
  keys.push(...onceNames.map((k) => `notified:${e}:${k}`), `notifiedkeys:${e}`);

  const token = await db.get<string>(`mcptoken-of:${e}`);
  if (token) keys.push(`mcptoken:${token}`);
  await revokeAllGrants(e); // OAuth tokens issued to connected apps
  // Wishlist: votes are taken back (the counts drop) and suggestions, which carry the email and free text, are removed.
  keys.push(...(await forgetWishlistUser(e)));
  keys.push(`mcpgrants:${e}`);
  keys.push(`profile:${e}`, `mcptoken-of:${e}`, `brands:${e}`, `activebrand:${e}`, `user:${e}`);
  // Account-level records that are not brand-scoped. Missing these meant a deleted account left its notifications,
  // referral graph, share-bonus markers and activity history behind, so re-registering the same address inherited
  // them. The other `notifseen:` markers are not listed: they live a week at most and their suffix cannot be
  // enumerated (the ones that can, per brand, are deleted above).
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
