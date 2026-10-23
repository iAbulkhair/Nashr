/**
 * The Redis key registry (rules 2030-2049, docs/system/flows.md section 83, architecture.md section 3).
 *
 * Every key of the families below is built here and nowhere else. Three groups, by what addresses the record:
 *
 * - `wsKey`: a brand's workspace records (tasks, files, conversations, brand, connections, plans, governance...). Each
 *   builder takes a `Scope`, a branded string that only `sc(u)` (src/lib/auth.ts), `workspaceScope` (the brand list of
 *   an account) and `storedScope` (a scope read back from our own records) can produce. A raw id, email or value from a
 *   request is a plain `string` and does not type-check here, so a route cannot key a workspace record by what the
 *   caller sent (CLAUDE.md "Tenant isolation").
 * - `accountKey`: records of one account or one login. An account's records take its id (`acct(u)`, src/lib/account-id.ts;
 *   in R1 every id is still the account's first address, so the bytes are today's); a login's records (`login`, `member`,
 *   `loginLock`, `activeBrand`, `emailChange`, `googleSub`...) take the normalized sign-in address. Sign-in and admin
 *   paths look these up by an address on purpose, so they take a string; the caller normalizes it.
 * - `globalKey`: records addressed by a token, an id or nothing (sessions, OAuth state, invites, rate buckets, indexes).
 * - `personKey`: records of one person, or of one person in one account (multi-workspace membership, release M1, rules
 *   2110-2139, docs/system/flows.md section 93). Each builder takes a `PersonId` and, for a per-account record, an
 *   `AccountId`: branded strings that only a stored record can produce (`storedPersonId`, `storedAccountId`), so a plain
 *   `string` from a request does not type-check (rule 2137). `accountKey.membership` and `accountKey.teamLog` take the
 *   same brands. Nothing reads or writes these keys until the adapter code of the later M1 tasks.
 *
 * Every builder returns the same bytes as the template it replaced: no stored key changes, nothing to migrate.
 * tests/key-registry.test.ts pins each family against its old template; tests/key-registry-ratchet.test.ts counts the
 * raw key templates still written outside this file, and that count may only go down.
 */

declare const scopeBrand: unique symbol;
/** A workspace scope: the account email for the default brand, `email#brandId` for an added one. */
export type Scope = string & { readonly [scopeBrand]: true };

declare const personBrand: unique symbol;
declare const accountBrand: unique symbol;
/** A person's id: a legacy owner's account id, a legacy member's frozen id (its address while `OPAQUE_IDS` is off) or `p_...`. */
export type PersonId = string & { readonly [personBrand]: true };
/** An account's id (`acct(u)`): the key a record is stored under, never a value from a request. */
export type AccountId = string & { readonly [accountBrand]: true };

/** The scope of brand `brandId` of the account `email` (the default brand's scope is the email itself). */
export function workspaceScope(email: string, brandId: string): Scope {
  return (brandId === "default" ? email : `${email}#${brandId}`) as Scope;
}

/**
 * A scope read back from a record this app wrote: a cron sweeping an index of scopes, a held charge's scope, a media
 * job's stored owner, the account wipe listing its own brands. Never call it on a value from a request (body, query,
 * header, path, cookie): those name a workspace only through `sc(u)`. Every call site is listed by the ratchet test.
 */
export function storedScope(scope: string): Scope {
  return scope as Scope;
}

/**
 * A person id read back from a record this app wrote: the login index, a session record, the roster (`members:{aid}`),
 * a membership row, a `User` loaded from a pointer. Never call it on a value from a request (body, query, header, path,
 * cookie): a request reaches a person only through the session. Every call site is listed by the ratchet test, and none
 * is allowed under src/app.
 */
export function storedPersonId(s: string): PersonId {
  return s as PersonId;
}

/**
 * An account id read back from a record this app wrote: a membership row, an `orgs:{pid}` entry (a hint, re-checked on
 * the forward records), `users:all`, a `User` loaded from a pointer. Never call it on a value from a request. Every call
 * site is listed by the ratchet test, and none is allowed under src/app.
 */
export function storedAccountId(s: string): AccountId {
  return s as AccountId;
}

/**
 * A db-level helper's scope parameter, still typed `string` (rule 2033, phase 1). The helpers in src/lib (`getTask`,
 * `saveConnection`, `readFile`...) are called from tests and from modules another session is splitting, so their
 * parameters are narrowed to `Scope` in a later pass; until then each one names its keys through this, and the ratchet
 * test counts the calls (a count that only goes down). Routes and pages never call it: they hold `sc(u)`.
 */
export function scopeParam(scope: string): Scope {
  return scope as Scope;
}

export const wsKey = {
  /** json `Brand`: the brand profile. */
  brand: (s: Scope) => `brand:${s}`,
  /** list: the owner's remembered preferences (capped, `CAPS.prefs`). */
  prefs: (s: Scope) => `prefs:${s}`,
  /** list: task ids, newest first. */
  tasks: (s: Scope) => `tasks:${s}`,
  /** json `Task`. */
  task: (s: Scope, id: string) => `task:${s}:${id}`,
  /** lock: one task's writers. */
  taskLock: (s: Scope, id: string) => `tasklock:${s}:${id}`,
  /** lock: writers of the workspace's preferences.md, one learned note at a time (src/lib/task-notes.ts). */
  prefsFileLock: (s: Scope) => `prefsfile:${s}`,
  /** set: ids of tasks waiting for approval. */
  pending: (s: Scope) => `pending:${s}`,
  /** set: ids of pending tasks set aside under "Not now" (a subset of `pending`, rule 2341). */
  notNow: (s: Scope) => `notnow:${s}`,
  /** string: when the pending set was last rebuilt. */
  pendingIndex: (s: Scope) => `pendingidx:${s}`,
  /** hash: the light task index of one month (`YYYY-MM`). */
  taskMonth: (s: Scope, month: string) => `tidx:${s}:${month}`,
  /** set: months that have a light task index. */
  taskMonths: (s: Scope) => `tidxm:${s}`,
  /** string: when the light task index was last rebuilt. */
  taskIndexVersion: (s: Scope) => `tidxv:${s}`,
  /** hash: ad code to task id. */
  adCodes: (s: Scope) => `adcodes:${s}`,
  /** set: file names. */
  files: (s: Scope) => `files:${s}`,
  /** json: one workspace file. */
  file: (s: Scope, name: string) => `file:${s}:${name}`,
  /** lock: one workspace file's checked save (`writeFileChecked`, rule 2441), 10 s. */
  fileLock: (s: Scope, name: string) => `filelock:${s}:${name}`,
  /** json: the onboarding plan (`{ goal?, ... }`). */
  onboardPlan: (s: Scope) => `onboardplan:${s}`,
  /** json: the owner's confirmed site. */
  onboardOk: (s: Scope) => `onboardok:${s}`,
  /** lock: the onboarding run. */
  onboardLock: (s: Scope) => `onboardlock:${s}`,
  /** json: the onboarding game's answers. */
  onboardGame: (s: Scope) => `onboardgame:${s}`,
  /** list: conversation ids, newest first. */
  convs: (s: Scope) => `convs:${s}`,
  /** json `Conversation`. */
  conv: (s: Scope, id: string) => `conv:${s}:${id}`,
  /** lock: one conversation's writers. */
  convLock: (s: Scope, id: string) => `convlock:${s}:${id}`,
  /** list: a chat thread. Without an id, the legacy default thread (no conversation record). */
  chat: (s: Scope, convId?: string) => (convId === undefined ? `chat:${s}` : `chat:${s}:${convId}`),
  /** set: connected provider ids. */
  conns: (s: Scope) => `conns:${s}`,
  /** json: one connection, credentials encrypted. */
  conn: (s: Scope, provider: string) => `conn:${s}:${provider}`,
  /** json `Governance`. */
  gov: (s: Scope) => `gov:${s}`,
  /** list: governance history. */
  govHistory: (s: Scope) => `govhist:${s}`,
  /** lock: governance save. */
  govLock: (s: Scope) => `govlock:${s}`,
  /** json: the weekly schedule. */
  schedule: (s: Scope) => `schedule:${s}`,
  /** json `Brief`: the latest weekly brief. */
  brief: (s: Scope) => `brief:${s}`,
  /** list: the owner's decision records. */
  decisions: (s: Scope) => `decisions:${s}`,
  /** list: the chat feedback log. */
  feedbackLog: (s: Scope) => `fblog:${s}`,
  /** json: the site's GA4 and Search Console totals. */
  siteStats: (s: Scope) => `sitestats:${s}`,
  /** json: Instagram and LinkedIn page results. */
  socialStats: (s: Scope) => `socialstats:${s}`,
  /** json: ids Thakeen published on Instagram. */
  socialPublished: (s: Scope) => `socialpub:${s}`,
  /** json: the store's sales snapshot. */
  storeSales: (s: Scope) => `storesales:${s}`,
  /** json: the store sync's failure note. */
  storeSyncFail: (s: Scope) => `storesyncfail:${s}`,
  /** json: the latest campaign results. */
  perfImport: (s: Scope) => `perfimport:${s}`,
  /** string: one ad account's last read time. */
  adSync: (s: Scope, provider: string) => `adsync:${s}:${provider}`,
  /** json `FileProposal`: a core-file rewrite waiting for the owner's Apply (src/lib/file-proposals.ts, rule 2306). */
  fileProposal: (s: Scope, id: string) => `fileprop:${s}:${id}`,
  /** string: how a file proposal was decided (`applied`, `dismissed`, `stale`). */
  fileProposalDone: (s: Scope, id: string) => `fileprop-done:${s}:${id}`,
  /** lock: one file proposal's answer (60 s). */
  fileProposalClaim: (s: Scope, id: string) => `fileprop-claim:${s}:${id}`,
  /** set: the scope's file proposal ids, for `wipeAccount`. */
  fileProposals: (s: Scope) => `fileprops:${s}`,
  /** bucket name for `allow` (stored as `rate:keycheck:{window}:{scope}`): failed key checks of one workspace (rule 2240). */
  keyCheckBucket: (s: Scope, window: "hour" | "day") => `keycheck:${window}:${s}`,
  /** bucket name for `allow` (stored as `rate:connectstart:{scope}`): OAuth and Composio connect starts of one workspace (rule 2242). */
  connectStartBucket: (s: Scope) => `connectstart:${s}`,
  /** bucket name for `allow` (stored as `rate:storesync:{scope}`): manual store sales syncs of one workspace (rule 2243). */
  storeSyncBucket: (s: Scope) => `storesync:${s}`,
  /** bucket name for `allow` (stored as `rate:catalogimport:{scope}`): product imports from a store of one workspace (rule 2243). */
  catalogImportBucket: (s: Scope) => `catalogimport:${s}`,
  /**
   * hash: this workspace's phone push subscriptions (rules 2560-2563), field = the first 32 hex of the SHA-256 of the
   * endpoint, value `{ endpoint, login, at }`. Written only by POST /api/push under the session's own `sc(u)`.
   */
  pushSubs: (s: Scope) => `pushsubs:${s}`,
  /** marker: a push about this agent and state went out in the last 30 minutes (SET NX, rule 2566). */
  pushSent: (s: Scope, agent: string, state: string) => `pushsent:${s}:${agent}:${state}`,
  /** The claim of one workspace's daily email on one UTC day (rule 3023); expires on its own, so the wipe needs no entry. */
  dailyMail: (scope: string, day: string) => `dailymail:${scope}:${day}`,
} as const;

export const personKey = {
  /** json `Person` (`PersonRow`): credentials and profile. Written and read from multi-workspace M1 (2026-10-19). */
  person: (p: PersonId) => `person:${p}`,
  /** lock: one person's writes (after `lock:login`, before `lock:member`, rule 2139). */
  lock: (p: PersonId) => `lock:person:${p}`,
  /** set of `AccountId`: the accounts the person owns or belongs to. A hint for listing only (rule 2136). */
  orgs: (p: PersonId) => `orgs:${p}`,
  /** string `AccountId`: the last workspace chosen in the switcher (M2). */
  lastOrg: (p: PersonId) => `lastorg:${p}`,
  /** bucket name for `allow` (stored as `rate:xfer:offer:{pid}`): ownership offers the person sent as owner, 5 a day (M3, rule 2750). */
  xferOfferBucket: (p: PersonId) => `xfer:offer:${p}`,
  /** bucket name for `allow` (stored as `rate:xfer:accept:{pid}`): ownership accept attempts of the person, 10 an hour (M3, rule 2751). */
  xferAcceptBucket: (p: PersonId) => `xfer:accept:${p}`,
  /** bucket name for `allow` (stored as `rate:persondel:{pid}`): attempts to delete one's own login, 5 an hour (M3, rule 2754). */
  deleteBucket: (p: PersonId) => `persondel:${p}`,
  /** string: the brand id the person last chose in one account. */
  activeBrand: (p: PersonId, a: AccountId) => `activebrand:${p}:${a}`,
  /** string: the hash of the person's current calendar feed link in one account. */
  feedOf: (p: PersonId, a: AccountId) => `sec:feedof:${p}:${a}`,
  /** string: the hash of the person's current booking link for one provider in one account. */
  bookOf: (p: PersonId, a: AccountId, prov: string) => `sec:bookof:${p}:${a}:${prov}`,
  /**
   * lock: one person's feed link in one account (src/lib/feed-token.ts). A LEAF lock (rule 2139): it may be taken while
   * any other lock is held, and nothing else is taken while it is held except the legacy per-login `lock:feed:{login}`
   * of the same home link, always after it.
   */
  feedLock: (p: PersonId, a: AccountId) => `lock:feed:${p}:${a}`,
  /** lock: one person's booking link for one provider in one account (src/lib/booking-token.ts). A leaf lock, as `feedLock`. */
  bookLock: (p: PersonId, a: AccountId, prov: string) => `lock:book:${p}:${a}:${prov}`,
  /** json `PasskeySet` (src/lib/stored.ts): the person's passkeys, written under `lock`; no TTL (customer passkeys, rules 2400-2402). */
  passkeys: (p: PersonId) => `passkeys:${p}`,
  /** json `{ challenge, sess, at }`: the person's one open passkey registration, taken with `getdel`; 300 s (rule 2407). */
  passkeyReg: (p: PersonId) => `pkreg:${p}`,
  /**
   * json `{ move, at }`: the person's last revert (account-id R2, rule 2744): `move` is when the reverted move happened,
   * `at` when it was undone. A revert link of a move made between the two is dead. 30 days.
   */
  emailReverted: (p: PersonId) => `emailreverted:${p}`,
} as const;

export const accountKey = {
  /** json `Membership` (`MembershipRow`): one person's role, dates and pause in one account. Never an owner. */
  membership: (a: AccountId, p: PersonId) => `mbr:${a}:${p}`,
  /** capped list (`CAPS.teamLog`): the account's membership events, newest first (`TeamLogRow`). */
  teamLog: (a: AccountId) => `teamlog:${a}`,
  /** json `TransferOffer` (src/lib/transfer.ts): the account's one pending ownership transfer, 7 days (multi-workspace M3, rule 2128). */
  xfer: (a: AccountId) => `xfer:${a}`,
  /** json `User`: the account, under its id (`acct(u)`). */
  user: (id: string) => `user:${id}`,
  /** json `BrandMeta[]`: the account's brands. */
  brands: (email: string) => `brands:${email}`,
  /** lock: the brand list's read-modify-write. */
  brandsLock: (email: string) => `brandslock:${email}`,
  /** string: the active brand id of one LOGIN (owner or member). */
  activeBrand: (login: string) => `activebrand:${login}`,
  /** string: the account's MCP token. */
  mcpTokenOf: (email: string) => `mcptoken-of:${email}`,
  /** hash: OAuth grants issued to connected apps. */
  mcpGrants: (email: string) => `mcpgrants:${email}`,
  /** list: in-app notifications. */
  notifications: (email: string) => `notifs:${email}`,
  /** json `StoredDigest` (src/lib/notif-digest.ts): how often the account's digest email goes, and to whom (rule 2353). */
  digest: (id: string) => `notifydigest:${id}`,
  /** string: when the account's digest window last closed, ISO (rule 2354). */
  digestLast: (id: string) => `digestlast:${id}`,
  /** marker: one digest send in progress or just made, 10 minutes (rule 2354). */
  digestLock: (id: string) => `digestlock:${id}`,
  /** bucket name for `allow` (stored as `rate:digestsave:{login}`): saves of the digest choice (rule 2355). */
  digestBucket: (login: string) => `digestsave:${login}`,
  /** bucket name for `allow` (stored as `rate:revise:{login}`): line notes revisions sent by the account (rule 2497). */
  reviseBucket: (login: string) => `revise:${login}`,
  /** set: friends this account referred. */
  referrals: (email: string) => `referrals:${email}`,
  /** string: who referred this account. */
  referredBy: (email: string) => `referredBy:${email}`,
  /** marker: a share bonus, per platform when given. */
  shared: (email: string, platform?: string) => (platform === undefined ? `shared:${email}` : `shared:${email}:${platform}`),
  /** string: last activity time. */
  lastSeen: (email: string) => `ulast:${email}`,
  /** lock: the weekly mail. */
  weeklyLock: (email: string) => `weeklylock:${email}`,
  /** counter: one tracked event. */
  event: (email: string, ev: string) => `uev:${email}:${ev}`,
  /** string: first time of one tracked event. */
  eventFirst: (email: string, ev: string) => `ufirst:${email}:${ev}`,
  /** string: first time of one tracked event, before the reset (`ufirst0`). */
  eventFirst0: (email: string, ev: string) => `ufirst0:${email}:${ev}`,
  /** counter: lifetime thumbs per agent (no longer written). */
  thumbs: (email: string, agent: string, dir: "up" | "down") => `fb:${email}:${agent}:${dir}`,
  /** json: a waiting sign-in address change. */
  emailChange: (login: string) => `emailchange:${login}`,
  /** counter: wrong codes for an address change. */
  emailChangeTries: (login: string) => `emailchange:tries:${login}`,
  /** string: the Google account id linked to a login. */
  googleSub: (login: string) => `googlesub:${login}`,
  /** json: a member login's record. */
  member: (login: string) => `member:${login}`,
  /** set: the owner's member logins. */
  members: (owner: string) => `members:${owner}`,
  /** set: the owner's open invite ids. */
  invites: (owner: string) => `invites:${owner}`,
  /** lock: the owner's team. */
  teamLock: (owner: string) => `lock:team:${owner}`,
  /**
   * json `LoginIndexValue` (src/lib/account-id.ts): the person a sign-in address belongs to (account-id spec R1, rules
   * 1981-1983). Written only under `loginLock`; the address is normalized by the caller.
   */
  login: (login: string) => `login:${login}`,
  /**
   * set: the ids of the open invites to this sign-in address, 7 days (multi-workspace M3, spec section 9). Written with the
   * invite, read only for the signed-in person's own verified address; the address is normalized by the caller.
   */
  invitesFor: (login: string) => `invitesfor:${login}`,
  /** lock: one login. */
  loginLock: (login: string) => `lock:login:${login}`,
  /** lock: one member record. */
  memberLock: (login: string) => `lock:member:${login}`,
  /** hash: model spend of one account in one month (`YYYY-MM`). */
  usage: (email: string, month: string) => `usage:${email}:${month}`,
  /** counter: the trial's chat messages. */
  chatTrial: (email: string) => `chatm:${email}:trial`,
  /** bucket name for `allow` (stored as `rate:pkpw:{login}`): passkey add and remove proofs of one login, 10 per hour (rule 2410). */
  passkeyProofBucket: (login: string) => `pkpw:${login}`,
  /**
   * bucket name for `allow` (stored as `rate:mfapw:{login}`): wrong passwords of one login before a two-step or fresh
   * proof step, 10 per hour (rule 1170; the two-step settings route builds the same name in place, M3 `freshProof` here).
   */
  mfaPasswordBucket: (login: string) => `mfapw:${login}`,
  /** bucket name for `allow` (stored as `rate:pwchange:{login}`): wrong current passwords on PATCH /api/account, 10 per hour (rule 2991). */
  passwordChangeBucket: (login: string) => `pwchange:${login}`,
  /** bucket name for `allow` (stored as `rate:acctdelete:{login}`): wrong passwords on DELETE /api/account, 10 per hour (rule 2991). */
  accountDeleteBucket: (login: string) => `acctdelete:${login}`,
  /** marker: a tab of this login was visible in the last `AWAY_MINUTES` (rule 2564); its TTL is the whole record. */
  tabSeen: (login: string) => `tabseen:${login}`,
  /** json `{ agent, state, at }`: the last push this login's devices were sent, read by the worker (rule 2567), 1 day. */
  pushLast: (login: string) => `pushlast:${login}`,
  /** bucket name for `allow` (stored as `rate:push:{login}`): push subscribe, unsubscribe and the worker's read (rule 2562). */
  pushBucket: (login: string) => `push:${login}`,
  /** bucket name for `allow` (stored as `rate:tabbeat:{login}`): the visible-tab heartbeat (rule 2564). */
  seenBucket: (login: string) => `tabbeat:${login}`,
  /**
   * json `EmailHold` (src/lib/email-hold.ts): an address a person moved away from in place, refused to anyone else while
   * that person exists; 30 days (account-id R2, D1, rule 2743). Read and written only while `OPAQUE_IDS` is on.
   */
  emailHold: (login: string) => `emailhold:${login}`,
} as const;

export const globalKey = {
  /** set: account ids whose digest email is on, read by Reem's tick (rule 2354). */
  digests: () => "notifydigests",
  /** set: every account id (`acct(u)`: in R1 the owner's first address). */
  usersAll: () => "users:all",
  /**
   * json `RunReceipt`: one paid scheduled run's receipt (src/lib/run-receipt.ts, rules 2476-2479), keyed by its claim
   * (`weekly:{scope}:{week}`, `routine:{scope}:{id}:{period}`), which code builds from the caller's own scope.
   */
  runReceipt: (claim: string) => `runrec:${claim}`,
  /** json: the last report of a per-user cron batch, counts only (src/lib/cron-batch.ts, rule 2484). */
  cronReport: (job: string) => `cronreport:${job}`,
  /** list: deletion receipts. */
  deletedAccounts: () => "deleted-accounts",
  /** json: a session, under the SHA-256 of its token. */
  session: (tokenHash: string) => `session:h:${tokenHash}`,
  /** json: a session written before rule 1345, under its raw token (read and deleted only). */
  sessionLegacy: (token: string) => `session:${token}`,
  /** string: the account an MCP token belongs to. */
  mcpToken: (token: string) => `mcptoken:${token}`,
  /** json: a connector's OAuth state (10 minutes). */
  oauthState: (state: string) => `oauthstate:${state}`,
  /** string: the login a Google account id signs in. */
  googleAccount: (sub: string) => `google:${sub}`,
  /** json: a team invite. */
  invite: (id: string) => `invite:${id}`,
  /** marker: an invite taken. */
  inviteUse: (id: string) => `inviteuse:${id}`,
  /** counter: one rate-limit bucket (`allow`, src/lib/rate.ts). */
  rate: (bucket: string) => `rate:${bucket}`,
  /** hash: model spend of everyone in one month. */
  usageAll: (month: string) => `usage:_all:${month}`,
  /** string: the payment id whose Paymob refund ended the plan, or `none` when it found no plan to end (`endPlanOnRefund`, src/lib/billing.ts). */
  paymobRefundEnded: (txnId: number) => `paymob:refund_ended:${txnId}`,
  /** list: Shopify compliance webhook receipts, topic + store + time only (rule 2169). */
  shopifyCompliance: () => "shopify:compliance",
  /** hash: store domain → time of a pending `shop/redact`, applied by the stores cron (rules 2170-2171). */
  shopifyRedact: () => "shopify:redact",
  /** json: per-platform connection counts across every workspace, written by the stores cron (rules 2177-2178). */
  connectionHealth: () => "connections:health",
  /**
   * string pid: the passkey reverse index, under the SHA-256 hex of a credential id; no TTL. A hint only, forward-checked
   * against the person's set and login before it grants anything (rules 2404, 2405).
   */
  passkeyCred: (credHash: string) => `pkcred:${credHash}`,
  /** json `{ challenge, at }`: a passkey sign-in challenge under the SHA-256 hex of the `thakeen_pk` nonce, taken with `getdel`; 300 s (rule 2408). */
  passkeyAuth: (nonceHash: string) => `pkauth:${nonceHash}`,
  /** string: the passkey off switch, `"1"` = off, absent = on; no TTL; written only by the console owner (rule 2426). */
  passkeysOff: () => "passkeys:off",
  /** bucket name for `allow` (stored as `rate:pk:ip:{ip}`): passkey sign-in options per IP, 60 per 15 min (rule 2417). */
  passkeyIpBucket: (ip: string) => `pk:ip:${ip}`,
  /** bucket name for `allow` (stored as `rate:pkv:ip:{ip}`): passkey sign-in verifies per IP, 20 per 15 min (rule 2418). */
  passkeyVerifyIpBucket: (ip: string) => `pkv:ip:${ip}`,
  /** bucket name for `allow` (stored as `rate:pkv:cred:{hash}`): passkey sign-in verifies per credential hash, 10 per 15 min (rule 2418). */
  passkeyCredBucket: (credHash: string) => `pkv:cred:${credHash}`,
  /**
   * json `{ challenge, at }`: the founder's passkey step-up before creating the first staff login, under the SHA-256 hex
   * of the customer session; taken with `getdel`; 300 s (rule 3700).
   */
  staffBootPasskey: (sessionHash: string) => `staffbootpk:${sessionHash}`,
  /** bucket name for `allow` (stored as `rate:staffinvite:{sha256(email)}`): staff invites of one owner, 10 per hour (rule 3707). */
  staffInviteBucket: (ownerHash: string) => `staffinvite:${ownerHash}`,
  /** bucket name for `allow` (stored as `rate:staffinvite:ip:{ip}`): staff invites per IP, 20 per hour (rule 3707). */
  staffInviteIpBucket: (ip: string) => `staffinvite:ip:${ip}`,
  /** counter: how many times `event` was tracked on UTC day `day` (src/lib/track.ts `track`); read by the ops summary (rule 2380). */
  eventDay: (day: string, event: string) => `ev:${day}:${event}`,
  /** json `OpsProposal`: one action the ops agent proposed, waiting for the founder's press on Telegram (rules 2386-2389). */
  opsProposal: (id: string) => `ops:proposal:${id}`,
  /** marker: an ops alert with this key was sent in the last 12 hours (rule 2384). */
  opsAlert: (key: string) => `ops:alert:${key}`,
  /**
   * json `EmailRevert` (src/lib/email-hold.ts): a single-use link that moves a person back to the address it left, under
   * the SHA-256 hex of the token mailed to that address, taken with `getdel`; 7 days (account-id R2, D1, rule 2744).
   */
  emailRevert: (tokenHash: string) => `emailrevert:${tokenHash}`,
  /** bucket name for `allow` (stored as `rate:emailrevert:ip:{ip}`): revert link uses per IP (rule 2744). */
  emailRevertIpBucket: (ip: string) => `emailrevert:ip:${ip}`,
  /** json `{ email, kind }`: a password reset link, under the SHA-256 hex of its token; 1 hour (POST /api/auth/forgot). */
  passwordReset: (tokenHash: string) => `pwreset:${tokenHash}`,
} as const;

/**
 * The claims a paid scheduled run is charged under (`chargeOnce`, src/lib/credits.ts; rules 2470-2471) and the notice
 * fingerprints built from them (rules 2475, 2478). Not keys on their own: each becomes part of a key (`User.paidOnce`,
 * `runrec:`, `notifseen:`), so they are built here with the keys. The scope is the caller's own, never a request's.
 */
export const runClaim = {
  /** One routine's run in one period. */
  routine: (scope: string, id: string, period: string) => `routine:${scope}:${id}:${period}`,
  /** One item of one of Majed's handoffs. */
  handoff: (scope: string, id: string, n: number) => `handoff:${scope}:${id}:${n}`,
  /** The owner's one notice for a run held for them. */
  heldNotice: (claim: string) => `held:${claim}`,
  /** The owner's one notice for a day's sweep refunds. */
  sweepNotice: (day: string) => `holdsweep:${day}`,
};

/**
 * The records an address may still name after an account moved in place (account-id R2, L3, rule 2740): the account and
 * the person stored under the address as their id. Read only, by `addressBlocked` (src/lib/email-hold.ts).
 */
export const addressRecordKeys = (address: string): [string, string] => [accountKey.user(address), personKey.person(address as PersonId)];
