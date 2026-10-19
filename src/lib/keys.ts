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
 * - `accountKey`: records of one account or one login, keyed by the normalized email (the account record, its brand
 *   list, the active brand of a login, the team, usage counters). Sign-in and admin paths look these up by an address
 *   on purpose, so they take a string; the caller normalizes it.
 * - `globalKey`: records addressed by a token, an id or nothing (sessions, OAuth state, invites, rate buckets, indexes).
 *
 * Every builder returns the same bytes as the template it replaced: no stored key changes, nothing to migrate.
 * tests/key-registry.test.ts pins each family against its old template; tests/key-registry-ratchet.test.ts counts the
 * raw key templates still written outside this file, and that count may only go down.
 */

declare const scopeBrand: unique symbol;
/** A workspace scope: the account email for the default brand, `email#brandId` for an added one. */
export type Scope = string & { readonly [scopeBrand]: true };

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
  /** bucket name for `allow` (stored as `rate:keycheck:{window}:{scope}`): failed key checks of one workspace (rule 2240). */
  keyCheckBucket: (s: Scope, window: "hour" | "day") => `keycheck:${window}:${s}`,
  /** bucket name for `allow` (stored as `rate:connectstart:{scope}`): OAuth and Composio connect starts of one workspace (rule 2242). */
  connectStartBucket: (s: Scope) => `connectstart:${s}`,
} as const;

export const accountKey = {
  /** json `User`: the account (owner login). */
  user: (email: string) => `user:${email}`,
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
  /** lock: one login. */
  loginLock: (login: string) => `lock:login:${login}`,
  /** lock: one member record. */
  memberLock: (login: string) => `lock:member:${login}`,
  /** hash: model spend of one account in one month (`YYYY-MM`). */
  usage: (email: string, month: string) => `usage:${email}:${month}`,
  /** counter: the trial's chat messages. */
  chatTrial: (email: string) => `chatm:${email}:trial`,
} as const;

export const globalKey = {
  /** set: every account (owner) email. */
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
  /** list: Shopify compliance webhook receipts, topic + store + time only (rule 2169). */
  shopifyCompliance: () => "shopify:compliance",
  /** hash: store domain → time of a pending `shop/redact`, applied by the stores cron (rules 2170-2171). */
  shopifyRedact: () => "shopify:redact",
  /** json: per-platform connection counts across every workspace, written by the stores cron (rules 2177-2178). */
  connectionHealth: () => "connections:health",
} as const;
