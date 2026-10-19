import { db } from "./db";
import { deleteConversation } from "./conversations";
import { listFiles } from "./files";
import { listBrands } from "./brands";
import { pmap } from "./parallel";
import { revokeAllGrants } from "./oauth";
import { EVENTS } from "./track";
import { codeFor, referralKeys } from "./referral";
import { forgetPartnerData } from "./partners";
import { monthKey } from "./credits";
import { AGENTS, AGENT_IDS } from "./agents";
import { chatTrialKey, usageMonthKeys } from "./usage";
import { OWNER_SYNC_KEY, autoHoldKey, routineFingerprints, routineKeys, routineSkipKeys } from "./routines";
import { activityKey } from "./activity";
import { agentCapFingerprint, seenKey } from "./notifications";
import { membersKey, wipeTeam, withLoginLock } from "./team";
import { revokeBook, revokeBooks } from "./booking-token";
import { revokeFeed, revokeFeeds } from "./feed-token";
import { forgetWishlistUser } from "./wishlist";
import { forgetDueScope, secretaryKeys } from "./secretary";
import { revokeCalendarLinks } from "./secretary-gcal";
import { handoffKeys } from "./handoffs";
import { paymobAccountKeys, stopRenewals } from "./billing";
import { mfaKeys } from "./mfa";
import { revokeAllDevices } from "./devices";
import { freePlaces } from "./founding";
import { proposalKeys } from "./brand-proposals";
import { ONCE_INDEX, onceClaimKey, onceKey, onceRepairKey } from "./notify";
import { profileKey } from "./notify-prefs";
import { getConnection } from "./connectors/store";
import { isComposio, revokeAll } from "./connectors/via-composio";
import { AD_PROVIDERS } from "./connectors/ads";
import { AD_STATS_SOURCES, ADSTATS_KEY } from "./ad-stats";
import { XSTATS_KEY } from "./social-read/common";
import { instructionKeys, removeFeedRowsFor } from "./instructions-store";
import { instructionProposalKeys } from "./instruction-proposals";
import { spendProposalKeys } from "./spend-proposals";
import { forgetScopeMedia } from "./media/store";
import { log } from "./log";
import { type Scope, accountKey, globalKey, personKey, storedPersonId, workspaceScope, wsKey } from "./keys";
import { getAccount, normalizeEmail, releaseLogin } from "./auth";

/**
 * Every per-month usage counter this account can have, from signup month to now. The list per month comes from
 * `usageMonthKeys`, built from KINDS and AGENT_IDS: it was spelled out here by hand, so a new kind or the per-agent
 * counters would have survived the account.
 */
function usageKeys(email: string): string[] {
  const now = new Date();
  return Array.from({ length: 36 }, (_, back) => usageMonthKeys(email, monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))))).flat();
}

async function revokeComposio(scopes: Scope[]) {
  const ids = await pmap(scopes, (s) => db.smembers(wsKey.conns(s)));
  const pairs = scopes.flatMap((s, i) => ids[i].map((p) => [s, p] as const));
  const conns = await pmap(pairs, ([s, p]) => getConnection(s, p).catch(() => null));
  const left = await pmap(pairs, ([s], i) => {
    const c = conns[i];
    return c && isComposio(c) ? revokeAll(s, c).catch(() => ["all"]) : Promise.resolve([] as string[]);
  });
  const failed = left.flat().length;
  if (failed) log.error("account wipe: composio revoke failed", { failed });
}

/**
 * Wipe every record of an account: all brand scopes, files, tasks, chats, connections, tokens, the user itself, and the
 * team (every member login, member active brand, invite and both indexes, `wipeTeam`). Without the team cascade a
 * member login would point at an email that anyone can register again, and inherit that new account.
 *
 * `id` is the account id (`acct(u)`, rule 1980): every account key below is built from it. The owner's sign-in address
 * is read from the record (in R1 it equals the id), and its login index goes with the account; another account's index
 * is never deleted (`releaseLogin` deletes only an index that names this account, rule 1999). `loginLocked`: the caller
 * holds `lock:login:{address}` already (the address move), so the release does not take it again (security review L1).
 * `teamLocked`: the caller holds `lock:team:{id}` (the address move, `withMoveTeamLock`), so `wipeTeam` does not take it.
 */
export async function wipeAccount(id: string, opts: { userLocked?: boolean; loginLocked?: boolean; teamLocked?: boolean } = {}) {
  const e = id;
  const login = normalizeEmail((await getAccount(e))?.email ?? e);
  // Rule 1955: no charge after the owner asked to delete. Renewal turns off and the saved card goes under the account
  // lock before anything slow can fail, so a retry after a failed wipe still finds nothing to charge, and a renewal
  // already running stops at its own re-check under that lock (src/lib/billing.ts `chargeSavedCard`). A caller already
  // inside `withUserLock(email)` (the address move, `moveOwnerLogin`) says so: the lock is not reentrant.
  await stopRenewals(e, opts);
  // Calendar feed and booking links first, before anything slow can fail and before the roster is deleted: the owner's and every roster
  // member's (`members:{owner}`). A member added after this read is revoked by `wipeTeam` under `lock:team`. A failure
  // stops the wipe (a retry runs it again) rather than leaving a working link behind a half-wiped account.
  const logins = [login, ...(await db.smembers(membersKey(e)))];
  // The owner's linked marketing calendars (Reem B3), every brand's: only our side is dropped, the owner removes access at the provider.
  await Promise.all([revokeFeeds(logins), revokeBooks(logins), revokeCalendarLinks(e)]);
  // The account's own brand list, read under its owner email: the scopes come from our records, never from a request.
  const scopes = (await listBrands(e)).map((b) => workspaceScope(e, b.id));
  // Each conversation goes through the writer lock first (`deleteConversation`: its record, its thread and its id in the
  // index, under `convlock:{scope}:{id}`), before any third-party grant is revoked. A turn's touch, a rename or a pick that
  // had read the record and not yet written it would otherwise put it back after the wipe, a record of a deleted account
  // outside every index; under the lock it either finishes first and is deleted here, or finds no record and writes
  // nothing. A lock not taken in time stops the wipe, as a failed link revocation does: the account is kept and a retry
  // runs it again.
  const earlyConvIds = await pmap(scopes, (s) => db.lrange(wsKey.convs(s), 0, -1));
  await pmap(scopes.flatMap((s, i) => earlyConvIds[i].map((id) => [s, id] as const)), async ([s, id]) => {
    if ((await deleteConversation(s, id)) === "busy") throw new Error("account wipe: a conversation is being written, try again");
  });
  // Platform grants held by Composio are revoked while the records that name them still exist. A failure is logged, not
  // fatal: the account must still be deleted, and the founder can revoke what is left from Composio's dashboard.
  await revokeComposio(scopes);
  const now = new Date();
  const warnMonths = [monthKey(now), monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))];
  const keys: string[] = [];
  // Every id, not only the newest 200 tasks or 100 conversations: nothing of a deleted account may stay behind. All
  // scopes are read in parallel (Upstash is HTTP per command).
  const perScope = await pmap(scopes, (s) => Promise.all([db.lrange(wsKey.tasks(s), 0, -1), listFiles(s), db.lrange(wsKey.convs(s), 0, -1), db.smembers(wsKey.conns(s)), db.smembers(wsKey.taskMonths(s)), secretaryKeys(s), handoffKeys(s, (fp) => seenKey(e, fp)), proposalKeys(s), instructionProposalKeys(s), spendProposalKeys(s)]));
  scopes.forEach((s, i) => {
    const [taskIds, files, convIds, conns, months, sec, handoffs, proposals, instrProposals, spendProposals] = perScope[i];
    keys.push(
      ...taskIds.map((id) => wsKey.task(s, id)),
      ...files.map((f) => wsKey.file(s, f.name)),
      // Already deleted under their lock above; listed again for an id `deleteConversation` refuses (a malformed one) and
      // for the lock key itself (10 s TTL, src/lib/conversations.ts).
      ...convIds.flatMap((id) => [wsKey.conv(s, id), wsKey.chat(s, id), wsKey.convLock(s, id)]),
      ...conns.map((p) => wsKey.conn(s, p)), // encrypted third-party credentials
      ...months.map((m) => wsKey.taskMonth(s, m)),
      // The chat feedback log: per brand, and it holds the free-text reason the owner typed, so it must not outlive
      // the account. wipeAccount never deleted it at all.
      wsKey.feedbackLog(s),
      // The owner's decision records: per brand, with the reasons the owner typed.
      wsKey.decisions(s),
      // The governance history (who changed which setting, with their email) and its save lock (10 s TTL).
      wsKey.govHistory(s), wsKey.govLock(s),
      // The agent instructions of this brand: its layer, revision history and write lock (src/lib/instructions-store.ts).
      ...instructionKeys(s),
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
      // Instructions an agent proposed from chat (7 days, the owner's own rule text), their outcomes and claims, the index
      // and the day's proposal counter (src/lib/instruction-proposals.ts).
      ...instrProposals,
      // Paid work waiting on a chat card (rule 1511): the proposal, its outcome and claim, and the index.
      ...spendProposals,
      // Each routine's last run, locks, hold and attempt counts, for every routine id (routines.ts), and the hold of
      // Majed's auto-run under the same weekly cap (360 s).
      ...routineKeys(s), autoHoldKey(s),
      // When someone last pressed Refresh on the site or social results, which Dana's routine counts (8 days, rule 747).
      OWNER_SYNC_KEY(s),
      // Follow-up markers that name this brand and live for weeks: the 80% cap warning (35 days) and a routine's run
      // (8 or 35 days), for this and the previous month or period. Left behind, a new account at the same address
      // would never get those follow-ups, and the deleted scope would stay in key names for a month.
      ...AGENT_IDS.flatMap((a) => warnMonths.map((m) => seenKey(e, agentCapFingerprint(s, a, m)))),
      ...routineFingerprints(s).map((fp) => seenKey(e, fp)),
      // Onboarding's per-brand records: the owner's confirmed site and the run's lock (src/lib/onboard-confirm.ts). Only
      // the default brand's lock was deleted, and the confirmation never was. An added brand's held setup charge lives on
      // the account record (`User.onboardPaid`) and goes with it. The game's answers hold the brand name the owner typed.
      wsKey.onboardOk(s), wsKey.onboardLock(s), wsKey.onboardGame(s),
      // The site's GA4 and Search Console totals (src/lib/site-stats.ts): the public's search queries and the site's pages.
      wsKey.siteStats(s),
      // Instagram and LinkedIn page results (src/lib/social-stats.ts): captions are the owner's or the public's text,
      // and the Instagram ids Thakeen published.
      wsKey.socialStats(s), wsKey.socialPublished(s),
      // The X account's last read, paid on a click (src/lib/x-stats.ts, rule 747): its posts' text is the owner's.
      XSTATS_KEY(s),
      // The store's sales snapshot (orders, revenue, best sellers, abandoned carts) and its failure note (14 days).
      wsKey.storeSales(s), wsKey.storeSyncFail(s),
      // The latest campaign results, from an upload or an ad account (src/lib/perf-store.ts).
      wsKey.perfImport(s),
      // Each ad account's last read time, one per ad platform.
      ...AD_PROVIDERS.map((p) => wsKey.adSync(s, p)),
      // Each ad account's totals and its top ads by name, and the last upload's (src/lib/ad-stats.ts, rule 747).
      ...AD_STATS_SOURCES.map((p) => ADSTATS_KEY(s, p)),
      // The notification choices, per brand (src/lib/notify-prefs.ts `profileKey`): only the default brand's was deleted.
      profileKey(s),
      wsKey.onboardPlan(s), wsKey.pending(s), wsKey.pendingIndex(s), wsKey.taskMonths(s), wsKey.taskIndexVersion(s), wsKey.tasks(s), wsKey.files(s), wsKey.brand(s), wsKey.prefs(s), wsKey.chat(s), wsKey.convs(s), wsKey.gov(s), wsKey.schedule(s), wsKey.brief(s), wsKey.conns(s),
    );
  });
  // Our media copies on disk (rule 1761): every file of every brand, its index entries and the space they held. A disk
  // error stops the wipe (a retry runs it again), so the account is never gone while its pictures and clips remain.
  keys.push(...(await forgetScopeMedia(scopes)));
  // Named one-time email markers, their in-flight claims and their repair flags: the names are only knowable from the
  // index `sendOnce()` keeps (src/lib/notify.ts).
  const onceNames = await db.smembers(ONCE_INDEX(e));
  keys.push(...onceNames.flatMap((k) => [onceKey(e, k), onceClaimKey(e, k), onceRepairKey(e, k)]), ONCE_INDEX(e));

  // The saved Paymob card token (src/lib/billing.ts): it charges the card, so it never outlives the account. The intents,
  // transaction records and done markers stay to their TTL: they hold no card data, and the founder may still refund.
  keys.push(...paymobAccountKeys(e));
  // The account security pack (rule 1954; rules 1930-1956), for the owner and every member login: two-step sign-in (the enrolment
  // and a setup in progress), a waiting address change (src/lib/email-change.ts) and the Google link both ways
  // (src/lib/google-signin.ts). The device lists and the sessions they name go below, with `revokeAllDevices`.
  keys.push(...logins.flatMap((l) => [...mfaKeys(l), accountKey.emailChange(l), accountKey.emailChangeTries(l), accountKey.googleSub(l)]));
  const subs = await db.mget<string>(logins.map((l) => accountKey.googleSub(l)));
  keys.push(...subs.filter((s): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(s)).map((s) => globalKey.googleAccount(s)));
  // A founding seat and a price-lock place (src/lib/founding.ts, rule 1712): the account's email leaves both counted sets.
  await freePlaces(e);

  const token = await db.get<string>(accountKey.mcpTokenOf(e));
  if (token) keys.push(globalKey.mcpToken(token));
  await revokeAllGrants(e); // OAuth tokens issued to connected apps
  // Wishlist: votes are taken back (the counts drop) and suggestions, which carry the email and free text, are removed.
  keys.push(...(await forgetWishlistUser(e)));
  // Partner programme (src/lib/partners.ts): recorded payments and, for a partner, the record with its bank details, the
  // code, the referral set and the ledger. The account also leaves its own partner's referral set.
  keys.push(...(await forgetPartnerData(e, login)));
  keys.push(accountKey.mcpGrants(e));
  keys.push(`profile:${e}`, accountKey.mcpTokenOf(e), accountKey.brands(e), accountKey.activeBrand(login), accountKey.user(e));
  // The legacy owner's person row and account list (multi-workspace M1, rule 2132: `createUser` writes both under the
  // account id, the owner's person id). A `p_` person keeps its row: it may own or belong to other accounts (release M2).
  const self = storedPersonId(e);
  keys.push(personKey.person(self), personKey.orgs(self));
  // Account-level records that are not brand-scoped. Missing these meant a deleted account left its notifications,
  // referral graph, share-bonus markers and activity history behind, so re-registering the same address inherited
  // them. The other `notifseen:` markers are not listed: they live a week at most after their last write (Reem's to-do
  // alert markers are set again by each daily run while their step holds, and no run reaches a deleted account) and
  // their suffix cannot be enumerated (the ones that can, per brand, are deleted above).
  keys.push(
    accountKey.notifications(e),
    accountKey.referrals(e),
    accountKey.referredBy(e),
    `ref:${codeFor(e)}`,
    // Referrer bonuses waiting for a friend's first payment, the friends already claimed, this month's paid count.
    ...referralKeys(e),
    accountKey.shared(e),
    ...["x", "linkedin", "whatsapp", "instagram"].map((p) => accountKey.shared(e, p)), // pre-set markers
    accountKey.lastSeen(e),
    accountKey.weeklyLock(e),
    ...EVENTS.flatMap((ev) => [accountKey.event(e, ev), accountKey.eventFirst(e, ev), accountKey.eventFirst0(e, ev)]),
    // Model-spend counters for the months this account could have been active (the monthly chat messages among them),
    // and the trial's chat messages, which are counted once for the trial and not per month.
    ...usageKeys(e),
    chatTrialKey(e),
    // Lifetime thumbs counters from before the feedback log replaced them. No longer written, but never deleted either.
    ...AGENTS.flatMap((a) => [`fb:${e}:${a.id}:up`, `fb:${e}:${a.id}:down`]),
  );
  // The founder feed of instruction changes holds this account's email: its rows leave with it (a busy lock stops the wipe, a retry runs it again).
  await removeFeedRowsFor(e);
  // The team first, then the account record, both under `lock:team` (`wipeTeam` runs the deletes below as its `finish`):
  // an invite accepted while this runs either finished before `wipeTeam` took the lock (and its member is deleted there)
  // or re-reads the owner after it and finds none. A member's lock that cannot be had stops the wipe BEFORE `user:{owner}`,
  // the owner's login index and `users:all` are touched, so the account still signs in and a retry runs it again (the
  // 409 "try again" of DELETE /api/account and the console's delete is true).
  // Inside `finish`, the owner's `lock:login` is taken first (team → login is in rule 2139's order; the address move holds
  // it already), so a timeout there also stops the wipe with nothing of the owner deleted. Under it `user:{owner}` goes
  // FIRST (an accept that takes an expired `lock:team` while the bulk deletes run then finds no owner), then the owner's
  // login index; the rest of the account's keys follow outside the login lock.
  const record = accountKey.user(e);
  await wipeTeam(e, async () => {
    const owner = async () => {
      await db.del(record);
      await releaseLogin(login, e, { locked: true });
    };
    if (opts.loginLocked) await owner();
    else await withLoginLock(login, owner);
    await pmap(keys.filter((k) => k !== record), (k) => db.del(k));
  }, { teamLocked: opts.teamLocked });
  // The global reminder index names every scope with a reminder: this account's leave it.
  await Promise.all(scopes.map((s) => forgetDueScope(s)));
  // The owner's link once more, now the account is gone: a create that ran between the first revoke and the deletion of
  // `user:{owner}` could have written a new one.
  await Promise.all(logins.map((l) => revokeAllDevices(l)));
  // The owner's login index went in `finish` above (members' in `wipeTeam`); the deletion row names the id and the
  // address (rule 1999).
  await Promise.all([revokeFeed(login), revokeBook(login), db.srem(globalKey.usersAll(), e), db.lpush(globalKey.deletedAccounts(), JSON.stringify({ id: e, email: login, at: new Date().toISOString() }))]);
}
