import { db } from "./db";
import { listFiles } from "./files";
import { listBrands, scopeFor } from "./brands";
import { pmap } from "./parallel";
import { revokeAllGrants } from "./oauth";
import { EVENTS } from "./track";
import { codeFor, referralKeys } from "./referral";
import { forgetPartnerData } from "./partners";
import { monthKey } from "./credits";
import { AGENTS, AGENT_IDS } from "./agents";
import { chatTrialKey, usageMonthKeys } from "./usage";
import { autoHoldKey, routineFingerprints, routineKeys, routineSkipKeys } from "./routines";
import { activityKey } from "./activity";
import { agentCapFingerprint, seenKey } from "./notifications";
import { membersKey, wipeTeam } from "./team";
import { revokeFeed, revokeFeeds } from "./feed-token";
import { forgetWishlistUser } from "./wishlist";
import { forgetDueScope, secretaryKeys } from "./secretary";
import { revokeCalendarLinks } from "./secretary-gcal";
import { handoffKeys } from "./handoffs";
import { proposalKeys } from "./brand-proposals";
import { ONCE_INDEX, onceClaimKey, onceKey, onceRepairKey } from "./notify";

/**
 * Every per-month usage counter this account can have, from signup month to now. The list per month comes from
 * `usageMonthKeys`, built from KINDS and AGENT_IDS: it was spelled out here by hand, so a new kind or the per-agent
 * counters would have survived the account.
 */
function usageKeys(email: string): string[] {
  const now = new Date();
  return Array.from({ length: 36 }, (_, back) => usageMonthKeys(email, monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))))).flat();
}

/**
 * Wipe every record of an account: all brand scopes, files, tasks, chats, connections, tokens, the user itself, and the
 * team (every member login, member active brand, invite and both indexes, `wipeTeam`). Without the team cascade a
 * member login would point at an email that anyone can register again, and inherit that new account.
 */
export async function wipeAccount(email: string) {
  const e = email;
  // Calendar links first, before anything slow can fail and before the roster is deleted: the owner's and every roster
  // member's (`members:{owner}`). A member added after this read is revoked by `wipeTeam` under `lock:team`. A failure
  // stops the wipe (a retry runs it again) rather than leaving a working link behind a half-wiped account.
  await revokeFeeds([e, ...(await db.smembers(membersKey(e)))]);
  // The owner's linked marketing calendars (Reem B3), every brand's: only our side is dropped, the owner removes access at the provider.
  await revokeCalendarLinks(e);
  const scopes = (await listBrands(e)).map((b) => scopeFor(e, b.id));
  const now = new Date();
  const warnMonths = [monthKey(now), monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))];
  const keys: string[] = [];
  // Every id, not only the newest 200 tasks or 100 conversations: nothing of a deleted account may stay behind. All
  // scopes are read in parallel (Upstash is HTTP per command).
  const perScope = await pmap(scopes, (s) => Promise.all([db.lrange(`tasks:${s}`, 0, -1), listFiles(s), db.lrange(`convs:${s}`, 0, -1), db.smembers(`conns:${s}`), db.smembers(`tidxm:${s}`), secretaryKeys(s), handoffKeys(s, (fp) => seenKey(e, fp)), proposalKeys(s)]));
  scopes.forEach((s, i) => {
    const [taskIds, files, convIds, conns, months, sec, handoffs, proposals] = perScope[i];
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
      // The governance history (who changed which setting, with their email) and its save lock (10 s TTL).
      `govhist:${s}`, `govlock:${s}`,
      // The activity log (titles, file names, member emails) and the routines' "nothing new" markers (8 or 35 days).
      activityKey(s), ...routineSkipKeys(s),
      // Reem's list: every item ever created and not yet purged (open, done and deleted), its indexes (the reminder index
      // included), its audit log, the walk's skips, the evening wrap markers and the agents' handoff notes (`notes:`, a
      // blocked agent's note; not Majed's handoffs below).
      ...sec,
      // Majed's handoffs (the owner's own words and the logins that ran them): every record in the index, its lock, each
      // item's auto-run attempt counter and notification marker (8 days), and the index itself, from the one read above.
      // A record that fell off the index was deleted when it fell.
      ...handoffs,
      // Brand changes an agent proposed (7 days, the brand's old and new offers or banned words), their outcomes, answer
      // claims and index, and the brand lock. The publish markers (`pubtry:`, `publock:`) are left to their TTL (3 days
      // at most): they hold a time or a lock, not account data, and finding them would take every item on every platform.
      ...proposals,
      // Each routine's last run, locks, hold and attempt counts, for every routine id (routines.ts), and the hold of
      // Majed's auto-run under the same weekly cap (360 s).
      ...routineKeys(s), autoHoldKey(s),
      // Follow-up markers that name this brand and live for weeks: the 80% cap warning (35 days) and a routine's run
      // (8 or 35 days), for this and the previous month or period. Left behind, a new account at the same address
      // would never get those follow-ups, and the deleted scope would stay in key names for a month.
      ...AGENT_IDS.flatMap((a) => warnMonths.map((m) => seenKey(e, agentCapFingerprint(s, a, m)))),
      ...routineFingerprints(s).map((fp) => seenKey(e, fp)),
      // Onboarding's per-brand records: the owner's confirmed site and the run's lock (src/lib/onboard-confirm.ts). Only
      // the default brand's lock was deleted, and the confirmation never was. An added brand's held setup charge lives on
      // the account record (`User.onboardPaid`) and goes with it. The game's answers hold the brand name the owner typed.
      `onboardok:${s}`, `onboardlock:${s}`, `onboardgame:${s}`,
      `onboardplan:${s}`, `pending:${s}`, `pendingidx:${s}`, `tidxm:${s}`, `tidxv:${s}`, `tasks:${s}`, `files:${s}`, `brand:${s}`, `prefs:${s}`, `chat:${s}`, `convs:${s}`, `gov:${s}`, `schedule:${s}`, `brief:${s}`, `conns:${s}`,
    );
  });
  // Named one-time email markers, their in-flight claims and their repair flags: the names are only knowable from the
  // index `sendOnce()` keeps (src/lib/notify.ts).
  const onceNames = await db.smembers(ONCE_INDEX(e));
  keys.push(...onceNames.flatMap((k) => [onceKey(e, k), onceClaimKey(e, k), onceRepairKey(e, k)]), ONCE_INDEX(e));

  const token = await db.get<string>(`mcptoken-of:${e}`);
  if (token) keys.push(`mcptoken:${token}`);
  await revokeAllGrants(e); // OAuth tokens issued to connected apps
  // Wishlist: votes are taken back (the counts drop) and suggestions, which carry the email and free text, are removed.
  keys.push(...(await forgetWishlistUser(e)));
  // Partner programme (src/lib/partners.ts): recorded payments and, for a partner, the record with its bank details, the
  // code, the referral set and the ledger. The account also leaves its own partner's referral set.
  keys.push(...(await forgetPartnerData(e)));
  keys.push(`mcpgrants:${e}`);
  keys.push(`profile:${e}`, `mcptoken-of:${e}`, `brands:${e}`, `activebrand:${e}`, `user:${e}`);
  // Account-level records that are not brand-scoped. Missing these meant a deleted account left its notifications,
  // referral graph, share-bonus markers and activity history behind, so re-registering the same address inherited
  // them. The other `notifseen:` markers are not listed: they live a week at most after their last write (Reem's to-do
  // alert markers are set again by each daily run while their step holds, and no run reaches a deleted account) and
  // their suffix cannot be enumerated (the ones that can, per brand, are deleted above).
  keys.push(
    `notifs:${e}`,
    `referrals:${e}`,
    `referredBy:${e}`,
    `ref:${codeFor(e)}`,
    // Referrer bonuses waiting for a friend's first payment, the friends already claimed, this month's paid count.
    ...referralKeys(e),
    `shared:${e}`,
    ...["x", "linkedin", "whatsapp", "instagram"].map((p) => `shared:${e}:${p}`), // pre-set markers
    `ulast:${e}`,
    `weeklylock:${e}`,
    ...EVENTS.flatMap((ev) => [`uev:${e}:${ev}`, `ufirst:${e}:${ev}`, `ufirst0:${e}:${ev}`]),
    // Model-spend counters for the months this account could have been active (the monthly chat messages among them),
    // and the trial's chat messages, which are counted once for the trial and not per month.
    ...usageKeys(e),
    chatTrialKey(e),
    // Lifetime thumbs counters from before the feedback log replaced them. No longer written, but never deleted either.
    ...AGENTS.flatMap((a) => [`fb:${e}:${a.id}:up`, `fb:${e}:${a.id}:down`]),
  );
  // The account record goes first, then the team under its lock: an invite accepted while this runs either finished
  // before `wipeTeam` took `lock:team` (and its member is deleted there) or re-reads the owner after it and finds none.
  await pmap(keys, (k) => db.del(k));
  // The global reminder index names every scope with a reminder: this account's leave it.
  await Promise.all(scopes.map((s) => forgetDueScope(s)));
  await wipeTeam(e);
  // The owner's link once more, now the account is gone: a create that ran between the first revoke and the deletion of
  // `user:{owner}` could have written a new one.
  await Promise.all([revokeFeed(e), db.srem("users:all", e), db.lpush("deleted-accounts", JSON.stringify({ email: e, at: new Date().toISOString() }))]);
}
