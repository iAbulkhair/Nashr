import { NextResponse } from "next/server";
import { db } from "./db";
import type { User } from "./auth";
import { acct } from "./account-id";
import { onVercel } from "./deploy-env";
import { log } from "./log";
import { globalKey } from "./keys";

/** The two windows the per-account buckets use, in seconds; a refusal that names one ("hour", "day") waits this long. */
export const WINDOW = { hour: 3600, day: 86400 } as const;

/** Fixed-window rate limit. True when the caller is still inside the allowance. */
export async function allow(bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  const key = globalKey.rate(bucket);
  const n = await db.incrby(key, 1);
  // Every hit, not only the first: EXPIRE NX starts the window when the counter has none and never touches the count.
  // Setting the expiry on the first hit alone, with a SET, reset hits that landed in between, and when that one call
  // failed the counter kept no expiry and refused every caller for good (rate:kie:create is every tenant's). A failure
  // here is repaired by the next hit, so it does not fail the request.
  try {
    await db.expireNx(key, windowSeconds);
  } catch (e) {
    log.error("rate expiry failed", e);
    // A store that refused the NX form must not leave every counter without an expiry: the first hit falls back to the
    // old SET, which can only reset hits that landed in the same instant.
    if (n === 1) await db.set(key, 1, windowSeconds).catch(() => {});
  }
  return n <= max;
}

/**
 * Hands one hit back to `bucket` (rule 1183). A route that counts failures only takes the hit with `allow` BEFORE the
 * check it guards (INCR is atomic, so parallel requests cannot all slip under the cap) and gives it back when the check
 * passes. A counter that expired in between would go below zero; it is removed instead.
 */
export async function giveBack(bucket: string): Promise<void> {
  const key = globalKey.rate(bucket);
  const n = await db.incrby(key, -1);
  if (n < 0) await db.del(key);
}

/** The `Retry-After` header for a wait of `seconds`: whole seconds, at least one. */
export const retryAfter = (seconds: number) => ({ "Retry-After": String(Math.max(1, Math.ceil(seconds))) });

/**
 * The answer to a call a bucket refused: 429 with `Retry-After` in whole seconds, the window that bucket was given
 * (`allow`'s third argument; with several buckets, the one that refused, the longest when more than one did). A window
 * starts at its first hit, so its counter is gone by then: the longest a caller can have to wait, never a guess. The
 * body is the route's own, unchanged; a string or null is sent as it is (the onboarding stream answers text, the
 * calendar feed nothing). `headers` adds the route's own, such as CORS. Rule 680, tests/retry-after.test.ts.
 */
export function retryLater(body: Record<string, unknown> | string | null, windowSeconds: number, headers: Record<string, string> = {}): NextResponse {
  const init = { status: 429, headers: { ...headers, ...retryAfter(windowSeconds) } };
  return body !== null && typeof body === "object" ? NextResponse.json(body, init) : new NextResponse(body, init);
}

/**
 * Client IP for throttling. Only a header the host's own front proxy sets or overwrites counts: any other the caller
 * writes, and so picks a fresh bucket per request (rule 773).
 *  - On Vercel (`onVercel()`, `VERCEL=1`): Vercel overwrites `x-vercel-forwarded-for` and `x-real-ip` with the client's
 *    address, so they are read first.
 *  - Anywhere else (live Hostinger since 2026-10-07): those two pass through from the client, as
 *    `x-vercel-forwarded-for` did on thakeen.com on 2026-10-08, and are ignored. Only `x-forwarded-for` is read, and
 *    only the hop the nearest trusted proxy appended: counted from the right, `trustedProxyHops()` entries in (rule
 *    979). The default 1 is the LAST hop: the one the proxy nearest the app appended, or the socket address
 *    `next start` fills in when no proxy sent the header. Unverified on Hostinger: if its CDN (hcdn) appends the client
 *    and a second proxy then appends the CDN's edge, the last hop is the edge and callers behind one edge share a
 *    bucket; `TRUSTED_PROXY_HOPS=2` then reads the client. `GET /api/admin/client-ip` (rule 908) shows the founder the
 *    list the app receives, and flows.md section 51 item 7 is the check. A list shorter than the hop count (a request
 *    that skipped the outer proxy) reads its first entry, which a trusted proxy wrote.
 * No address at all: the one shared "unknown" bucket, so a missing header throttles everyone rather than no one.
 */
export const clientIp = (req: Request) =>
  (onVercel() ? (req.headers.get("x-vercel-forwarded-for") ?? req.headers.get("x-real-ip") ?? "").split(",")[0].trim() : "") ||
  trustedHop(forwardedFor(req), trustedProxyHops()) || "unknown";

/** Most proxies `TRUSTED_PROXY_HOPS` may name. More is a typo, and reading far to the left reads what a client wrote. */
export const MAX_PROXY_HOPS = 3;

/**
 * How many proxies in front of the app append to `x-forwarded-for` (rule 979): `TRUSTED_PROXY_HOPS`, a whole number
 * from 1 to `MAX_PROXY_HOPS`, read at call time. Unset or anything else is 1, today's behaviour, so a typo never moves
 * the bucket further left, towards the entries a client writes.
 */
export function trustedProxyHops(): number {
  const raw = (process.env.TRUSTED_PROXY_HOPS ?? "").trim();
  return /^[1-9]$/.test(raw) && Number(raw) <= MAX_PROXY_HOPS ? Number(raw) : 1;
}

/** The `x-forwarded-for` entries in order, each trimmed (empty entries kept, so a trailing comma stays an empty hop). */
const forwardedFor = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim());

/** The entry `hops` from the right; a shorter list gives its first entry. */
const trustedHop = (list: string[], hops: number) => list[Math.max(0, list.length - hops)];

/**
 * What the app receives as the caller's address, for the founder only (`GET /api/admin/client-ip`, rule 908): the
 * `x-forwarded-for` list in order, the single-value headers some proxies set, the hop count in force and the bucket
 * `clientIp` picks. Read here so this file stays the only one naming an address header (rule 773). Values are the
 * caller's own request, nothing stored.
 */
export function clientIpReport(req: Request) {
  const one = (name: string) => req.headers.get(name);
  return {
    forwardedFor: req.headers.get("x-forwarded-for") === null ? [] : forwardedFor(req),
    realIp: one("x-real-ip"),
    vercelForwardedFor: one("x-vercel-forwarded-for"),
    cfConnectingIp: one("cf-connecting-ip"),
    trueClientIp: one("true-client-ip"),
    onVercel: onVercel(),
    trustedProxyHops: trustedProxyHops(),
    bucket: clientIp(req),
  };
}

/**
 * Chat turns per account, in a short window (the owner's email: members, brands and connected apps share the account's
 * buckets). A turn is the most expensive call in the product (up to five model calls with the full workspace in the
 * prompt), so a burst from one account is bounded here, before the month's message allowance is touched
 * (src/lib/chat-allowance.ts). The monthly allowance stays the real ceiling of a month; these only pace it.
 * Founder decision 2026-10-01: lowered until the Sonnet chat eval passes, from 40 an hour and 200 a day on every plan to
 * 30 and 150 on a paid plan (Agency included) and 10 an hour on a trial. A trial's day is 30, the same as its whole-trial
 * allowance (CHAT_ALLOWANCE.trial, counted once), so it never binds before the allowance does; an ended trial gets no
 * turn at all (`trialOver`, checked by both chat routes before this). Rule 331.
 */
export type ChatCaps = Readonly<{ hour: number; day: number }>;
export const CHAT_CAPS: Readonly<{ paid: ChatCaps; trial: ChatCaps }> = {
  paid: { hour: 30, day: 150 },
  trial: { hour: 10, day: 30 },
};
/** The account's hourly and daily chat ceilings, by plan: a trial, or any paid plan (the predicate chat-allowance.ts uses). */
export const chatCaps = (u: Pick<User, "plan">): ChatCaps => (u.plan === "trial" ? CHAT_CAPS.trial : CHAT_CAPS.paid);
/**
 * Null when the turn may go ahead, else which window refused it, so the owner is told "in an hour" or "tomorrow". The
 * hour is counted first and the day only for a turn the hour let through: counting both on every attempt let refused
 * retries inside the hour use up the day, so an owner told "in an hour" met "tomorrow" next (rule 331). A refusal by the
 * hour reads the day's count without adding to it, and names the day when that is spent too, being the longer wait. Two
 * round trips one after the other only for a turn the hour allows. The ceilings are the account's own (`chatCaps`).
 */
export async function chatRefusal(u: Pick<User, "email" | "plan">): Promise<"hour" | "day" | null> {
  const caps = chatCaps(u);
  if (!(await allow(`chat:h:${u.email}`, caps.hour, WINDOW.hour))) {
    const used = Number((await db.get<number | string>(`rate:chat:d:${u.email}`)) ?? 0);
    return used >= caps.day ? "day" : "hour";
  }
  return (await allow(`chat:d:${u.email}`, caps.day, WINDOW.day)) ? null : "day";
}

/**
 * Drafts saved into the inbox by the owner's own assistant (MCP `save_draft`). Free in credits and without a model
 * call, so nothing else bounds it: without this a looping client could fill the approvals inbox. Per account, across
 * its brands. Well above what an owner reviews in an hour.
 */
export const DRAFTS_PER_HOUR = 30;
export const DRAFTS_PER_DAY = 150;
export async function draftAllowed(email: string): Promise<boolean> {
  const [hour, day] = await Promise.all([allow(`draft:h:${email}`, DRAFTS_PER_HOUR, 3600), allow(`draft:d:${email}`, DRAFTS_PER_DAY, 86400)]);
  return hour && day;
}

/**
 * Brands added per account (POST /api/brands add). Active brands are capped per plan (src/lib/pricing.ts `brandCapFor`,
 * rules 1390-1391), but archiving and adding again would get round a count alone, and every active brand fans out into
 * each cron (the daily brief, the routines, and the Sunday plan once the owner switches it on). So adds are also bounded
 * by these buckets, a rate checked before the cap. Well above a real agency's onboarding pace, and the onboarding itself
 * stays at three a day per account (src/app/api/onboard/route.ts). Rule 245, tests/brand-guardrails.test.ts.
 */
/** Failed key checks (POST /api/connect/{provider}/key) one workspace may make, every key provider together (rule 2240). */
export const KEY_CHECK_FAILS_PER_HOUR = 10;
export const KEY_CHECK_FAILS_PER_DAY = 30;
/** OAuth and Composio connect starts (GET /api/connect/{provider}/start) one workspace may make an hour (rule 2242). */
export const CONNECT_STARTS_PER_HOUR = 20;
/** Manual store sales syncs and product imports one workspace may ask for in an hour, the team together (rule 2243). */
export const STORE_SYNCS_PER_HOUR = 6;
export const CATALOG_IMPORTS_PER_HOUR = 6;
export const BRANDS_PER_HOUR = 10;
export const BRANDS_PER_DAY = 30;
/**
 * Null when the add may go ahead, else which window refused it, so the owner is told "in an hour" or "tomorrow" rather
 * than "shortly" (a full day window can last up to 24 hours). The hour is checked first and the day only when the hour
 * allowed it: an add refused by the hour does not use one of the day's 30. One refused by the day uses an hourly slot,
 * which only matters within the hour and never outlasts the day's refusal.
 */
export async function brandAddRefusal(email: string): Promise<"hour" | "day" | null> {
  if (!(await allow(`brandadd:h:${email}`, BRANDS_PER_HOUR, WINDOW.hour))) return "hour";
  if (!(await allow(`brandadd:d:${email}`, BRANDS_PER_DAY, WINDOW.day))) return "day";
  return null;
}

/** Workspaces one person may create per day (`wscreate`, multi-workspace M2, docs/specs/2026-10-18-multi-org.md section 10). */
/** Workspace renames by the owner, per account and hour (PUT /api/account/workspace, rule 3117). */
export const WORKSPACE_RENAMES_PER_HOUR = 10;
export const WS_CREATES_PER_DAY = 3;
/** True while the person may create another workspace today. `pid` is the session's person, never the request's. */
export const workspaceCreateAllowed = (pid: string): Promise<boolean> => allow(`wscreate:${pid}`, WS_CREATES_PER_DAY, WINDOW.day);

/**
 * Enforced agent-scope refusals per brand scope (rule 795; spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md
 * section 4.2). A message the input gate refuses makes no main model call and is given back to the chat allowance, so it
 * is free for the owner; these buckets are what bounds it, and what bounds the classifier calls a looping client could
 * cause. The scope is `u.scope ?? acct(u)` (what `sc(u)` returns; `sc` is not imported here, that would be a cycle), so
 * each brand has its own ceiling. Only enforced input refusals count (`scopeCheck` in src/lib/agent-scope.ts): shadow never.
 */
export const AGENT_SCOPE_REFUSALS_PER_HOUR = 20;
export const AGENT_SCOPE_REFUSALS_PER_DAY = 60;
const agentScopeOf = (u: Pick<User, "scope" | "email" | "id">) => u.scope ?? acct(u);
const count = (v: unknown) => Number(v ?? 0);
/**
 * Null when the brand scope may still be refused, else which window is spent, so the owner is told "in an hour" or
 * "tomorrow". Reads both counters in one `Promise.all` and never adds to them (`allow` would count every attempt, and only
 * refusals may count). A count at or above its limit refuses. The hour is checked first; when it refuses and the day is
 * spent too, the day is named, being the longer wait (as `chatRefusal`, rule 331). A count that does not read as a
 * number refuses nothing.
 */
export async function agentScopeCeiling(u: Pick<User, "scope" | "email">): Promise<"hour" | "day" | null> {
  const s = agentScopeOf(u);
  const [hour, day] = await Promise.all([db.get<number | string>(`rate:agent-scope:h:${s}`), db.get<number | string>(`rate:agent-scope:d:${s}`)]);
  const daySpent = count(day) >= AGENT_SCOPE_REFUSALS_PER_DAY;
  if (count(hour) >= AGENT_SCOPE_REFUSALS_PER_HOUR) return daySpent ? "day" : "hour";
  return daySpent ? "day" : null;
}
/** Count one enforced refusal in both windows (`allow` prefixes `rate:`, so the keys are the ones `agentScopeCeiling` reads). */
export async function countAgentScopeRefusal(u: Pick<User, "scope" | "email">): Promise<void> {
  const s = agentScopeOf(u);
  await Promise.all([allow(`agent-scope:h:${s}`, AGENT_SCOPE_REFUSALS_PER_HOUR, WINDOW.hour), allow(`agent-scope:d:${s}`, AGENT_SCOPE_REFUSALS_PER_DAY, WINDOW.day)]);
}

/**
 * The classifier calls the input gate on generation notes may cost a brand scope (rule 796; `checkGenerationNotes` in
 * src/lib/agent-scope.ts). The gate sits after the free refusals of `generateBatch`, but a request that cannot be charged
 * (no credits, an agent at its cap) still reaches it, and in shadow nothing else bounds the calls. Each call the classifier would
 * make is counted in both windows (`allow` adds one per attempt, so the count is of asks, whatever the answer) under the same
 * scope key as the refusal ceiling. Over a window: shadow skips the classifier (no log, the batch goes on) and enforce answers
 * `slow_down`, naming the window.
 */
export const AGENT_SCOPE_GEN_CHECKS_PER_HOUR = 60;
export const AGENT_SCOPE_GEN_CHECKS_PER_DAY = 200;
/**
 * Count one classifier ask for this brand scope and say whether it is over: null while both windows allow it, else the window
 * to wait for, the day when both are spent (the longer wait, as `agentScopeCeiling`). Both counters in one `Promise.all`.
 */
export async function agentScopeGenRefusal(u: Pick<User, "scope" | "email">): Promise<"hour" | "day" | null> {
  const s = agentScopeOf(u);
  const [hour, day] = await Promise.all([allow(`agent-scope-gen:h:${s}`, AGENT_SCOPE_GEN_CHECKS_PER_HOUR, WINDOW.hour), allow(`agent-scope-gen:d:${s}`, AGENT_SCOPE_GEN_CHECKS_PER_DAY, WINDOW.day)]);
  return !day ? "day" : !hour ? "hour" : null;
}

/**
 * The public OAuth endpoints, per IP. Hosted MCP clients (claude.ai, ChatGPT) register and exchange tokens from shared
 * egress addresses on behalf of many accounts, and a token pair lives 30 days, so real traffic stays far below these.
 * Registration is the tighter one: it is open (RFC 7591) and every client is stored with no expiry.
 */
export const OAUTH_TOKEN_PER_IP = 60, OAUTH_TOKEN_WINDOW = 900;
export const OAUTH_REGISTER_PER_IP = 30, OAUTH_REGISTER_WINDOW = 3600;

/**
 * Impersonation stops per client address (POST /api/admin/impersonate, public because the impersonated session is a
 * customer's). Far above any founder's use, low enough that a script cannot churn the store. Rule 542.
 */
export const IMPERSONATE_STOP_PER_IP = 30, IMPERSONATE_STOP_WINDOW = 900;

/**
 * Governance restores per account (`POST /api/governance/rollback`). Each one rewrites every setting and adds a history
 * record, so a script must not be able to churn them; an owner undoing a few changes stays far below this.
 */
export const GOV_ROLLBACKS_PER_HOUR = 20;

/**
 * The owner's activity log, per account: pages and filters (`GET /api/activity`) and CSV downloads
 * (`GET /api/activity/export`). Every read loads the brand's whole capped log (CAPS.activity rows), so a script paging
 * in a loop is bounded here; an owner filtering and pressing "Load more" stays far below it.
 */
export const ACTIVITY_READS_PER_HOUR = 300;
export const ACTIVITY_EXPORTS_PER_HOUR = 10;

/**
 * Majed's handoffs, per account (src/lib/handoffs.ts). Reads: the chat's handoff cards fetch their record on show and
 * after every action. Runs: each is a paid batch (the credits and the agent caps bound it too), and a run holds the
 * handoff's lock for its whole length, so a script cannot stack them; "Run all" on a three-item card is three. Declines
 * write the record and a log row, so they are bounded like any other write.
 */
export const HANDOFF_READS_PER_HOUR = 600;
export const HANDOFF_RUNS_PER_HOUR = 60;
export const HANDOFF_DECLINES_PER_HOUR = 120;

/**
 * Run and Dismiss on the chat's spend cards, per workspace (`POST /api/chat/spend/[id]`, rule 1512). A run is a paid batch
 * or render, bounded too by the credits and the agent caps; a chat reply carries at most two cards, so an owner stays far
 * below this. Same ceiling as Majed's handoff runs.
 */
export const SPEND_RUNS_PER_HOUR = 60;

/**
 * Thumbs on agent replies, per account (`POST /api/chat/feedback`). Each one is a write to the brand's capped feedback
 * log, which the agents' prompts read back, so a script must not churn it; an owner rating replies stays far below this
 * (chat itself is at most `chatCaps(u).hour` turns, 30 on a paid plan).
 */
export const FEEDBACK_PER_HOUR = 120;

/**
 * Model picks per account (`PUT /api/models`): a conversation's or a brand's model, cleared or set, and the owner's
 * China-hosting confirmation. Each one is a write to a record every chat turn or batch reads back, so a script must not
 * churn them; an owner trying a few models stays far below this. One bucket for the account, shared by every seat.
 */
export const MODEL_PICKS_PER_HOUR = 60;

/**
 * Agent instructions (agent skills portal, spec 10), per brand workspace (`sc(u)`): one bucket for every write (save the
 * draft, activate, discard, restore, apply or dismiss a proposal), because each one rewrites a record every agent prompt
 * reads back. Tests spend the account's credits (hour and day); proposals are the chat's, per day; imports are the
 * owner's file attachments. The admin test is the founder's, per hour. Every 429 carries `Retry-After`.
 */
export const INSTRUCTION_WRITES_PER_HOUR = 60;
export const INSTRUCTION_TESTS_PER_HOUR = 10;
export const INSTRUCTION_TESTS_PER_DAY = 30;
export const INSTRUCTION_PROPOSALS_PER_DAY = 20;
export const INSTRUCTION_IMPORTS_PER_HOUR = 30;
/** Memory cards an agent may propose in one workspace a day (rule 4553, src/lib/memory.ts). */
export const MEMORY_PROPOSALS_PER_DAY = 30;
export const ADMIN_SKILL_TESTS_PER_HOUR = 30;

/** Constant-time string comparison for secrets. It lives in secret.ts, which has no store behind it, so the proxy can use
 * it; this re-export keeps every existing import working. */
export { sameSecret } from "./secret";

/**
 * Integration requests and votes, per login (`POST /api/integrations`). Each one is a row in the capped request log
 * the founder reads, so a script must not be able to flood it and push the real requests out; a person asking for a
 * few connectors stays far below this. Rule 1353.
 */
export const INTEGRATION_REQUESTS_PER_HOUR = 30;

/**
 * The ops agent's routes (rules 2380-2389, src/lib/ops.ts). Per IP before the token is checked, so a guesser is slowed
 * whatever it sends; then one bucket for the whole relay (one founder, one agent): about nine runs a day send a message
 * or two each, so the ceilings sit far above normal use and far below a flood.
 */
export const OPS_CALLS_PER_IP_PER_MINUTE = 30;
export const OPS_RELAY_PER_HOUR = 30;
export const OPS_PROPOSALS_PER_DAY = 20;
