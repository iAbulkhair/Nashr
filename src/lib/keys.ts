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
 *   2110-2139, docs/system/flows.md section 91). Each builder takes a `PersonId` and, for a per-account record, an
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
  /** set: ids of tasks waiting for approval. */
  pending: (s: Scope) => `pending:${s}`,
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
} as const;

export const accountKey = {
  /** json `Membership` (`MembershipRow`): one person's role, dates and pause in one account. Never an owner. */
  membership: (a: AccountId, p: PersonId) => `mbr:${a}:${p}`,
  /** capped list (`CAPS.teamLog`): the account's membership events, newest first (`TeamLogRow`). */
  teamLog: (a: AccountId) => `teamlog:${a}`,
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
} as const;

export const globalKey = {
  /** set: every account id (`acct(u)`: in R1 the owner's first address). */
  usersAll: () => "users:all",
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
} as const;
